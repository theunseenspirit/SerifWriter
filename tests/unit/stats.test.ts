import { test } from 'node:test';
import assert from 'node:assert/strict';
import { habits, prose } from '../../src/model/stats.ts';

test('habits: streaks, averages, pace', () => {
  const days = {
    '2026-11-01': { w: 500, m: 30, t: 500 }, '2026-11-02': { w: 300, m: 30, t: 800 }, '2026-11-03': { w: 100, m: 0, t: 900 },
    '2026-11-20': { w: 200, m: 20, t: 1100 }, '2026-11-21': { w: -50, m: 10, t: 1050 }, '2026-11-23': { w: 250, m: 25, t: 1300 }, '2026-11-24': { w: 150, m: 5, t: 1450 },
  };
  const h = habits({ days, hours: [] }, new Date('2026-11-25T09:00'));
  assert.equal(h.streak, 2); // today not written yet: 23rd and 24th
  assert.equal(h.best, 3);
  assert.equal(h.writingDays, 6);
  assert.equal(h.week, 550);
  assert.equal(h.avg, 250);
  assert.equal(h.pace, 750); // 1,500 words in 120 minutes
});

test('prose: sentences, readability, variety, frequent words', () => {
  const p = prose('# Title\n\nThe cat sat. The cat ran far away!\n\nA *notebook* waits [^1] for the notebook writer.\n\n[^1]: Ignored note.');
  assert.equal(p.sentences, 4);
  assert.equal(p.longest, 7);
  assert.deepEqual(p.top[0], ['notebook', 2]);
  assert.ok(p.flesch > 60 && p.variety > 50);
});
