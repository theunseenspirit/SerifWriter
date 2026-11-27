import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeBooks, baseOf, COPY_SUFFIX, type SyncBook, type SyncSection } from '../../src/sync/merge.ts';

const sec = (id: string, content: string, updatedAt = 1, title = id): SyncSection => ({ id, kind: 'chapter', title, content, createdAt: 0, updatedAt });
const book = (sections: SyncSection[], fields: Partial<SyncBook['project']> = {}): SyncBook => ({
  format: 'serifwriter-sync', version: 1, id: 'p1',
  project: { createdAt: 0, updatedAt: 1, deletedAt: null, meta: { title: 'B', subtitle: '', author: '', publisher: '', year: '', language: 'en', extra: {} }, templateId: 'syllogism', overrides: {}, customCss: '', ...fields },
  order: sections.map((s) => s.id),
  sections,
});
let n = 0;
const ids = () => `copy${++n}`;
const text = (b: SyncBook) => b.sections.map((s) => `${s.id}=${s.content}`).join(' | ');

test('a change on one device reaches the other; changes to different sections both survive', () => {
  const base = book([sec('a', 'A'), sec('b', 'B')]);
  const local = book([sec('a', 'A mine', 5), sec('b', 'B')]);
  const remote = book([sec('a', 'A'), sec('b', 'B theirs', 6)]);
  const { book: m, conflicts } = mergeBooks(local, remote, baseOf(base), ids);
  assert.equal(text(m), 'a=A mine | b=B theirs');
  assert.equal(conflicts, 0);
});

test('the same section changed on both devices: the newer stays, the other is kept beside it', () => {
  const base = book([sec('a', 'A'), sec('b', 'B')]);
  const local = book([sec('a', 'A mine', 5), sec('b', 'B')]);
  const remote = book([sec('a', 'A theirs', 9), sec('b', 'B')]);
  const { book: m, conflicts } = mergeBooks(local, remote, baseOf(base), ids);
  assert.equal(conflicts, 1);
  assert.deepEqual(m.order.length, 3);
  assert.equal(m.sections[0].content, 'A theirs');
  assert.equal(m.sections[1].content, 'A mine');
  assert.equal(m.sections[1].title, 'a' + COPY_SUFFIX);
  assert.equal(m.sections[2].id, 'b');
});

test('a section deleted on one device goes, unless the other changed it since', () => {
  const base = book([sec('a', 'A'), sec('b', 'B'), sec('c', 'C')]);
  const local = book([sec('a', 'A'), sec('c', 'C edited', 4)]); // deleted b; edited c
  const remote = book([sec('a', 'A'), sec('b', 'B')]); // deleted c
  const { book: m } = mergeBooks(local, remote, baseOf(base), ids);
  assert.equal(text(m), 'a=A | c=C edited');
});

test('new sections from both devices are kept in their places', () => {
  const base = book([sec('a', 'A'), sec('z', 'Z')]);
  const local = book([sec('a', 'A'), sec('l', 'new here', 3), sec('z', 'Z')]);
  const remote = book([sec('r', 'new there', 3), sec('a', 'A'), sec('z', 'Z')]);
  const { book: m } = mergeBooks(local, remote, baseOf(base), ids);
  assert.deepEqual(m.order, ['r', 'a', 'l', 'z']);
});

test('a reordering on one device is kept', () => {
  const base = book([sec('a', 'A'), sec('b', 'B'), sec('c', 'C')]);
  const local = book([sec('a', 'A'), sec('b', 'B'), sec('c', 'C')]);
  const remote = book([sec('c', 'C'), sec('a', 'A'), sec('b', 'B')]);
  assert.deepEqual(mergeBooks(local, remote, baseOf(base), ids).book.order, ['c', 'a', 'b']);
});

test('design and details come from the device that changed them', () => {
  const base = book([sec('a', 'A')]);
  const local = book([sec('a', 'A')], { updatedAt: 9 });
  const remote = book([sec('a', 'A')], { templateId: 'classic', updatedAt: 2 });
  assert.equal(mergeBooks(local, remote, baseOf(base), ids).book.project.templateId, 'classic');
  const local2 = book([sec('a', 'A')], { overrides: { type: { autoIndent: false } } as any, updatedAt: 2 });
  assert.deepEqual(mergeBooks(local2, base, baseOf(base), ids).book.project.overrides, { type: { autoIndent: false } });
});

test('first sync of two copies with no common base loses nothing', () => {
  const local = book([sec('a', 'A here', 5)]);
  const remote = book([sec('a', 'A there', 3), sec('b', 'B', 3)]);
  const { book: m, conflicts } = mergeBooks(local, remote, null, ids);
  assert.equal(conflicts, 1);
  assert.deepEqual(m.sections.map((s) => s.content), ['A here', 'A there', 'B']);
});

test('writing stats from both devices are combined, not overwritten', () => {
  const hours = (h: number, m: number) => Array.from({ length: 24 }, (_, i) => (i === h ? m : 0));
  const local = book([sec('a', 'A')], { stats: { days: { '2026-11-27': { w: 100, m: 20, t: 900 } }, hours: hours(9, 20) } });
  const remote = book([sec('a', 'A')], { stats: { days: { '2026-11-26': { w: 50, m: 10, t: 800 } }, hours: hours(21, 10) } });
  const st = mergeBooks(local, remote, baseOf(local), ids).book.project.stats!;
  assert.deepEqual(Object.keys(st.days).sort(), ['2026-11-26', '2026-11-27']);
  assert.equal(st.hours[9] + st.hours[21], 30);
});
