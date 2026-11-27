import type { Project, Section } from '../model/types.ts';
import * as repo from '../db/repo.ts';
import { write, type Op } from '../db/idb.ts';
import { plainTitle } from '../model/defaults.ts';
import { createSnapshot } from '../storage/snapshots.ts';
import { GitHubStore, isConflict, type SyncConfig } from './github.ts';
import { applyToProject, baseOf, bookHash, mergeBooks, toSyncBook, type SyncBase, type SyncBook } from './merge.ts';
import { isIOS } from '../ui/viewport.ts';

// Keeps every book in step with a private GitHub repository, one file per book
// (books/<id>.json). Each device remembers the version it last agreed with, so
// a sync is a three-way merge: nothing written on either device is lost.
// It runs when the app opens or comes back, every 30 s while open, and when you leave.

export type SyncStatus = 'off' | 'idle' | 'syncing' | 'offline' | 'error';

/** The book open in the editor: read it from (and write it to) the editor's session, not the database. */
export interface LiveBook {
  id: string;
  read(): Promise<{ project: Project; sections: Section[] }>;
  /** Applies a merged book unless the writer typed since `expect` (the hash read); false to retry later. */
  apply(book: SyncBook, expect: string): Promise<boolean>;
}

interface BookState { sha: string; base: SyncBase; hash: string }

const device = () => (isIOS() ? 'iPhone' : /Mac/.test(navigator.platform) ? 'Mac' : 'computer');

class SyncEngine {
  status: SyncStatus = 'off';
  lastSync = 0;
  lastError = '';
  private cfg: SyncConfig | null = null;
  private store: GitHubStore | null = null;
  private live: LiveBook | null = null;
  private running: Promise<void> | null = null;
  private timer = 0;
  private ticks = 0;
  private listeners = new Set<() => void>();
  /** Books changed here by a sync (the library redraws). */
  onBooksChanged: (ids: string[]) => void = () => undefined;

  get configured(): boolean { return !!this.cfg; }
  get repoName(): string { return this.cfg ? `${this.cfg.owner}/${this.cfg.repo}` : ''; }
  private get scope(): string { return `sync:${this.repoName}:`; }

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private set(status: SyncStatus, error = ''): void {
    this.status = status;
    this.lastError = error;
    for (const fn of this.listeners) fn();
  }

  async init(): Promise<void> {
    const cfg = await repo.kvGet<SyncConfig>('sync');
    if (cfg?.token) this.use(cfg);
    document.addEventListener('visibilitychange', () => {
      if (!this.cfg) return;
      // Leaving: send what was just written. Coming back: fetch what the other device wrote.
      void this.now(document.visibilityState === 'hidden' ? 'open' : 'all');
    });
    addEventListener('online', () => { if (this.cfg) void this.now('all'); });
  }

  private use(cfg: SyncConfig): void {
    this.cfg = cfg;
    this.store = new GitHubStore(cfg);
    this.set('idle');
    clearInterval(this.timer);
    this.timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      // The open book every 30 s; the whole library every few minutes.
      void this.now(this.live && ++this.ticks % 6 ? 'open' : 'all');
    }, 30_000);
  }

  /** Checks the repository and token, then starts syncing. Throws with a readable reason. */
  async connect(cfg: SyncConfig): Promise<void> {
    const err = await new GitHubStore(cfg).check();
    if (err) throw new Error(err);
    await repo.kvSet('sync', cfg);
    this.use(cfg);
    await this.now('all');
  }

  /** Stops syncing on this device (its books stay here, and in the repository). */
  async disconnect(): Promise<void> {
    clearInterval(this.timer);
    await repo.kvDel('sync');
    this.cfg = null;
    this.store = null;
    this.set('off');
  }

  setLive(live: LiveBook | null): void {
    this.live = live;
    if (live && this.cfg) void this.now('open');
  }

  /**
   * Call before deleting a book forever: marks it gone, so no sync brings it back, and deletes it from
   * the repository (now, or at the next sync); other devices then move it to Recently Deleted.
   */
  async forget(id: string): Promise<void> {
    if (!this.cfg) return;
    await repo.kvSet(`${this.scope}gone:${id}`, true);
    setTimeout(() => void this.now('all'), 0);
  }
  private gone(id: string): Promise<unknown> { return repo.kvGet(`${this.scope}gone:${id}`); }

  /** Syncs now: the open book, or every book. Concurrent calls share one run. */
  now(what: 'open' | 'all' = 'all'): Promise<void> {
    if (!this.store) return Promise.resolve();
    if (this.running) return this.running.then(() => (what === 'all' ? this.now('all') : undefined));
    this.set('syncing', '');
    this.running = (async () => {
      try {
        if (what === 'open') { if (this.live) await this.syncBook(this.live.id); }
        else await this.syncAll();
        this.lastSync = Date.now();
        this.set('idle');
      } catch (e: any) {
        const offline = e instanceof TypeError || !navigator.onLine; // fetch failed: no connection
        this.set(offline ? 'offline' : 'error', offline ? 'No connection — will sync when back online.' : e?.message || String(e));
        if (!offline) console.error('Sync failed', e);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async syncAll(): Promise<void> {
    const store = this.store!;
    const remote = (await store.list('books')).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5));
    const local = (await repo.listProjects()).map((p) => p.id);
    const changed: string[] = [];
    for (const id of new Set([...remote, ...local])) {
      if (await this.gone(id)) {
        const f = await store.get(this.path(id));
        if (f) await store.del(this.path(id), f.sha, `Delete a book (from ${device()})`);
        await repo.kvDel(`${this.scope}gone:${id}`);
        await repo.kvDel(this.scope + id);
        continue;
      }
      if (await this.syncBook(id)) changed.push(id);
    }
    if (changed.length) this.onBooksChanged(changed);
  }

  private path(id: string): string { return `books/${id}.json`; }

  /** Syncs one book. Returns true if this device's copy changed. */
  private async syncBook(id: string, retry = true): Promise<boolean> {
    const store = this.store!;
    const key = this.scope + id;
    const state = await repo.kvGet<BookState>(key);
    const live = this.live?.id === id ? this.live : null;
    const here = live ? await live.read() : await this.readLocal(id);
    const local = here && toSyncBook(here.project, here.sections);
    const localHash = local && bookHash(local);
    const file = await store.get(this.path(id));
    const save = (sha: string, b: SyncBook) => repo.kvSet(key, { sha, base: baseOf(b), hash: bookHash(b) } satisfies BookState);
    const message = (b: SyncBook) => `${plainTitle(b.project.meta)} (from ${device()})`;

    if (!file) {
      if (!local) return false;
      if (state) {
        // It was in the repository and is gone: deleted forever on another device. Here it goes to Recently Deleted.
        await repo.kvDel(key);
        if (!live && !here!.project.deletedAt) { here!.project.deletedAt = Date.now(); await repo.saveProject(here!.project); return true; }
        return false;
      }
      if (here!.project.deletedAt) return false; // in Recently Deleted: not sent as a new book (restoring it sends it)
      await save(await store.put(this.path(id), JSON.stringify(local), undefined, message(local)), local);
      return false;
    }
    if (local && state && state.sha === file.sha) {
      // Nothing new from elsewhere: send this device's changes, if any.
      if (localHash !== state.hash) await save(await store.put(this.path(id), JSON.stringify(local), file.sha, message(local)), local);
      return false;
    }
    const remote = JSON.parse(file.text) as SyncBook;
    if (remote?.format !== 'serifwriter-sync') return false;
    if (!local) {
      if (await this.gone(id)) return false; // being deleted here: never bring it back
      await this.writeLocal(id, null, remote);
      await save(file.sha, remote);
      return true;
    }
    const { book: merged } = mergeBooks(local, remote, state?.base ?? null);
    const mergedHash = bookHash(merged);
    let changedHere = false;
    if (mergedHash !== localHash) {
      if (live) { if (!(await live.apply(merged, localHash!))) return false; } // typed meanwhile: next time
      else if (await this.gone(id)) return false;
      else await this.writeLocal(id, here, merged);
      changedHere = true;
    }
    let sha = file.sha;
    if (mergedHash !== bookHash(remote)) {
      try { sha = await store.put(this.path(id), JSON.stringify(merged), file.sha, message(merged)); }
      catch (e) { if (isConflict(e) && retry) return (await this.syncBook(id, false)) || changedHere; throw e; }
    }
    await save(sha, merged);
    return changedHere;
  }

  private async readLocal(id: string): Promise<{ project: Project; sections: Section[] } | null> {
    const project = await repo.getProject(id);
    return project ? { project, sections: await repo.getSections(project) } : null;
  }

  private async writeLocal(id: string, here: { project: Project; sections: Section[] } | null, b: SyncBook): Promise<void> {
    if (here) {
      const replaced = b.sections.some((r) => here.sections.some((s) => s.id === r.id && s.content !== r.content)) || here.sections.some((s) => !b.sections.some((r) => r.id === s.id));
      if (replaced) await createSnapshot(here.project, here.sections, { auto: false, label: 'Before syncing', reason: 'Before syncing' }).catch(() => undefined);
    }
    const now = Date.now();
    const shell: Project = here?.project ?? { id, createdAt: now, updatedAt: now, openedAt: 0, deletedAt: null, meta: b.project.meta, order: [], templateId: 'classic', overrides: {}, customCss: '', lastSectionId: null, words: 0, ui: {} };
    const r = await applyToProject(shell, here?.sections ?? [], b);
    const ops: Op[] = [
      ...r.sections.filter((s) => r.changed.includes(s.id)).map((s) => ({ store: 'sections' as const, put: s })),
      ...r.removed.map((sid) => ({ store: 'sections' as const, del: sid })),
      { store: 'projects', put: r.project },
    ];
    await write(ops);
  }
}

export const sync = new SyncEngine();
