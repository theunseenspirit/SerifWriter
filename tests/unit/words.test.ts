import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countWords, roundedWords } from '../../src/model/words.ts';

test('counts words and ignores Markdown syntax', () => {
  assert.equal(countWords('**Bold** and *italic* — don’t [link](https://example.com) here.'), 6);
  assert.equal(countWords('---\ntitle: Ignore me entirely\n---\nOne two three'), 3);
  assert.equal(countWords('A note.[^1]\n\n[^1]: The note text.'), 5);
  assert.equal(countWords('![alt text](asset:abc) Hello'), 1);
  assert.equal(countWords(''), 0);
});

test('rounds like a manuscript cover page', () => {
  assert.equal(roundedWords(982), '1,000');
  assert.equal(roundedWords(12345), '12,300');
  assert.equal(roundedWords(85432), '85,000');
});
