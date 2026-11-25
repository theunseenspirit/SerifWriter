import { test } from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import { parseBibtex, bibEntry, citeContext, citations, tex } from '../../src/md/cite.ts';

const BIB = `
@book{arendt58, author = {Arendt, Hannah}, title = {The Human Condition}, publisher = {University of Chicago Press}, address = {Chicago}, year = 1958}
@article{kuhn62a, author = "Thomas S. Kuhn and Paul Feyerabend", title = {A {Theory} of Change}, journal = {Mind}, volume = 12, number = 3, pages = {45--60}, year = {1962}}
@article{kuhn62b, author = {Kuhn, Thomas S. and Feyerabend, Paul}, title = {Another Paper}, journal = {Isis}, year = {1962}}
@comment{ignored}
@incollection{goedel, author = {G{\\"o}del, Kurt and others}, title = {On Undecidable Propositions}, booktitle = {The Undecidable}, editor = {Martin Davis}, year = 1965, pages = {4-38}}
`;

test('parses BibTeX: names, braces, accents, numbers, disambiguation', () => {
  const bib = parseBibtex(BIB);
  assert.equal(bib.size, 4);
  assert.equal(bib.get('goedel')!.names[0].family, 'Gödel');
  assert.equal(bib.get('kuhn62a')!.names[0].given, 'Thomas S.');
  assert.equal(bib.get('kuhn62a')!.year, '1962a');
  assert.equal(bib.get('kuhn62b')!.year, '1962b');
  assert.equal(tex('Caf\\\'e \\& {Bar} --- x'), 'Café &amp; Bar — x');
});

test('formats bibliography entries', () => {
  const bib = parseBibtex(BIB);
  assert.equal(bibEntry(bib.get('arendt58')!, 'author-date'), 'Arendt, Hannah. 1958. <em>The Human Condition</em>. Chicago: University of Chicago Press.');
  assert.equal(bibEntry(bib.get('kuhn62a')!, 'author-date'), 'Kuhn, Thomas S., and Paul Feyerabend. 1962a. “A Theory of Change.” <em>Mind</em> 12 (3): 45–60.');
  assert.match(bibEntry(bib.get('goedel')!, 'author-date'), /^Gödel, Kurt et al\. 1965\. “On Undecidable Propositions\.” In <em>The Undecidable<\/em>, edited by Martin Davis, 4–38\.$/);
  assert.equal(bibEntry(bib.get('arendt58')!, 'note'), 'Arendt, Hannah. <em>The Human Condition</em>. Chicago: University of Chicago Press, 1958.');
});

function render(src: string, style: 'author-date' | 'numeric' | 'note') {
  const md = new MarkdownIt().use(footnote).use(citations);
  const cite = citeContext([{ kind: 'bibliography', content: BIB }, { kind: 'chapter', content: src }], style)!;
  return md.render(src, { cite }).replace(/<span class="cite">|<\/span>/g, '');
}

test('author-date citations', () => {
  const out = render('As argued [see @arendt58, 7-9; -@kuhn62a]. @arendt58 [p. 3] says. Mail me@example.com or @nobody.', 'author-date');
  assert.match(out, /\(see Arendt 1958, 7–9; 1962a\)/);
  assert.match(out, /Arendt \(1958, p\. 3\) says/);
  assert.match(out, /me@example\.com or @nobody/);
});

test('numeric citations follow first appearance', () => {
  const out = render('First [@kuhn62b], then [@arendt58, 12] and [@kuhn62b].', 'numeric');
  assert.match(out, /First \[1\], then \[2, 12\]/);
});

test('note citations become footnotes: full first, short after, inline inside notes', () => {
  const out = render('A claim [@arendt58, 5]. Again [@arendt58].[^1]\n\n[^1]: See [@kuhn62a].', 'note');
  assert.match(out, /Hannah Arendt, <em>The Human Condition<\/em> \(Chicago: University of Chicago Press, 1958\), 5\./);
  assert.match(out, /Arendt, <em>The Human Condition<\/em>\./);
  assert.match(out, /See Thomas S\. Kuhn and Paul Feyerabend, “A Theory of Change,” <em>Mind<\/em> 12 \(3\) \(1962a\): 45–60/);
  assert.equal((out.match(/class="footnote-item/g) || []).length, 3);
});
