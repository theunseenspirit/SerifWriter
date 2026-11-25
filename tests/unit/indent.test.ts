import { test } from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';

import { indentedLines } from '../../src/md/indent.ts';

test('indented lines become indented prose, one per line, not code', () => {
  const md = new MarkdownIt();
  indentedLines(md);
  const out = md.render('The argument:\n\tP1. All *men* are mortal.\n\tP2. Socrates is a man.\n\t\tLemma.\n\n\tC. So he is mortal.\n\n- a list\n  continued\n\n```\ncode\n```');
  assert.match(out, /<p>The argument:<\/p>\n<p class="ind ind1">P1\. All <em>men<\/em> are mortal\.<\/p>\n<p class="ind ind1">P2\. Socrates is a man\.<\/p>\n<p class="ind ind2">Lemma\.<\/p>/);
  assert.match(out, /<p class="ind ind1">C\. So he is mortal\.<\/p>/);
  assert.match(out, /<li>a list\ncontinued<\/li>/);
  assert.match(out, /<pre><code>code\n<\/code><\/pre>/);
});
