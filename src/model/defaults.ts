import type { BookMeta, Project, Section, SectionKind } from './types.ts';
import { uid } from '../util.ts';
import { countWords } from './words.ts';
import { fmString, splitFrontMatter, withFrontMatter, type FMValue } from '../md/frontmatter.ts';

export interface KindInfo {
  label: string;
  defaultTitle: string;
  hint: string;
  /** Front matter → shown before the first chapter, numbered with roman folios. */
  front: boolean;
  /** Where the section starts in a two-sided book. */
  start: 'recto' | 'verso' | 'any' | 'chapter';
}

export const KINDS: Record<SectionKind, KindInfo> = {
  title: { label: 'Title page', defaultTitle: 'Title Page', hint: 'Book details as YAML front matter: title, subtitle, author, publisher, year.', front: true, start: 'recto' },
  copyright: { label: 'Copyright', defaultTitle: 'Copyright', hint: 'Set small at the foot of the page. Tokens: {author} {title} {year} {thisYear} {publisher} {font}.', front: true, start: 'verso' },
  dedication: { label: 'Dedication', defaultTitle: 'Dedication', hint: 'Centred, a third of the way down the page.', front: true, start: 'recto' },
  epigraph: { label: 'Epigraph', defaultTitle: 'Epigraph', hint: 'A quotation. Start the attribution line with an em dash (—) or two hyphens.', front: true, start: 'recto' },
  toc: { label: 'Contents', defaultTitle: 'Contents', hint: 'Generated automatically from your parts and chapters, with page numbers.', front: true, start: 'recto' },
  part: { label: 'Part divider', defaultTitle: 'Part One', hint: 'A full page that opens a part. Anything you write here is set below the title.', front: false, start: 'recto' },
  chapter: { label: 'Chapter', defaultTitle: 'Untitled Chapter', hint: '', front: false, start: 'chapter' },
  section: { label: 'Unnumbered chapter', defaultTitle: 'Preface', hint: 'Preface, introduction, afterword, acknowledgements — opens like a chapter but without a number.', front: false, start: 'chapter' },
  about: { label: 'About the author', defaultTitle: 'About the Author', hint: 'Set at the back of the book.', front: false, start: 'recto' },
  index: { label: 'Index', defaultTitle: 'Index', hint: 'Generated from {^term} marks in your text (select a word and press ⌘⇧X), with page numbers. Use {^Term!Subterm} for a subentry.', front: false, start: 'recto' },
  bibliography: { label: 'Bibliography', defaultTitle: 'Bibliography', hint: 'Paste BibTeX (e.g. exported from Zotero). Cite with [@key], [@key, 33], [see @a; @b], [-@key] or @key. Cited works are listed; style is set in Design.', front: false, start: 'chapter' },
};

export const KIND_ORDER: SectionKind[] = ['chapter', 'part', 'section', 'title', 'copyright', 'dedication', 'epigraph', 'toc', 'about', 'bibliography', 'index'];

export const META_KEYS = ['title', 'subtitle', 'author', 'publisher', 'year', 'language'];

export function emptyMeta(): BookMeta {
  return { title: 'Untitled Book', subtitle: '', author: '', publisher: '', year: String(new Date().getFullYear()), language: 'en', extra: {} };
}

export function metaFromFrontMatter(data: Record<string, FMValue>, base: BookMeta = emptyMeta()): BookMeta {
  const meta: BookMeta = { ...base, extra: {} };
  for (const [k, v] of Object.entries(data)) {
    const s = fmString(v);
    switch (k) {
      case 'title': meta.title = s; break;
      case 'subtitle': meta.subtitle = s; break;
      case 'author': case 'authors': case 'by': meta.author = s; break;
      case 'publisher': case 'imprint': meta.publisher = s; break;
      case 'year': case 'date': meta.year = s; break;
      case 'language': case 'lang': meta.language = s || 'en'; break;
      default: meta.extra[k] = s;
    }
  }
  return meta;
}

/** Book metadata lives in the title-page section's YAML front matter. */
export function metaFromTitleContent(content: string, base?: BookMeta): BookMeta {
  const fm = splitFrontMatter(content);
  return metaFromFrontMatter(fm.data, base);
}

export function titleContentFromMeta(meta: BookMeta, existing = ''): string {
  const fm = splitFrontMatter(existing);
  const data: Record<string, FMValue> = {};
  data.title = meta.title;
  if (meta.subtitle) data.subtitle = meta.subtitle;
  data.author = meta.author;
  if (meta.publisher) data.publisher = meta.publisher;
  if (meta.year) data.year = meta.year;
  if (meta.language && meta.language !== 'en') data.language = meta.language;
  for (const [k, v] of Object.entries(meta.extra)) data[k] = v;
  return withFrontMatter(data, fm.present ? fm.body : '', META_KEYS);
}

/** The title shown in the sidebar and the running head. */
export function sectionTitle(s: Section): string {
  if (s.kind === 'title') return 'Title Page';
  const fm = splitFrontMatter(s.content);
  if (fm.data.title) return fmString(fm.data.title);
  const m = /^\s*#\s+(.+?)\s*#*\s*$/m.exec(fm.body.split('\n').find((l) => l.trim()) || '');
  if (m && (s.kind === 'chapter' || s.kind === 'section' || s.kind === 'about' || s.kind === 'part' || s.kind === 'bibliography')) return m[1].replace(/[*_`]/g, '');
  return s.title || 'Untitled';
}

export function plainTitle(meta: BookMeta): string {
  return meta.title.replace(/\s*\n\s*/g, ' ').trim() || 'Untitled Book';
}

export function makeSection(projectId: string, kind: SectionKind, title?: string, content = ''): Section {
  const now = Date.now();
  return { id: uid('s'), projectId, kind, title: title ?? KINDS[kind].defaultTitle, content, createdAt: now, updatedAt: now, words: countWords(content) };
}

export const DEFAULT_COPYRIGHT = `Copyright © {thisYear} {author}

All rights reserved. No part of this book may be reproduced in any form without written permission from the author, except for brief quotations in reviews.

First edition

Typeset in {font} with SerifWriter.`;

export function defaultContent(kind: SectionKind, meta: BookMeta): string {
  switch (kind) {
    case 'title': return titleContentFromMeta(meta);
    case 'copyright': return DEFAULT_COPYRIGHT;
    case 'dedication': return '*For the ones who read the first drafts.*';
    case 'epigraph': return '> We must learn to reawaken and keep ourselves awake, not by mechanical aids, but by an infinite expectation of the dawn.\n>\n> — Henry David Thoreau, *Walden*';
    case 'about': return `${meta.author || 'The author'} lives and writes somewhere quiet. This is their first book.`;
    default: return '';
  }
}

export function newProject(opts: { title?: string; author?: string; templateId?: string } = {}): { project: Project; sections: Section[] } {
  const now = Date.now();
  const id = uid('p');
  const meta = { ...emptyMeta(), title: opts.title || 'Untitled Book', author: opts.author || '' };
  const sections = [
    makeSection(id, 'title', undefined, defaultContent('title', meta)),
    makeSection(id, 'copyright', undefined, DEFAULT_COPYRIGHT),
    makeSection(id, 'toc'),
    makeSection(id, 'chapter', 'Chapter One', ''),
  ];
  const project: Project = {
    id, createdAt: now, updatedAt: now, openedAt: now, deletedAt: null, meta,
    order: sections.map((s) => s.id), templateId: opts.templateId || 'classic', overrides: {}, customCss: '',
    lastSectionId: sections[3].id, words: 0, ui: {},
  };
  return { project, sections };
}

const FIRST_LIGHT = `There is an hour before morning that belongs to no one. The streetlights have not yet given up, and the sky has not yet decided what color it will be. In that hour the world feels unfinished, as though it is waiting to be told what it is. I have spent a great many of those hours awake, and I have come to think of them as the truest part of the day, because nothing in them has been arranged for an audience.

I did not always see it that way. For most of my life the early hour was only a thing to be endured, a gap between the warmth of sleep and the obligations of the day. I filled it with noise. I checked the weather I could already see through the window. I read the news of places I would never visit, written by people who would never know my name. It was only when I stopped filling the silence that I began to hear what it had been trying to say.

What it said was simple, and I resisted it for a long time: *you are allowed to begin again.* Not once, in some grand and final reckoning, but every morning, in small and unremarkable ways. The road behind us is long, and much of it we would not choose to walk a second time. But the road ahead is not yet paved, and the first light falls on it the same as it falls on everyone.

This book is a record of some of those mornings. It is not a map, because I am not sure the country it describes can be mapped. It is closer to a set of notes left at the side of the road by someone who passed this way before you---not to tell you where to go, but to let you know that someone else has stood where you are standing, and that the ground held.

I should say at the outset that I am not a scholar, and I do not write as one. I have read what I could, when I could, often in the margins of other work. Where I have borrowed an idea I have tried to say so, and where I have gotten something wrong I hope the reader will be generous. What I can offer is not authority but attention: the habit, slowly learned, of noticing what is actually in front of me rather than what I was told would be there.

The first thing I noticed, once I began to pay attention, was how much of what I believed I had never actually examined. I had inherited it, the way one inherits a house: the furniture was already in place when I arrived, and it did not occur to me that I was free to move it. Some of it, I would later find, was worth keeping. Some of it was beautiful. And some of it had been blocking the windows.

It is a strange thing to discover that the walls of your own life were built by other hands. There is grief in it, and also a kind of relief. The grief is for the years spent living inside a shape you did not choose. The relief is in knowing that what hands have built, hands can rebuild.

I remember the first morning I understood this clearly. It was not a dramatic morning. There was no storm, no revelation in the sky. I was sitting at a kitchen table with a cup of coffee going cold, watching the window turn from black to grey to the faint gold that comes just before the sun. And I realized, with a clarity that surprised me, that I did not have to believe a single thing simply because I had always believed it. I could look at each one in turn, hold it up to that thin light, and decide for myself whether it was true.
`;

const SECOND = `A notebook is a patient thing. It does not ask what you meant, or whether you are sure. It simply waits, open to the page you left it on, for the next small thing you noticed.[^1]

I began keeping one the winter I moved, mostly because I did not know anyone in the new town and needed somewhere to put the day. At first the entries were lists: what the bakery on the corner sold before seven, which streets the snowplows cleared first, the name of the dog that barked at the post office. Later they became something closer to letters, addressed to no one in particular.

---

The rules I kept were few, and I mention them only because they helped:

1. Write the date, and the hour if you know it.
2. Write what you saw before you write what you thought.
3. Never cross anything out. Draw a line under it and keep going.

Most mornings it came to a paragraph. Some mornings it came to nothing at all, and I wrote *nothing at all* and closed the book, which is also a kind of entry. Reading them back now, I find that the empty days are the ones I remember best.

[^1]: The notebook in question was a cheap one, bought at a railway station, with a cover that has since come away from the spine.
`;

/** The demo book shown on first launch, using the text from the Classic Leather prototype. */
export function sampleProject(): { project: Project; sections: Section[] } {
  const now = Date.now();
  const id = uid('p');
  const meta: BookMeta = {
    title: 'The Road Behind Us', subtitle: 'Essays on Leaving and Arriving', author: 'Your Name',
    publisher: 'Privately Printed', year: 'MMXXVI', language: 'en', extra: {},
  };
  const sections = [
    makeSection(id, 'title', undefined, titleContentFromMeta(meta)),
    makeSection(id, 'copyright', undefined, DEFAULT_COPYRIGHT),
    makeSection(id, 'dedication', undefined, '*For everyone who is still up before the light.*'),
    makeSection(id, 'epigraph', undefined, defaultContent('epigraph', meta)),
    makeSection(id, 'toc'),
    makeSection(id, 'chapter', 'The First Light', FIRST_LIGHT),
    makeSection(id, 'chapter', 'Notes from the Side of the Road', SECOND),
    makeSection(id, 'about', undefined, 'The author lives and writes somewhere quiet, and is usually awake before the light. *The Road Behind Us* is their first book.'),
  ];
  const project: Project = {
    id, createdAt: now, updatedAt: now, openedAt: now, deletedAt: null, meta,
    order: sections.map((s) => s.id), templateId: 'classic', overrides: {}, customCss: '',
    lastSectionId: sections[5].id, words: sections.reduce((n, s) => n + s.words, 0), ui: {},
  };
  return { project, sections };
}
