import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectionToMarkdown, sectionFromMarkdown, projectToFiles, projectFromFiles, projectFromSingleMarkdown } from '../../src/storage/serialize.ts';
import { sampleProject } from '../../src/model/defaults.ts';

test('a section survives a round trip through a .md file', () => {
  const { sections } = sampleProject();
  const ch = sections.find((s) => s.kind === 'chapter')!;
  const back = sectionFromMarkdown(sectionToMarkdown(ch), ch.projectId, 'x');
  assert.equal(back.kind, 'chapter');
  assert.equal(back.title, ch.title);
  assert.equal(back.content.trim(), ch.content.trim());
});

test('a whole project survives files + project.json', () => {
  const { project, sections } = sampleProject();
  const { json, files } = projectToFiles(project, sections);
  const map = new Map(files.map((f) => [f.name, f.text]));
  const back = projectFromFiles(json, map);
  assert.equal(back.project.id, project.id);
  assert.equal(back.project.meta.title, 'The Road Behind Us');
  assert.deepEqual(back.sections.map((s) => s.kind), sections.map((s) => s.kind));
  assert.deepEqual(back.sections.map((s) => s.id), sections.map((s) => s.id));
  assert.equal(files[0].name, '01 Title Page.md');
});

test('a single Markdown manuscript is split into chapters with metadata', () => {
  const md = '---\ntitle: My Novel\nauthor: Jane Doe\nsubtitle: A Story\n---\n\n# Preface\n\nWhy.\n\n# The Beginning\n\nIt began.\n\n```\n# not a heading\n```\n\n# The End\n\nIt ended.\n';
  const { project, sections } = projectFromSingleMarkdown(md, 'novel.md');
  assert.equal(project.meta.title, 'My Novel');
  assert.equal(project.meta.author, 'Jane Doe');
  const body = sections.filter((s) => s.kind === 'chapter' || s.kind === 'section');
  assert.deepEqual(body.map((s) => [s.kind, s.title]), [['section', 'Preface'], ['chapter', 'The Beginning'], ['chapter', 'The End']]);
  assert.match(body[1].content, /# not a heading/);
});
