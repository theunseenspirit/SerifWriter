import type { Asset, Project, Section, SnapshotMeta, TemplateDef } from '../model/types.ts';
import * as repo from '../db/repo.ts';
import { projectToFiles, projectFromFiles, type ProjectFile } from './serialize.ts';
import { loadSnapshot, listSnapshots } from './snapshots.ts';
import { plainTitle } from '../model/defaults.ts';
import { safeFilename, todayKey, uid } from '../util.ts';

// One-click backup of everything as a .zip of plain Markdown + JSON, and restore.

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface BackupManifest {
  format: 'serifwriter-backup';
  version: 1;
  exportedAt: number;
  projects: { id: string; folder: string; title: string; deleted: boolean }[];
  templates: TemplateDef[];
  includesHistory: boolean;
}

const ext = (type: string) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif' } as Record<string, string>)[type] || 'bin';

export async function exportBackup(opts: { includeHistory: boolean; includeDeleted?: boolean; projectIds?: string[] }): Promise<Blob> {
  const { zip } = await import('fflate');
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
  const projects = (await repo.listProjects()).filter((p) => (opts.includeDeleted || !p.deletedAt) && (!opts.projectIds || opts.projectIds.includes(p.id)));
  const used = new Set<string>();
  const manifest: BackupManifest = { format: 'serifwriter-backup', version: 1, exportedAt: Date.now(), projects: [], templates: await repo.listCustomTemplates(), includesHistory: opts.includeHistory };
  for (const p of projects) {
    let folder = safeFilename(plainTitle(p.meta), 'Untitled Book');
    for (let i = 2; used.has(folder); i++) folder = `${safeFilename(plainTitle(p.meta))} (${i})`;
    used.add(folder);
    const sections = await repo.getSections(p);
    const { json, files: mdFiles } = projectToFiles(p, sections);
    const base = `projects/${folder}/`;
    files[base + 'project.json'] = enc.encode(JSON.stringify({ ...json, deletedAt: p.deletedAt, ui: p.ui }, null, 2));
    for (const f of mdFiles) files[base + f.name] = enc.encode(f.text);
    for (const a of await repo.listAssets(p.id)) files[`${base}images/${a.id}.${ext(a.type)}`] = [new Uint8Array(await a.blob.arrayBuffer()), { level: 0 }];
    if (opts.includeHistory) {
      for (const s of await listSnapshots(p.id)) {
        try {
          const payload = await loadSnapshot(s.id);
          files[`${base}history/${s.id}.json`] = enc.encode(JSON.stringify({ meta: s, payload }));
        } catch { /* skip unreadable snapshot */ }
      }
    }
    manifest.projects.push({ id: p.id, folder, title: plainTitle(p.meta), deleted: !!p.deletedAt });
  }
  files['serifwriter-backup.json'] = enc.encode(JSON.stringify(manifest, null, 2));
  files['README.txt'] = enc.encode(
    'SerifWriter backup\n\nEach book is a folder of plain Markdown files (one per chapter) with project.json holding the order and design settings.\nRestore it from the SerifWriter library with "Import", or open the .md files in any editor.\n',
  );
  const data = await new Promise<Uint8Array>((resolve, reject) => zip(files as any, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out))));
  return new Blob([data as BlobPart], { type: 'application/zip' });
}

export const backupFilename = () => `SerifWriter Backup ${todayKey()}.zip`;

export interface ImportPlan {
  manifest: BackupManifest | null;
  books: { project: Project; sections: Section[]; assets: Asset[]; history: { meta: SnapshotMeta; payload: any }[]; exists: boolean; deleted: boolean }[];
  templates: TemplateDef[];
}

export async function readBackup(file: Blob): Promise<ImportPlan> {
  const { unzip } = await import('fflate');
  const buf = new Uint8Array(await file.arrayBuffer());
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => unzip(buf, (err, out) => (err ? reject(err) : resolve(out))));
  const text = (name: string) => (entries[name] ? dec.decode(entries[name]) : null);
  const manifestText = text('serifwriter-backup.json');
  const manifest: BackupManifest | null = manifestText ? JSON.parse(manifestText) : null;
  // Group entries by book folder: projects/<folder>/...  (or any folder holding .md files)
  const folders = new Map<string, Map<string, string>>();
  const imageFiles = new Map<string, Map<string, Uint8Array>>();
  const historyFiles = new Map<string, string[]>();
  for (const [path, data] of Object.entries(entries)) {
    if (path.endsWith('/')) continue;
    const m = /^(?:projects\/)?(.+)\/([^/]+)$/.exec(path);
    if (!m) continue;
    let [, folder, name] = m;
    if (folder.endsWith('/images')) {
      folder = folder.slice(0, -7);
      if (!imageFiles.has(folder)) imageFiles.set(folder, new Map());
      imageFiles.get(folder)!.set(name, data);
      continue;
    }
    if (folder.endsWith('/history')) {
      folder = folder.slice(0, -8);
      if (!historyFiles.has(folder)) historyFiles.set(folder, []);
      historyFiles.get(folder)!.push(dec.decode(data));
      continue;
    }
    if (folder.includes('/')) continue;
    if (!folders.has(folder)) folders.set(folder, new Map());
    if (/\.(md|markdown|txt|json)$/i.test(name)) folders.get(folder)!.set(name, dec.decode(data));
  }
  const existing = new Set((await repo.listProjects()).map((p) => p.id));
  const books: ImportPlan['books'] = [];
  for (const [folder, files] of folders) {
    const jsonText = files.get('project.json');
    files.delete('project.json');
    files.delete('README.txt');
    if (![...files.keys()].some((n) => /\.(md|markdown|txt)$/i.test(n))) continue;
    let json: (ProjectFile & { deletedAt?: number | null; ui?: any }) | null = null;
    try { json = jsonText ? JSON.parse(jsonText) : null; } catch { json = null; }
    const { project, sections } = projectFromFiles(json?.format === 'serifwriter-project' ? json : null, files, folder);
    if (json?.ui) project.ui = json.ui;
    const assets: Asset[] = [];
    for (const [name, data] of imageFiles.get(folder) || []) {
      const id = name.replace(/\.[^.]+$/, '');
      const type = /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.gif$/i.test(name) ? 'image/gif' : /\.webp$/i.test(name) ? 'image/webp' : /\.svg$/i.test(name) ? 'image/svg+xml' : 'application/octet-stream';
      assets.push({ id, projectId: project.id, name, type, blob: new Blob([data as BlobPart], { type }), createdAt: Date.now() });
    }
    const history = (historyFiles.get(folder) || []).map((t) => { try { return JSON.parse(t); } catch { return null; } }).filter(Boolean);
    books.push({ project, sections, assets, history, exists: existing.has(project.id), deleted: !!json?.deletedAt });
  }
  return { manifest, books, templates: manifest?.templates || [] };
}

/** Writes an import plan. `mode`: replace books with the same id, or keep both. */
export async function applyImport(plan: ImportPlan, mode: 'replace' | 'copy'): Promise<number> {
  const { write } = await import('../db/idb.ts');
  let n = 0;
  for (const b of plan.books) {
    let { project, sections, assets } = b;
    if (b.exists && mode === 'copy') {
      const newId = uid('p');
      const map = new Map<string, string>();
      sections = sections.map((s) => { const id = uid('s'); map.set(s.id, id); return { ...s, id, projectId: newId }; });
      project = { ...project, id: newId, order: project.order.map((id) => map.get(id)!).filter(Boolean), lastSectionId: project.lastSectionId ? map.get(project.lastSectionId) ?? null : null, mirror: undefined, meta: { ...project.meta } };
      assets = assets.map((a) => ({ ...a, projectId: newId }));
    } else if (b.exists) {
      await repo.purgeProject(project.id);
    }
    project.deletedAt = b.deleted ? Date.now() : null;
    await repo.createProject(project, sections);
    if (assets.length) await write(assets.map((a) => ({ store: 'assets' as const, put: a })));
    // History is only restored onto the original book: its section ids belong to it.
    const copy = b.exists && mode === 'copy';
    for (const h of copy ? [] : b.history) {
      if (!h?.meta || !h?.payload) continue;
      const meta = { ...h.meta, projectId: project.id };
      await repo.addSnapshot(meta, JSON.stringify(h.payload));
    }
    n++;
  }
  for (const t of plan.templates) await repo.saveCustomTemplate(t);
  return n;
}
