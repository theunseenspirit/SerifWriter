import type { Project, Section, WritingStats } from '../model/types.ts';
import { hashString, uid } from '../util.ts';
import { countWords } from '../model/words.ts';
import { metaFromTitleContent } from '../model/defaults.ts';

// Sync between devices: a book as one JSON document, and a three-way merge of
// two copies against the copy both last agreed on (the base). Text changed on
// one side only is taken from that side; text changed on both is never lost:
// the newer stays in place and the other is kept as a copy beside it.

export interface SyncSection { id: string; kind: Section['kind']; title: string; content: string; createdAt: number; updatedAt: number }

export interface SyncBook {
  format: 'serifwriter-sync';
  version: 1;
  id: string;
  project: Pick<Project, 'createdAt' | 'updatedAt' | 'deletedAt' | 'meta' | 'templateId' | 'overrides' | 'customCss' | 'goal' | 'stats'>;
  order: string[];
  sections: SyncSection[]; // in book order
}

/** What a book looked like when the two copies last agreed. */
export interface SyncBase { fields: string; sections: Record<string, string>; order: string[] }

export function toSyncBook(p: Project, sections: Section[]): SyncBook {
  return {
    format: 'serifwriter-sync', version: 1, id: p.id,
    project: { createdAt: p.createdAt, updatedAt: p.updatedAt, deletedAt: p.deletedAt ?? null, meta: p.meta, templateId: p.templateId, overrides: p.overrides, customCss: p.customCss, goal: p.goal, stats: p.stats },
    order: sections.map((s) => s.id),
    sections: sections.map((s) => ({ id: s.id, kind: s.kind, title: s.title, content: s.content, createdAt: s.createdAt, updatedAt: s.updatedAt })),
  };
}

export const sectionHash = (s: SyncSection) => hashString(`${s.kind}\u0000${s.title}\u0000${s.content}`);
const fieldsHash = (p: SyncBook['project']) =>
  hashString(JSON.stringify([p.meta, p.templateId, p.overrides, p.customCss, p.goal ?? null, p.deletedAt ?? null]));

export const baseOf = (b: SyncBook): SyncBase =>
  ({ fields: fieldsHash(b.project), sections: Object.fromEntries(b.sections.map((s) => [s.id, sectionHash(s)])), order: [...b.order] });

/** Changes whenever anything worth syncing changes. */
export const bookHash = (b: SyncBook) =>
  hashString(JSON.stringify([fieldsHash(b.project), b.order, b.sections.map(sectionHash), b.project.stats ?? null]));

/** Writing stats from two devices: each day's figures and each hour's minutes, whichever is higher. */
function mergeStats(a?: WritingStats, b?: WritingStats): WritingStats | undefined {
  if (!a || !b) return a || b;
  const days = { ...b.days };
  for (const [k, d] of Object.entries(a.days)) {
    const o = days[k];
    days[k] = o ? { w: Math.max(d.w, o.w), m: Math.max(d.m, o.m), t: Math.max(d.t, o.t) } : d;
  }
  return { ...a, days, hours: a.hours.map((m, i) => Math.max(m, b.hours[i] ?? 0)), dailyGoal: a.dailyGoal ?? b.dailyGoal };
}

export const COPY_SUFFIX = ' (other device’s copy)';

export function mergeBooks(local: SyncBook, remote: SyncBook, base: SyncBase | null, newId: () => string = () => uid('s')): { book: SyncBook; conflicts: number } {
  const L = new Map(local.sections.map((s) => [s.id, s]));
  const R = new Map(remote.sections.map((s) => [s.id, s]));
  const kept = new Map<string, SyncSection>();
  const copies = new Map<string, SyncSection>(); // original id → the other side's version, kept beside it
  let conflicts = 0;

  for (const id of new Set([...L.keys(), ...R.keys()])) {
    const l = L.get(id);
    const r = R.get(id);
    const b = base?.sections[id];
    if (l && r) {
      const hl = sectionHash(l);
      const hr = sectionHash(r);
      if (hl === hr) kept.set(id, l.updatedAt >= r.updatedAt ? l : r);
      else if (b !== undefined && hl === b) kept.set(id, r); // only the other device changed it
      else if (b !== undefined && hr === b) kept.set(id, l); // only this device changed it
      else {
        // Changed on both: the newer stays, the other is kept beside it.
        const [win, lose] = l.updatedAt >= r.updatedAt ? [l, r] : [r, l];
        kept.set(id, win);
        if (lose.content.trim()) { copies.set(id, { ...lose, id: newId(), title: lose.title + COPY_SUFFIX }); conflicts++; }
      }
    } else {
      const s = (l || r)!;
      // Gone from one side: a deletion there, unless this side changed it since (then it stays).
      if (b !== undefined && sectionHash(s) === b) continue;
      kept.set(id, s);
    }
  }

  // Order: from whichever side rearranged the book, with the other side's new sections in their place.
  const localMoved = !base || local.order.join() !== base.order.join();
  const [first, other] = localMoved ? [local.order, remote.order] : [remote.order, local.order];
  const order = first.filter((id) => kept.has(id));
  other.forEach((id, i) => {
    if (!kept.has(id) || order.includes(id)) return;
    const prev = other.slice(0, i).reverse().find((p) => order.includes(p));
    order.splice(prev ? order.indexOf(prev) + 1 : 0, 0, id);
  });
  for (const id of kept.keys()) if (!order.includes(id)) order.push(id);
  for (const [orig, c] of copies) { order.splice(order.indexOf(orig) + 1, 0, c.id); kept.set(c.id, c); }

  // Book details and design: from the side that changed them (the newer if both did).
  const fl = fieldsHash(local.project);
  const fr = fieldsHash(remote.project);
  const useRemote = fl !== fr && (base?.fields === fl || (base?.fields !== fr && remote.project.updatedAt > local.project.updatedAt));
  const fields = useRemote ? remote.project : local.project;
  const project = {
    ...fields,
    createdAt: Math.min(local.project.createdAt, remote.project.createdAt),
    updatedAt: Math.max(local.project.updatedAt, remote.project.updatedAt),
    stats: mergeStats(local.project.stats, remote.project.stats),
  };
  return { book: { ...local, project, order, sections: order.map((id) => kept.get(id)!) }, conflicts };
}

/** Applies a merged book to a project and its sections, keeping what belongs to this device (cursors, last section). */
export async function applyToProject(project: Project, sections: Section[], b: SyncBook): Promise<{ project: Project; sections: Section[]; changed: string[]; removed: string[] }> {
  const byId = new Map(sections.map((s) => [s.id, s]));
  const changed: string[] = [];
  const next = b.sections.map((r) => {
    const s = byId.get(r.id);
    if (s && s.content === r.content && s.title === r.title && s.kind === r.kind) return s;
    changed.push(r.id);
    return { ...s, ...r, projectId: project.id, words: countWords(r.content) } as Section;
  });
  const removed = sections.filter((s) => !b.sections.some((r) => r.id === s.id)).map((s) => s.id);
  const p = b.project;
  Object.assign(project, { meta: p.meta, templateId: p.templateId, overrides: p.overrides, customCss: p.customCss, goal: p.goal, stats: p.stats, deletedAt: p.deletedAt ?? null, createdAt: p.createdAt, updatedAt: p.updatedAt, order: b.order });
  const title = next.find((s) => s.kind === 'title');
  if (title) project.meta = metaFromTitleContent(title.content, project.meta);
  if (!project.lastSectionId || !next.some((s) => s.id === project.lastSectionId)) project.lastSectionId = next.find((s) => s.kind === 'chapter')?.id ?? next[0]?.id ?? null;
  project.words = next.reduce((n, s) => n + (s.kind === 'title' || s.kind === 'toc' ? 0 : s.words), 0);
  return { project, sections: next, changed, removed };
}
