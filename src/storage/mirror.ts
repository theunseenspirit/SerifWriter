import type { Project, Section } from '../model/types.ts';
import * as repo from '../db/repo.ts';
import { projectToFiles, projectFromFiles, type ProjectFile } from './serialize.ts';
import { plainTitle } from '../model/defaults.ts';
import { safeFilename } from '../util.ts';

// Mirrors every book to a real folder on disk as plain .md files using the
// File System Access API (Chrome, Edge, Opera; not Safari or Firefox).
//   <chosen folder>/<Book Title>/01 Title Page.md, 02 Copyright.md, …, project.json, images/

type Dir = FileSystemDirectoryHandle & {
  queryPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>;
  entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
};

export const mirrorSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export type MirrorStatus = 'unsupported' | 'off' | 'ok' | 'needs-permission' | 'error';

async function writeText(dir: FileSystemDirectoryHandle, name: string, data: string | Blob): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await (fh as any).createWritable();
  await w.write(data);
  await w.close();
}

async function readText(dir: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  try { return await (await (await dir.getFileHandle(name)).getFile()).text(); } catch { return null; }
}

const extFor = (type: string) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif' } as Record<string, string>)[type] || 'bin';

class FolderMirror {
  root: Dir | null = null;
  status: MirrorStatus = mirrorSupported ? 'off' : 'unsupported';
  lastWrite = 0;
  lastError = '';
  private timers = new Map<string, number>();
  private pending = new Map<string, { project: Project; sections: Section[] }>();
  private listeners = new Set<() => void>();

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(): void { for (const l of this.listeners) l(); }

  get folderName(): string { return this.root?.name || ''; }

  async init(): Promise<void> {
    if (!mirrorSupported) return;
    const h = await repo.kvGet<Dir>('mirrorRoot');
    if (!h) { this.status = 'off'; this.emit(); return; }
    this.root = h;
    try {
      const p = h.queryPermission ? await h.queryPermission({ mode: 'readwrite' }) : 'granted';
      this.status = p === 'granted' ? 'ok' : 'needs-permission';
    } catch { this.status = 'needs-permission'; }
    this.emit();
  }

  /** Asks the user to pick the folder. Must be called from a click. */
  async choose(): Promise<boolean> {
    try {
      const h = (await (window as any).showDirectoryPicker({ id: 'serifwriter', mode: 'readwrite', startIn: 'documents' })) as Dir;
      this.root = h;
      await repo.kvSet('mirrorRoot', h);
      this.status = 'ok';
      this.emit();
      return true;
    } catch (e: any) {
      if (e?.name !== 'AbortError') { this.lastError = e?.message || String(e); this.status = 'error'; this.emit(); }
      return false;
    }
  }

  /** Re-grants access after a browser restart. Must be called from a click. */
  async reconnect(): Promise<boolean> {
    if (!this.root?.requestPermission) return false;
    try {
      const p = await this.root.requestPermission({ mode: 'readwrite' });
      this.status = p === 'granted' ? 'ok' : 'needs-permission';
    } catch { this.status = 'needs-permission'; }
    this.emit();
    return this.status === 'ok';
  }

  async disconnect(): Promise<void> {
    this.root = null;
    this.status = mirrorSupported ? 'off' : 'unsupported';
    await repo.kvDel('mirrorRoot');
    this.emit();
  }

  /** Debounced write of one project. */
  schedule(project: Project, sections: Section[], delay = 1500): void {
    if (this.status !== 'ok') return;
    this.pending.set(project.id, { project, sections });
    clearTimeout(this.timers.get(project.id));
    this.timers.set(project.id, window.setTimeout(() => void this.flush(project.id), delay));
  }

  async flush(projectId?: string): Promise<void> {
    const ids = projectId ? [projectId] : [...this.pending.keys()];
    for (const id of ids) {
      const job = this.pending.get(id);
      if (!job) continue;
      this.pending.delete(id);
      clearTimeout(this.timers.get(id));
      await this.writeProject(job.project, job.sections);
    }
  }

  private async folderFor(project: Project): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
    const root = this.root!;
    const wanted = safeFilename(plainTitle(project.meta), 'Untitled Book');
    const current = project.mirror?.folder;
    // Keep the folder while the title is unchanged (it may carry a " (2)" suffix).
    if (current && (current === wanted || current.startsWith(`${wanted} (`))) return { dir: await root.getDirectoryHandle(current, { create: true }), name: current };
    // Find a free name (another book may already use this title).
    let name = wanted;
    for (let i = 2; i < 50; i++) {
      try {
        const existing = await root.getDirectoryHandle(name);
        const json = await readText(existing, 'project.json');
        if (!json || JSON.parse(json).id === project.id) break;
        name = `${wanted} (${i})`;
      } catch { break; }
    }
    return { dir: await root.getDirectoryHandle(name, { create: true }), name };
  }

  async writeProject(project: Project, sections: Section[]): Promise<void> {
    if (!this.root || this.status !== 'ok') return;
    try {
      const oldFolder = project.mirror?.folder;
      const { dir, name } = await this.folderFor(project);
      const { json, files } = projectToFiles(project, sections);
      const oldFiles = new Set(Object.values(project.mirror?.files || {}));
      const sameFolder = oldFolder === name;
      const prevText = new Map<string, string>();
      for (const f of files) {
        // Only rewrite files whose text changed (cheap check against what is on disk).
        if (sameFolder) {
          const cur = await readText(dir, f.name);
          if (cur === f.text) { prevText.set(f.name, cur); continue; }
        }
        await writeText(dir, f.name, f.text);
      }
      const assets = await repo.listAssets(project.id);
      if (assets.length) {
        const img = await dir.getDirectoryHandle('images', { create: true });
        for (const a of assets) {
          const fname = `${a.id}.${extFor(a.type)}`;
          try { await img.getFileHandle(fname); } catch { await writeText(img, fname, a.blob); }
        }
      }
      await writeText(dir, 'project.json', JSON.stringify(json, null, 2));
      // Remove files we wrote before that are no longer part of the book.
      const now = new Set(files.map((f) => f.name));
      if (sameFolder) for (const f of oldFiles) if (!now.has(f)) { try { await dir.removeEntry(f); } catch { /* already gone */ } }
      project.mirror = { folder: name, files: Object.fromEntries(files.map((f) => [f.id, f.name])) };
      await repo.saveProject(project);
      // The title changed: the old folder is replaced by the new one.
      if (oldFolder && oldFolder !== name) await this.removeFolder(oldFolder, project.id);
      this.lastWrite = Date.now();
      this.lastError = '';
      this.emit();
    } catch (e: any) {
      console.error('Mirror write failed', e);
      this.lastError = e?.message || String(e);
      if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') this.status = 'needs-permission';
      this.emit();
    }
  }

  async removeFolder(folder: string, projectId: string): Promise<void> {
    if (!this.root) return;
    try {
      const dir = await this.root.getDirectoryHandle(folder);
      const json = await readText(dir, 'project.json');
      if (json && JSON.parse(json).id === projectId) await this.root.removeEntry(folder, { recursive: true });
    } catch { /* nothing to remove */ }
  }

  /** Writes every (non-deleted) book. */
  async writeAll(): Promise<void> {
    for (const p of await repo.listProjects()) {
      if (p.deletedAt) continue;
      await this.writeProject(p, await repo.getSections(p));
    }
  }
}

export const mirror = new FolderMirror();

/** Lets the user pick a book folder (a mirror folder or any folder of .md files) and reads it. */
export async function readProjectFolder(): Promise<{ project: Project; sections: Section[]; images: Map<string, File> } | null> {
  let dir: Dir;
  try {
    dir = (await (window as any).showDirectoryPicker({ id: 'serifwriter-import', mode: 'read' })) as Dir;
  } catch { return null; }
  const files = new Map<string, string>();
  const images = new Map<string, File>();
  let json: ProjectFile | null = null;
  for await (const [name, handle] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (handle.kind === 'file' && /\.(md|markdown|txt)$/i.test(name)) files.set(name, await (await (handle as FileSystemFileHandle).getFile()).text());
    else if (handle.kind === 'file' && name === 'project.json') {
      try { json = JSON.parse(await (await (handle as FileSystemFileHandle).getFile()).text()); } catch { json = null; }
    } else if (handle.kind === 'directory' && name === 'images') {
      for await (const [iname, ih] of (handle as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
        if (ih.kind === 'file') images.set(iname, await (ih as FileSystemFileHandle).getFile());
      }
    }
  }
  if (!files.size) throw new Error('That folder has no Markdown (.md) files.');
  const { project, sections } = projectFromFiles(json && (json as ProjectFile).format === 'serifwriter-project' ? json : null, files, dir.name);
  return { project, sections, images };
}
