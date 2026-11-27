import { test } from 'node:test';
import assert from 'node:assert/strict';

import { markdown } from '../../src/md/render.ts';

test('a single Return runs on by default, and starts a new line with breaks on', () => {
  const src = 'P1. All men are mortal.\nP2. Socrates is a man.\n\nC. Socrates is mortal.';
  const off = markdown('en').render(src, {});
  assert.match(off, /<p[^>]*>P1\. All men are mortal\.\nP2\. Socrates is a man\.<\/p>/);
  const on = markdown('en').render(src, { breaks: true });
  assert.match(on, /<p[^>]*>P1\. All men are mortal\.<br>\nP2\. Socrates is a man\.<\/p>/);
  assert.match(on, /<p[^>]*>C\. Socrates is mortal\.<\/p>/);
  // The same parser serves both: the setting lives in the render call, not the instance.
  assert.doesNotMatch(markdown('en').render(src, {}), /<br>/);
});

import { hardLineBreaks, looksHardWrapped } from '../../src/md/render.ts';

test('Markdown export marks each line break in a paragraph as a hard break, leaving the rest alone', () => {
  const src = '## The argument\n\nP1. All men are mortal.\nP2. Socrates is a man.\nC. So he is mortal.\n\n- a list\n- of items\n\n```\ncode\nlines\n```\n\n$$\nx = y\n$$\n\nAlready broken  \nhere';
  const out = hardLineBreaks(src);
  assert.match(out, /P1\. All men are mortal\.\\\nP2\. Socrates is a man\.\\\nC\. So he is mortal\.\n\n/);
  assert.match(out, /- a list\n- of items/);
  assert.match(out, /```\ncode\nlines\n```/);
  assert.match(out, /\$\$\nx = y\n\$\$/);
  assert.match(out, /Already broken  \nhere$/);
});

test('hard-wrapped Markdown is recognised; short lines written one per line are not', () => {
  const wrapped = Array.from({ length: 3 }, () => 'It was the best of times, it was the worst of times, it was the age\nof wisdom, it was the age of foolishness, it was the epoch of belief,\nit was the epoch of incredulity, it was the season of Light.').join('\n\n');
  assert.equal(looksHardWrapped([wrapped]), true);
  const premises = Array.from({ length: 3 }, () => 'All men are mortal.\nSocrates is a man.\nTherefore, Socrates is mortal.').join('\n\n');
  assert.equal(looksHardWrapped([premises]), false);
});
