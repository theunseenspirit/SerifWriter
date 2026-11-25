import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitFrontMatter, parseYaml, withFrontMatter } from '../../src/md/frontmatter.ts';

test('splits YAML front matter from the body and counts its lines', () => {
  const fm = splitFrontMatter('---\ntitle: The Road Behind Us\nauthor: "A. Writer"\n---\n\n# Chapter\n');
  assert.equal(fm.present, true);
  assert.equal(fm.data.title, 'The Road Behind Us');
  assert.equal(fm.data.author, 'A. Writer');
  assert.equal(fm.lines, 4);
  assert.equal(fm.body, '\n# Chapter\n');
});

test('no front matter leaves the text untouched', () => {
  const fm = splitFrontMatter('Just text\n---\nmore');
  assert.equal(fm.present, false);
  assert.equal(fm.body, 'Just text\n---\nmore');
});

test('block scalars, lists, comments and quotes', () => {
  const d = parseYaml('# comment\ntitle: |\n  The Road\n  Behind Us\nsubtitle: \'It\'\'s fine\'\ntags:\n  - one\n  - "two"\ninline: [a, b]\nfolded: >\n  a\n  b');
  assert.equal(d.title, 'The Road\nBehind Us');
  assert.equal(d.subtitle, "It's fine");
  assert.deepEqual(d.tags, ['one', 'two']);
  assert.deepEqual(d.inline, ['a', 'b']);
  assert.equal(d.folded, 'a b');
});

test('round-trips through withFrontMatter', () => {
  const text = withFrontMatter({ title: 'A: Story', author: 'Me', year: '2026', note: 'line one\nline two' }, 'Body', ['title']);
  const fm = splitFrontMatter(text);
  assert.equal(fm.data.title, 'A: Story');
  assert.equal(fm.data.year, '2026');
  assert.equal(fm.data.note, 'line one\nline two');
  assert.equal(fm.body.trim(), 'Body');
});
