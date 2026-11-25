import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thinningPlan } from '../../src/storage/snapshots.ts';
import type { SnapshotMeta } from '../../src/model/types.ts';

const H = 3600_000;
const D = 24 * H;
const snap = (id: string, age: number, auto = true): SnapshotMeta => ({ id, projectId: 'p', createdAt: NOW - age, label: '', auto, words: 0, hash: id, size: 0 });
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

test('keeps everything from the last day', () => {
  const list = [snap('a', 10 * 60_000), snap('b', 20 * 60_000), snap('c', 23 * H)];
  assert.deepEqual(thinningPlan(list, NOW), []);
});

test('keeps one per hour for a week, one per day after, and never drops named versions', () => {
  const list = [
    snap('h1', 2 * D + 5 * 60_000), snap('h2', 2 * D + 10 * 60_000), // same hour → one dropped
    snap('d1', 10 * D), snap('d2', 10 * D + H), // same day (10 days old) → one dropped
    snap('named', 10 * D + 2 * H, false),
  ];
  const drop = thinningPlan(list, NOW);
  assert.equal(drop.length, 2);
  assert.ok(drop.includes('h2'));
  assert.ok(!drop.includes('named'));
});
