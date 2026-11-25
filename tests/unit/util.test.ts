import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLabel, toRoman, numberToWords, deepMerge, deepDiff, safeFilename } from '../../src/util.ts';

test('chapter labels', () => {
  assert.equal(formatLabel('Chapter {Word}', 1), 'Chapter One');
  assert.equal(formatLabel('Chapter {Word}', 21), 'Chapter Twenty-One');
  assert.equal(formatLabel('{Roman}.', 14), 'XIV.');
  assert.equal(formatLabel('Part {n}', 3), 'Part 3');
  assert.equal(toRoman(2026), 'MMXXVI');
  assert.equal(numberToWords(105), 'one hundred and five');
});

test('settings overrides merge and diff', () => {
  const base = { a: 1, b: { c: 2, d: 3 }, e: [1, 2] };
  const over = deepDiff(base, { a: 1, b: { c: 5, d: 3 }, e: [1, 2] });
  assert.deepEqual(over, { b: { c: 5 } });
  assert.deepEqual(deepMerge(base, over), { a: 1, b: { c: 5, d: 3 }, e: [1, 2] });
});

test('safe filenames for macOS', () => {
  assert.equal(safeFilename('Chapter 1: The "Start"/End?'), 'Chapter 1 The StartEnd');
  assert.equal(safeFilename('   '), 'Untitled');
});
