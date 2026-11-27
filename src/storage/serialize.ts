import type { Project, Section, SectionKind } from '../model/types.ts';
import { splitFrontMatter, withFrontMatter, fmString, type FMValue } from '../md/frontmatter.ts';
import { KINDS, emptyMeta, makeSection, metaFromFrontMatter, metaFromTitleContent, titleContentFromMeta, DEFAULT_COPYRIGHT, sectionTitle } from '../model/defaults.ts';
import { safeFilename, uid } from '../util.ts';
import { countWords } from '../model/words.ts';
import { looksHardWrapped } from '../md/render.ts';

// Plain-text representation of a book: one Markdown file per section with YAML
// front matter (`type`, `title`), plus project.json for order and settings.
// Used by the folder mirror, zip backups and imports.

export interface ProjectFile {
  format: 'serifwriter-project';
  version: 1;
  id: string;
  meta: Project['meta'];
  templateId: string;
  overrides: Project['overrides'];
  customCss: string;
  createdAt: number;
  updatedAt: number;
  goal?: number;
  stats?: Project['stats'];
  sections: { id: string; kind: SectionKind; title: string; file: string; createdAt: number; updatedAt: number }[];
}

const KIND_SET = new Set(Object.keys(KINDS));

export function sectionFilename(index: number, s: Section): string {
  return `${String(index + 1).padStart(2, '0')} ${safeFilename(sectionTitle(s))}.md`;
}

export function sectionToMarkdown(s: Section): string {
  const fm = splitFrontMatter(s.content);
  if (s.kind === 'title') return withFrontMatter({ type: 'title', ...fm.data }, fm.body, ['type', 'title', 'subtitle', 'author']);
  const data: Record<string, FMValue> = { type: s.kind, title: s.title, ...fm.data };
  return withFrontMatter(data, fm.body.replace(/^\n+/, ''), ['type', 'title']);
}

export function sectionFromMarkdown(text: string, projectId: string, fallbackTitle: string, existing?: Partial<Section>): Section {
  const fm = splitFrontMatter(text.replace(/\r\n?/g, '\n'));
  const type = fmString(fm.data.type).toLowerCase();
  const kind = (KIND_SET.has(type) ? type : 'chapter') as SectionKind;
  const rest = { ...fm.data };
  delete rest.type;
  let title = fallbackTitle;
  if (kind !== 'title') {
    if (rest.title) title = fmString(rest.title);
    delete rest.title;
  }
  const content = Object.keys(rest).length ? withFrontMatter(rest, fm.body) : fm.body.replace(/^\n+/, '');
  const s = makeSection(projectId, kind, title || KINDS[kind].defaultTitle, content);
  if (existing?.id) s.id = existing.id;
  if (existing?.createdAt) s.createdAt = existing.createdAt;
  if (existing?.updatedAt) s.updatedAt = existing.updatedAt;
  s.words = countWords(content);
  return s;
}

export function projectToFiles(project: Project, sections: Section[]): { json: ProjectFile; files: { name: string; text: string; id: string }[] } {
  const files = sections.map((s, i) => ({ id: s.id, name: sectionFilename(i, s), text: sectionToMarkdown(s) }));
  const json: ProjectFile = {
    format: 'serifwriter-project', version: 1, id: project.id, meta: project.meta, templateId: project.templateId,
    overrides: project.overrides, customCss: project.customCss, createdAt: project.createdAt, updatedAt: project.updatedAt, goal: project.goal, stats: project.stats,
    sections: sections.map((s, i) => ({ id: s.id, kind: s.kind, title: s.title, file: files[i].name, createdAt: s.createdAt, updatedAt: s.updatedAt })),
  };
  return { json, files };
}

/** Rebuilds a project from project.json and the text of its files. */
export function projectFromFiles(json: ProjectFile | null, files: Map<string, string>, folderName = 'Imported Book'): { project: Project; sections: Section[] } {
  const now = Date.now();
  const id = json?.id || uid('p');
  let sections: Section[] = [];
  if (json) {
    for (const e of json.sections) {
      const text = files.get(e.file);
      if (text === undefined) continue;
      const s = sectionFromMarkdown(text, id, e.title, e);
      if (s.kind !== e.kind && !/^---/.test(text)) s.kind = e.kind;
      sections.push(s);
    }
    // .md files added to the folder by hand are appended
    const known = new Set(json.sections.map((e) => e.file));
    for (const name of [...files.keys()].sort()) if (!known.has(name)) sections.push(sectionFromMarkdown(files.get(name)!, id, titleFromFilename(name)));
  } else {
    for (const name of [...files.keys()].sort()) sections.push(sectionFromMarkdown(files.get(name)!, id, titleFromFilename(name)));
  }
  const titleSec = sections.find((s) => s.kind === 'title');
  const meta = titleSec ? metaFromTitleContent(titleSec.content, json?.meta || { ...emptyMeta(), title: folderName }) : json?.meta || { ...emptyMeta(), title: folderName };
  if (!titleSec) sections.unshift(makeSection(id, 'title', undefined, titleContentFromMeta(meta)));
  const project: Project = {
    id, createdAt: json?.createdAt || now, updatedAt: json?.updatedAt || now, openedAt: now, deletedAt: null, meta,
    order: sections.map((s) => s.id), templateId: json?.templateId || 'classic',
    overrides: json?.overrides || (looksHardWrapped(sections.map((s) => s.content)) ? { type: { lineBreaks: false } } : {}),
    customCss: json?.customCss || '', lastSectionId: sections.find((s) => s.kind === 'chapter')?.id || sections[0]?.id || null,
    words: sections.reduce((n, s) => n + (s.kind === 'title' ? 0 : s.words), 0), ui: {}, goal: json?.goal, stats: json?.stats,
  };
  return { project, sections };
}

export function titleFromFilename(name: string): string {
  return name.replace(/\.(md|markdown|txt)$/i, '').replace(/^\d+[\s._-]*/, '').trim() || 'Untitled';
}

/**
 * Imports a single Markdown manuscript: YAML front matter → book details,
 * then the text is split into chapters at `#` headings (`##` if there are no `#`).
 */
export function projectFromSingleMarkdown(text: string, filename: string): { project: Project; sections: Section[] } {
  const src = text.replace(/\r\n?/g, '\n');
  const fm = splitFrontMatter(src);
  const id = uid('p');
  const meta = metaFromFrontMatter(fm.data, { ...emptyMeta(), title: titleFromFilename(filename) });
  const lines = fm.body.split('\n');
  let inFence = false;
  const isHeading = (lvl: number) => (l: string) => new RegExp(`^#{${lvl}}\\s+\\S`).test(l) && !new RegExp(`^#{${lvl + 1}}`).test(l);
  const fenced = lines.map((l) => { if (/^(```|~~~)/.test(l)) inFence = !inFence; return inFence; });
  const level = lines.some((l, i) => !fenced[i] && isHeading(1)(l)) ? 1 : lines.some((l, i) => !fenced[i] && isHeading(2)(l)) ? 2 : 0;
  const chunks: { title: string; body: string[] }[] = [];
  let cur: { title: string; body: string[] } | null = null;
  lines.forEach((l, i) => {
    if (level && !fenced[i] && isHeading(level)(l)) {
      cur = { title: l.replace(/^#+\s+/, '').replace(/\s+#+\s*$/, ''), body: [] };
      chunks.push(cur);
    } else {
      if (!cur) { cur = { title: '', body: [] }; chunks.push(cur); }
      cur.body.push(l);
    }
  });
  const sections: Section[] = [makeSection(id, 'title', undefined, titleContentFromMeta(meta)), makeSection(id, 'copyright', undefined, DEFAULT_COPYRIGHT), makeSection(id, 'toc')];
  for (const c of chunks) {
    const body = c.body.join('\n').trim();
    if (!c.title && !body) continue;
    const lower = c.title.toLowerCase();
    const kind: SectionKind = /^(dedication)$/.test(lower) ? 'dedication' : /^(about the author)$/.test(lower) ? 'about' : /^(preface|foreword|introduction|prologue|epilogue|afterword|acknowledg(e)?ments)$/.test(lower) ? 'section' : /^part\b/.test(lower) ? 'part' : 'chapter';
    sections.push(makeSection(id, kind, c.title || 'Opening', body ? body + '\n' : ''));
  }
  if (sections.length === 3) sections.push(makeSection(id, 'chapter', 'Chapter One', ''));
  const now = Date.now();
  const project: Project = {
    id, createdAt: now, updatedAt: now, openedAt: now, deletedAt: null, meta, order: sections.map((s) => s.id), templateId: 'classic',
    // Markdown wrapped at a fixed width means its line breaks are not new lines.
    overrides: looksHardWrapped([fm.body]) ? { type: { lineBreaks: false } } : {}, customCss: '', lastSectionId: sections[3]?.id ?? null, words: sections.reduce((n, s) => n + s.words, 0), ui: {},
  };
  return { project, sections };
}
