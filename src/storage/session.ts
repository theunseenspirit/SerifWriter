import type { Project, Section, WritingStats } from '../model/types.ts';
import * as repo from '../db/repo.ts';
import { countWords } from '../model/words.ts';
import { metaFromTitleContent, titleContentFromMeta } from '../model/defaults.ts';
import { todayKey } from '../util.ts';
import { emptyStats } from '../model/stats.ts';

// The open project. Holds sections in memory, writes changes to IndexedDB
// (atomically) and keeps a synchronous localStorage journal so text typed
// just before the tab closes is never lost.

const JOURNAL_KEY = 'serifwriter.journal.v1';

interface JournalEntry { projectId: string; content: string; at: number }
type Journal = Record<string, JournalEntry>;

function readJournal(): Journal {
  try { return JSON.parse(localStorage.getItem(JOURNAL_KEY) || '{}') || {}; } catch { return {}; }
}
function writeJournal(j: Journal): void {
  try {
    if (Object.keys(j).length) localStorage.setItem(JOURNAL_KEY, JSON.stringify(j));
    else localStorage.removeItem(JOURNAL_KEY);
  } catch { /* storage full or blocked: IndexedDB is still the primary store */ }
}

/** Replays any journal entries newer than what IndexedDB holds. Returns how many were recovered. */
export async function recoverJournal(): Promise<number> {
  const j = readJournal();
  let recovered = 0;
  for (const [id, e] of Object.entries(j)) {
    const sec = await repo.getSection(id);
    const project = await repo.getProject(e.projectId);
    if (sec && project && e.at > sec.updatedAt && e.content !== sec.content) {
      sec.content = e.content;
      sec.updatedAt = e.at;
      sec.words = countWords(e.content);
      project.updatedAt = Math.max(project.updatedAt, e.at);
      if (sec.kind === 'title') project.meta = metaFromTitleContent(sec.content, project.meta);
      await repo.saveSections(project, [sec]);
      recovered++;
    }
  }
  writeJournal({});
  return recovered;
}

export type SaveState = 'saved' | 'pending' | 'saving' | 'error';

export class ProjectSession {
  project: Project;
  sections: Section[];
  byId: Map<string, Section>;
  state: SaveState = 'saved';
  lastError = '';
  private dirty = new Set<string>();
  private touched = new Set<string>(); // cursor/scroll only
  private projectDirty = false;
  private saving: Promise<void> | null = null;
  private again = false;
  private listeners = new Set<(s: SaveState) => void>();
  /** Hooks run after each successful save (snapshots, folder mirror). */
  afterSave: ((changed: string[], projectChanged: boolean) => void)[] = [];
  private lastTotal: number;
  private lastActive = 0;

  constructor(project: Project, sections: Section[]) {
    this.project = project;
    this.sections = sections;
    this.byId = new Map(sections.map((s) => [s.id, s]));
    this.lastTotal = this.totalWords;
  }

  /** Writing habits: net words per day, and active time (pauses under two minutes count). */
  private track(): void {
    const now = Date.now();
    const st: WritingStats = (this.project.stats ??= emptyStats());
    const total = this.totalWords;
    const d = (st.days[todayKey()] ??= { w: 0, m: 0, t: this.lastTotal });
    d.w += total - this.lastTotal;
    d.t = this.lastTotal = total;
    const gap = now - this.lastActive;
    this.lastActive = now;
    if (gap < 120_000) { d.m += gap / 60_000; st.hours[new Date(now).getHours()] += gap / 60_000; }
  }

  onState(fn: (s: SaveState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private setState(s: SaveState): void {
    this.state = s;
    for (const l of this.listeners) l(s);
  }

  get totalWords(): number {
    return this.sections.reduce((n, s) => n + (s.kind === 'title' || s.kind === 'toc' ? 0 : s.words), 0);
  }

  /** Records new text for a section (in memory + journal) and schedules a save. Returns true if changed. */
  setContent(id: string, content: string, cursor?: Section['cursor']): boolean {
    const s = this.byId.get(id);
    if (!s) return false;
    if (cursor) s.cursor = cursor;
    if (s.content === content) { if (cursor) { this.touched.add(id); this.save(); } return false; }
    s.content = content;
    s.updatedAt = Date.now();
    s.words = countWords(content);
    if (s.kind === 'title') this.project.meta = metaFromTitleContent(content, this.project.meta);
    this.track();
    this.dirty.add(id);
    this.journal([id]);
    this.save();
    return true;
  }

  /** Synchronous journal write — safe to call from pagehide. */
  journal(ids: string[] = [...this.dirty]): void {
    if (!ids.length) return;
    const j = readJournal();
    for (const id of ids) {
      const s = this.byId.get(id);
      if (s) j[id] = { projectId: this.project.id, content: s.content, at: s.updatedAt };
    }
    writeJournal(j);
  }

  markSectionDirty(id: string): void { this.dirty.add(id); this.save(); }
  setCursor(id: string, cursor: NonNullable<Section['cursor']>): void {
    const s = this.byId.get(id);
    if (!s) return;
    const c = s.cursor;
    if (c && c.start === cursor.start && c.end === cursor.end && Math.abs(c.scroll - cursor.scroll) < 2) return;
    s.cursor = cursor;
    this.touched.add(id);
    this.save();
  }
  markProjectDirty(): void { this.projectDirty = true; this.save(); }

  save(): Promise<void> {
    if (this.saving) { this.again = true; return this.saving; }
    if (!this.dirty.size && !this.projectDirty && !this.touched.size) return Promise.resolve();
    this.setState('saving');
    this.saving = (async () => {
      do {
        this.again = false;
        const ids = [...this.dirty];
        const touched = [...this.touched].filter((id) => !this.dirty.has(id));
        const projectChanged = this.projectDirty;
        this.dirty.clear();
        this.touched.clear();
        this.projectDirty = false;
        const secs = [...ids, ...touched].map((id) => this.byId.get(id)).filter(Boolean) as Section[];
        if (ids.length) this.project.updatedAt = Date.now();
        try {
          await repo.saveSections(this.project, secs, this.totalWords);
          // Clear journal entries that are now safely stored (unless edited again meanwhile).
          const j = readJournal();
          for (const s of secs) if (j[s.id] && j[s.id].at <= s.updatedAt && j[s.id].content === s.content) delete j[s.id];
          writeJournal(j);
          for (const fn of this.afterSave) { try { fn(ids, projectChanged); } catch (e) { console.error(e); } }
        } catch (e: any) {
          for (const id of ids) this.dirty.add(id);
          if (projectChanged) this.projectDirty = true;
          this.lastError = e?.message || String(e);
          console.error('Save failed', e);
          this.saving = null;
          this.setState('error');
          setTimeout(() => this.save(), 3000);
          return;
        }
      } while (this.again || this.dirty.size || this.touched.size);
      this.saving = null;
      this.setState('saved');
    })();
    return this.saving;
  }

  /** Net words written today (for the sidebar). */
  get wordsToday(): number {
    return this.project.stats?.days[todayKey()]?.w ?? 0;
  }

  async flush(): Promise<void> {
    await this.save();
    if (this.saving) await this.saving;
  }

  // ───────── structural edits ─────────

  addSection(s: Section, index?: number): void {
    this.sections.splice(index ?? this.sections.length, 0, s);
    this.byId.set(s.id, s);
    this.project.order = this.sections.map((x) => x.id);
    this.dirty.add(s.id);
    this.projectDirty = true;
    this.save();
  }

  async removeSection(id: string): Promise<void> {
    await this.flush();
    this.sections = this.sections.filter((s) => s.id !== id);
    this.byId.delete(id);
    await repo.deleteSection(this.project, id);
    this.project.words = this.totalWords;
    this.markProjectDirty();
  }

  reorder(ids: string[]): void {
    const map = this.byId;
    this.sections = ids.map((id) => map.get(id)!).filter(Boolean);
    this.project.order = this.sections.map((s) => s.id);
    this.markProjectDirty();
  }

  /** Updates book metadata and keeps the title page's front matter in step. */
  setMeta(meta: Project['meta']): void {
    this.project.meta = meta;
    const t = this.sections.find((s) => s.kind === 'title');
    if (t) {
      t.content = titleContentFromMeta(meta, t.content);
      t.updatedAt = Date.now();
      this.dirty.add(t.id);
    }
    this.markProjectDirty();
  }
}
