import type { ProjectCtx } from './project.ts';
import type { Section, SnapshotMeta, SnapshotPayload } from '../model/types.ts';
import { h, button } from './dom.ts';
import { modal, confirmDialog, promptDialog, toast } from './dialogs.ts';
import { listSnapshots, loadSnapshot, createSnapshot } from '../storage/snapshots.ts';
import { diffParagraphs } from '../model/diff.ts';
import { sectionTitle } from '../model/defaults.ts';
import * as repo from '../db/repo.ts';
import { formatDateTime, fmtNum } from '../util.ts';

// Version history: every automatic and named version, a paragraph diff
// against the current text, and restore (whole book or one section).

export async function openHistory(ctx: ProjectCtx): Promise<void> {
  await ctx.flush();
  const m = modal('Version history', { className: 'huge' });
  const list = h('div', { class: 'hist-list' });
  const detail = h('div', { class: 'hist-detail' });
  m.body.style.padding = '0 0 0 12px';
  m.body.appendChild(h('div', { class: 'hist' }, list, detail));
  const saveNow = button('Save a named version…', { icon: 'save', onClick: async () => {
    const label = await promptDialog('Name this version', 'Name', `Draft ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}`, { ok: 'Save version' });
    if (label === null) return;
    await ctx.snapshot(label.trim() || 'Named version');
    toast('Version saved.', { kind: 'success' });
    await refresh();
  } });
  m.footer.append(h('span', { class: 'dlg-note', style: { marginRight: 'auto', alignSelf: 'center', marginBottom: '0' } }, 'A version is kept every 10 minutes while you write, when you open the book, and before anything is deleted or restored.'), saveNow, button('Close', { onClick: () => m.close() }));

  let snaps: SnapshotMeta[] = [];
  let selected: SnapshotMeta | null = null;
  const cache = new Map<string, SnapshotPayload>();

  const load = async (s: SnapshotMeta) => {
    if (!cache.has(s.id)) cache.set(s.id, await loadSnapshot(s.id));
    return cache.get(s.id)!;
  };

  async function refresh(): Promise<void> {
    snaps = await listSnapshots(ctx.session.project.id);
    if (!snaps.length) {
      list.replaceChildren(h('div', { class: 'hist-empty' }, 'No versions yet. One is saved every 10 minutes while you write.'));
      detail.replaceChildren();
      return;
    }
    let lastDay = '';
    const items: HTMLElement[] = [];
    snaps.forEach((s, i) => {
      const day = new Date(s.createdAt).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      if (day !== lastDay) { items.push(h('div', { class: 'hist-day' }, day)); lastDay = day; }
      const prev = snaps[i + 1];
      const delta = prev ? s.words - prev.words : 0;
      const b = h('button', { class: `hist-item ${selected?.id === s.id ? 'on' : ''}`, type: 'button' },
        h('div', { class: 'hist-time' }, new Date(s.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })),
        h('div', { class: 'hist-label' }, s.label || s.reason || (s.auto ? 'Automatic' : 'Named version')),
        h('div', { class: 'hist-meta' }, `${fmtNum(s.words)} words `, delta ? h('span', { class: delta > 0 ? 'plus' : 'minus' }, `${delta > 0 ? '+' : ''}${fmtNum(delta)}`) : null));
      b.addEventListener('click', () => { selected = s; void refresh(); });
      items.push(b);
    });
    list.replaceChildren(...items);
    if (!selected) selected = snaps[0];
    await showDetail(selected);
  }

  async function showDetail(s: SnapshotMeta): Promise<void> {
    detail.replaceChildren(h('div', { class: 'hist-empty' }, 'Loading…'));
    let payload: SnapshotPayload;
    try { payload = await load(s); } catch (e: any) { detail.replaceChildren(h('div', { class: 'hist-empty' }, e.message)); return; }
    const current = new Map(ctx.session.sections.map((x) => [x.id, x]));
    const then = new Map(payload.sections.map((x) => [x.id, x]));
    const ids = [...payload.sections.map((x) => x.id), ...ctx.session.sections.filter((x) => !then.has(x.id)).map((x) => x.id)];
    let active = ids.find((id) => (then.get(id)?.content ?? '') !== (current.get(id)?.content ?? '')) || ids[0];
    const chips = h('div', { class: 'hist-secs' });
    const diffBox = h('div', { class: 'hist-diff' });

    const paintChips = () => {
      chips.replaceChildren(...ids.map((id) => {
        const a = then.get(id);
        const b = current.get(id);
        const cls = !b ? 'gone' : !a ? 'new' : a.content !== b.content || a.title !== b.title ? 'changed' : '';
        const chip = h('button', { class: `hist-sec ${cls} ${id === active ? 'on' : ''}`, type: 'button', title: !b ? 'Deleted since this version' : !a ? 'Added since this version' : cls ? 'Changed since this version' : 'Unchanged' }, sectionTitle((a || b)!));
        chip.addEventListener('click', () => { active = id; paintChips(); paintDiff(); });
        return chip;
      }));
    };
    const paintDiff = () => {
      const a = then.get(active)?.content ?? '';
      const b = current.get(active)?.content ?? '';
      const ops = diffParagraphs(b, a); // from current → that version
      const out: HTMLElement[] = [];
      let sameRun: string[] = [];
      const flushSame = () => {
        if (sameRun.length > 4) {
          out.push(h('p', { class: 'same' }, sameRun[0]));
          out.push(h('div', { class: 'fold' }, `… ${sameRun.length - 2} unchanged paragraphs …`));
          out.push(h('p', { class: 'same' }, sameRun[sameRun.length - 1]));
        } else for (const t of sameRun) out.push(h('p', { class: 'same' }, t));
        sameRun = [];
      };
      for (const op of ops) {
        if (op.type === 'same') { sameRun.push(op.text); continue; }
        flushSame();
        out.push(h('p', { class: op.type === 'add' ? 'add' : 'del', title: op.type === 'add' ? 'In this version, not in your current text' : 'In your current text, not in this version' }, op.text));
      }
      flushSame();
      if (!ops.some((o) => o.type !== 'same')) out.unshift(h('div', { class: 'fold' }, 'No differences from your current text in this section.'));
      diffBox.replaceChildren(...out);
    };

    const restoreAll = button('Restore the whole book to this version', { icon: 'restore', class: 'primary small', onClick: async () => {
      if (!(await confirmDialog('Restore this version?', `Your book will go back to how it was on ${formatDateTime(s.createdAt)}. Your current text is saved as a version first, so you can come back to it.`, { ok: 'Restore' }))) return;
      await restoreBook(ctx, payload);
      m.close();
      toast('Book restored. Your previous text is saved in History as “Before restoring”.', { kind: 'success', timeout: 6000 });
    } });
    const restoreOne = button('Restore only this section', { icon: 'restore', class: 'small', onClick: async () => {
      const sec = then.get(active);
      if (!sec) return void toast('This section did not exist in that version.');
      if (!(await confirmDialog(`Restore “${sectionTitle(sec)}”?`, 'Only this section goes back to that version. Your current text is saved as a version first.', { ok: 'Restore section' }))) return;
      await restoreSection(ctx, sec, payload);
      m.close();
      toast(`“${sectionTitle(sec)}” restored.`, { kind: 'success' });
    } });
    const rename = button('Rename', { class: 'small', onClick: async () => {
      const label = await promptDialog('Rename version', 'Name', s.label || '', { ok: 'Save' });
      if (label === null) return;
      s.label = label.trim();
      s.auto = !s.label ? s.auto : false; // named versions are kept forever
      await repo.updateSnapshotMeta(s);
      await refresh();
    } });
    const del = button('Delete version', { class: 'small danger', onClick: async () => {
      if (!(await confirmDialog('Delete this version?', 'This version will be removed from History.', { ok: 'Delete', danger: true }))) return;
      await repo.deleteSnapshots([s.id]);
      selected = null;
      await refresh();
    } });

    detail.replaceChildren(
      h('h3', { style: { margin: '6px 0 2px', font: '600 15px var(--ui-font)' } }, s.label || s.reason || 'Automatic version'),
      h('div', { class: 'dlg-note' }, `${formatDateTime(s.createdAt)} · ${fmtNum(s.words)} words · ${payload.sections.length} sections${s.auto ? ' · automatic (thinned over time)' : ' · kept forever'}`),
      h('div', { class: 'hist-actions' }, restoreAll, restoreOne, rename, del),
      chips,
      h('div', { class: 'dlg-note' }, 'Green paragraphs are in this version but not in your current text; struck-through ones are in your current text but not in this version.'),
      diffBox,
    );
    paintChips();
    paintDiff();
  }

  await refresh();
}

async function restoreBook(ctx: ProjectCtx, payload: SnapshotPayload): Promise<void> {
  const { session } = ctx;
  await ctx.flush();
  await createSnapshot(session.project, session.sections, { auto: false, label: 'Before restoring', reason: 'Before restoring' });
  const p = session.project;
  const keepIds = new Set(payload.sections.map((s) => s.id));
  for (const s of session.sections) if (!keepIds.has(s.id)) await repo.deleteSection(p, s.id);
  const restored: Section[] = payload.sections.map((s) => ({ ...s, projectId: p.id, updatedAt: Date.now() }));
  p.meta = payload.project.meta;
  p.order = restored.map((s) => s.id);
  p.templateId = payload.project.templateId;
  p.overrides = payload.project.overrides;
  p.customCss = payload.project.customCss;
  if (!keepIds.has(p.lastSectionId || '')) p.lastSectionId = restored[0]?.id ?? null;
  p.updatedAt = Date.now();
  await repo.saveSections(p, restored, restored.reduce((n, s) => n + (s.kind === 'title' || s.kind === 'toc' ? 0 : s.words), 0));
  await ctx.reload();
}

async function restoreSection(ctx: ProjectCtx, sec: Section, payload: SnapshotPayload): Promise<void> {
  const { session } = ctx;
  await ctx.flush();
  await createSnapshot(session.project, session.sections, { auto: false, label: `Before restoring “${sectionTitle(sec)}”`, reason: 'Before restoring a section' });
  const p = session.project;
  const copy: Section = { ...sec, projectId: p.id, updatedAt: Date.now() };
  if (!p.order.includes(sec.id)) {
    // put it back where it was, relative to its old neighbour
    const oldIdx = payload.project.order.indexOf(sec.id);
    const before = payload.project.order.slice(0, oldIdx).reverse().find((id) => p.order.includes(id));
    const at = before ? p.order.indexOf(before) + 1 : 0;
    p.order.splice(at, 0, sec.id);
  }
  p.lastSectionId = sec.id;
  await repo.saveSections(p, [copy]);
  await ctx.reload();
}
