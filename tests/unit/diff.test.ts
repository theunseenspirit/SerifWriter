import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffParagraphs } from '../../src/model/diff.ts';

test('paragraph diff marks additions and deletions', () => {
  const ops = diffParagraphs('One.\n\nTwo.\n\nThree.', 'One.\n\nTwo and a half.\n\nThree.\n\nFour.');
  assert.deepEqual(ops.map((o) => o.type), ['same', 'del', 'add', 'same', 'add']);
});

test('identical texts are all "same"', () => {
  assert.ok(diffParagraphs('a\n\nb', 'a\n\nb').every((o) => o.type === 'same'));
});
