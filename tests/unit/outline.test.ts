import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outline, plainHeading } from '../../src/model/outline.ts';

const H = { h1: 'chapter', h2: 'section', h3: 'subsection', h4: 'minor', h5: 'minor', h6: 'runin' } as const;

test('lists sections and subsections with their lines', () => {
  const src = '---\ntitle: X\n---\n# The Chapter\n\nText.\n\n## First\n\n### Deeper\n\n#### Minor\n\n## Second ##\n';
  assert.deepEqual(outline(src, H), [
    { level: 1, title: 'First', line: 7 },
    { level: 2, title: 'Deeper', line: 9 },
    { level: 1, title: 'Second', line: 13 },
  ]);
});

test('skips code, display math and the opening subtitle', () => {
  const src = '# Title\n\n### A subtitle\n\n```\n## not a heading\n```\n\n$$\n## nor this\n$$\n\n$$ x $$\n\n## Real';
  assert.deepEqual(outline(src, H).map((e) => e.title), ['Real']);
});

test('numbers headings when the template does, restarting after an in-flow chapter', () => {
  const src = '## A\n### a\n### b\n## B\n\n# Next chapter\n\n## C';
  assert.deepEqual(outline(src, H, true).map((e) => e.hnum), ['1', '1.1', '1.2', '2', '1']);
});

test('follows the template’s heading roles', () => {
  const t = { ...H, h2: 'minor', h3: 'section', h4: 'subsection' } as const;
  assert.deepEqual(outline('## no\n### yes\n#### sub', t).map((e) => [e.level, e.title]), [[1, 'yes'], [2, 'sub']]);
});

test('heading text loses its Markdown', () => {
  assert.equal(plainHeading('The *Republic*, Book [I](x){^Plato} {#sec:rep}'), 'The Republic, Book I');
  assert.equal(plainHeading('Notes[^1] on `code` and **bold**'), 'Notes on code and bold');
});
