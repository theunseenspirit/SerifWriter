import { get, getAll, getAllByIndex, getAllKeysByIndex, write, put, del, type Op } from './idb.ts';
import type { Asset, Project, Section, SnapshotMeta, TemplateDef } from '../model/types.ts';
import { uid } from '../util.ts';
import { countWords } from '../model/words.ts';

// ───────── key/value app state ─────────
export const kvGet = <T>(key: string) => get<T>('kv', key);
export const kvSet = (key: string, value: unknown) => put('kv', value, key);
export const kvDel = (key: string) => del('kv', key);

// ───────── projects ─────────
export const listProjects = () => getAll<Project>('projects');
export const getProject = (id: string) => get<Project>('projects', id);
export const saveProject = (p: Project) => put('projects', p);

export const getSection = (id: string) => get<Section>('sections', id);

export async function getSections(project: Project): Promise<Section[]> {
  const all = await getAllByIndex<Section>('sections', 'projectId', project.id);
  const byId = new Map(all.map((s) => [s.id, s]));
  const ordered = project.order.map((id) => byId.get(id)).filter(Boolean) as Section[];
  // Sections that exist but fell out of the order (shouldn't happen) are appended, never lost.
  for (const s of all) if (!project.order.includes(s.id)) ordered.push(s);
  return ordered;
}

export async function createProject(project: Project, sections: Section[]): Promise<void> {
  project.words = sections.reduce((n, s) => n + s.words, 0);
  await write([{ store: 'projects', put: project }, ...sections.map((s) => ({ store: 'sections' as const, put: s }))]);
}

/** Saves sections and the project in one atomic transaction. */
export async function saveSections(project: Project, sections: Section[], allSectionWords?: number): Promise<void> {
  if (allSectionWords !== undefined) project.words = allSectionWords;
  await write([...sections.map((s) => ({ store: 'sections' as const, put: s })), { store: 'projects', put: project }]);
}

export async function deleteSection(project: Project, sectionId: string): Promise<void> {
  project.order = project.order.filter((id) => id !== sectionId);
  await write([{ store: 'sections', del: sectionId }, { store: 'projects', put: project }]);
}

export async function duplicateProject(src: Project, newTitle: string): Promise<Project> {
  const sections = await getSections(src);
  const now = Date.now();
  const id = uid('p');
  const map = new Map<string, string>();
  const copies = sections.map((s) => {
    const n = { ...s, id: uid('s'), projectId: id, createdAt: now, updatedAt: now };
    map.set(s.id, n.id);
    return n;
  });
  const assets = await getAllByIndex<Asset>('assets', 'projectId', src.id);
  const p: Project = {
    ...structuredClone(src), id, createdAt: now, updatedAt: now, openedAt: now, deletedAt: null,
    meta: { ...structuredClone(src.meta), title: newTitle },
    order: src.order.map((sid) => map.get(sid)!).filter(Boolean),
    lastSectionId: src.lastSectionId ? map.get(src.lastSectionId) ?? null : null,
    mirror: undefined,
  };
  // Keep the title page's front matter in step with the new title.
  const { titleContentFromMeta } = await import('../model/defaults.ts');
  for (const s of copies) if (s.kind === 'title') { s.content = titleContentFromMeta(p.meta, s.content); s.words = countWords(s.content); }
  await write([
    { store: 'projects', put: p },
    ...copies.map((s) => ({ store: 'sections' as const, put: s })),
    ...assets.map((a) => ({ store: 'assets' as const, put: { ...a, projectId: id } as Asset })),
  ]);
  return p;
}

/** Permanently removes a project with its sections, history and images. */
export async function purgeProject(id: string): Promise<void> {
  const [sections, snaps, assets] = await Promise.all([
    getAllKeysByIndex('sections', 'projectId', id),
    getAllKeysByIndex('snapshots', 'projectId', id),
    getAllKeysByIndex('assets', 'projectId', id),
  ]);
  const ops: Op[] = [{ store: 'projects', del: id }];
  for (const k of sections) ops.push({ store: 'sections', del: k });
  for (const k of snaps) ops.push({ store: 'snapshots', del: k }, { store: 'snapshotData', del: k });
  for (const k of assets) ops.push({ store: 'assets', del: k });
  await write(ops);
}

// ───────── snapshots ─────────
export const listSnapshots = (projectId: string) => getAllByIndex<SnapshotMeta>('snapshots', 'projectId', projectId);
export const getSnapshotData = (id: string) => get<{ id: string; data: Blob | string }>('snapshotData', id);

export async function addSnapshot(meta: SnapshotMeta, data: Blob | string): Promise<void> {
  await write([{ store: 'snapshots', put: meta }, { store: 'snapshotData', put: { id: meta.id, data } }]);
}
export async function updateSnapshotMeta(meta: SnapshotMeta): Promise<void> {
  await put('snapshots', meta);
}
export async function deleteSnapshots(ids: string[]): Promise<void> {
  await write(ids.flatMap((id) => [{ store: 'snapshots' as const, del: id }, { store: 'snapshotData' as const, del: id }]));
}

// ───────── templates ─────────
export const listCustomTemplates = () => getAll<TemplateDef>('templates');
export const saveCustomTemplate = (t: TemplateDef) => put('templates', t);
export const deleteCustomTemplate = (id: string) => del('templates', id);

// ───────── assets ─────────
export const getAsset = (id: string) => get<Asset>('assets', id);
export const listAssets = (projectId: string) => getAllByIndex<Asset>('assets', 'projectId', projectId);
export const saveAsset = (a: Asset) => put('assets', a);
