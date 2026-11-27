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
