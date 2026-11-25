import { test } from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { indexEntries, indexMarks, pageList } from '../../src/md/terms.ts';

test('index: marks print nothing, terms sort like an index, pages compress to ranges', () => {
  const md = new MarkdownIt().use(indexMarks);
  assert.equal(md.renderInline('Plato{^Plato} and the {^Plato ! Republic}Republic'), 'Plato<span class="idx" data-idx="Plato"></span> and the <span class="idx" data-idx="Plato!Republic"></span>Republic');
  assert.deepEqual(indexEntries(['{^Zeno} {^Plato!Republic} {^Plato!Laws}', '{^Élan} {^aristotle} {^Plato}']), [
    { term: 'aristotle', subs: [] }, { term: 'Élan', subs: [] }, { term: 'Plato', subs: ['Laws', 'Republic'] }, { term: 'Zeno', subs: [] },
  ]);
  assert.equal(pageList(['xii', '3', '4', '5', '9', '10', '14']), 'xii, 3–5, 9–10, 14');
});
