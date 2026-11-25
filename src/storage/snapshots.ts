import type { Project, Section, SnapshotMeta, SnapshotPayload } from '../model/types.ts';
import * as repo from '../db/repo.ts';
import { hashString, uid } from '../util.ts';

// Version history. Each snapshot is a full copy of the project, gzipped with
// the browser's native CompressionStream (no main-thread cost). Automatic
// snapshots are thinned: all for 24 h, then hourly for 7 days, daily for 90
// days, weekly after. Named versions are kept forever.

const HOUR = 3600_000;
const DAY = 24 * HOUR;
export const AUTO_INTERVAL = 10 * 60_000;

async function gzip(text: string): Promise<Blob | string> {
  if (typeof CompressionStream === 'undefined') return text;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

async function gunzip(data: Blob | string): Promise<string> {
  if (typeof data === 'string') return data;
  const stream = data.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export function contentHash(project: Project, sections: Section[]): string {
  return hashString(JSON.stringify([project.meta, project.templateId, project.overrides, project.customCss, sections.map((s) => [s.id, s.kind, s.title, s.content])]));
}

export async function createSnapshot(project: Project, sections: Section[], opts: { label?: string; auto: boolean; reason?: string }): Promise<SnapshotMeta | null> {
  const hash = contentHash(project, sections);
  const existing = await repo.listSnapshots(project.id);
  existing.sort((a, b) => b.createdAt - a.createdAt);
  if (opts.auto && existing[0]?.hash === hash) return null;
  const payload: SnapshotPayload = { project: structuredClone(project), sections: structuredClone(sections) };
  const json = JSON.stringify(payload);
  const data = await gzip(json);
  const meta: SnapshotMeta = {
    id: uid('v'), projectId: project.id, createdAt: Date.now(), label: opts.label || '', auto: opts.auto, reason: opts.reason,
    words: sections.reduce((n, s) => n + (s.kind === 'title' || s.kind === 'toc' ? 0 : s.words), 0), hash,
    size: typeof data === 'string' ? data.length : data.size,
  };
  await repo.addSnapshot(meta, data);
  if (opts.auto) await thin(project.id);
  return meta;
}

export async function loadSnapshot(id: string): Promise<SnapshotPayload> {
  const rec = await repo.getSnapshotData(id);
  if (!rec) throw new Error('This version could not be found.');
  return JSON.parse(await gunzip(rec.data));
}

export async function listSnapshots(projectId: string): Promise<SnapshotMeta[]> {
  const list = await repo.listSnapshots(projectId);
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

/** Which automatic snapshots to drop (pure; exported for tests). */
export function thinningPlan(list: SnapshotMeta[], now = Date.now()): string[] {
  const auto = list.filter((s) => s.auto).sort((a, b) => b.createdAt - a.createdAt);
  const seen = new Set<string>();
  const drop: string[] = [];
  for (const s of auto) {
    const age = now - s.createdAt;
    let bucket: string | null = null;
    if (age < DAY) bucket = null;
    else if (age < 7 * DAY) bucket = 'h' + Math.floor(s.createdAt / HOUR);
    else if (age < 90 * DAY) bucket = 'd' + Math.floor(s.createdAt / DAY);
    else bucket = 'w' + Math.floor(s.createdAt / (7 * DAY));
    if (bucket === null) continue;
    if (seen.has(bucket)) drop.push(s.id);
    else seen.add(bucket);
  }
  return drop;
}

async function thin(projectId: string): Promise<void> {
  const drop = thinningPlan(await repo.listSnapshots(projectId));
  if (drop.length) await repo.deleteSnapshots(drop);
}

/** Decides whether an automatic snapshot is due after a save. */
export class SnapshotScheduler {
  private last = 0;
  private busy = false;
  private getState: () => { project: Project; sections: Section[] };
  constructor(getState: () => { project: Project; sections: Section[] }) { this.getState = getState; }
  async init(projectId: string): Promise<void> {
    const list = await listSnapshots(projectId);
    this.last = list[0]?.createdAt || 0;
  }
  async maybe(force = false, reason = 'Autosave'): Promise<void> {
    if (this.busy) return;
    if (!force && Date.now() - this.last < AUTO_INTERVAL) return;
    this.busy = true;
    try {
      const { project, sections } = this.getState();
      const s = await createSnapshot(project, sections, { auto: true, reason });
      if (s || force) this.last = Date.now();
    } catch (e) {
      console.warn('Snapshot failed', e);
    } finally {
      this.busy = false;
    }
  }
}
