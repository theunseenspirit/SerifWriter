import type { Project, Section, TemplateSettings } from '../model/types.ts';
import { renderSection } from '../typeset/sections.ts';
import { effectiveSettings } from '../templates/index.ts';
import { formatLabel, escapeHtml } from '../util.ts';
import { plainTitle } from '../model/defaults.ts';
import * as repo from '../db/repo.ts';
import { citeContext } from '../md/cite.ts';
import { loadMath } from '../md/math.ts';

// Shared preparation for the reflowable formats (EPUB, DOCX, HTML).

export interface FlowSection {
  id: string;
  kind: Section['kind'];
  label: string; // "Chapter One", "Part Two", ""
  titleHtml: string;
  titleText: string;
  subtitleHtml: string;
  body: HTMLElement; // a <div> holding the section's blocks
  notes: { id: string; el: HTMLElement }[];
}

export interface BookData {
  project: Project;
  settings: TemplateSettings;
  sections: FlowSection[];
  assets: Map<string, { blob: Blob; type: string; name: string }>;
  title: string;
}

export async function collectBook(project: Project, all: Section[]): Promise<BookData> {
  const settings = effectiveSettings(project);
  await loadMath(all.map((x) => x.content));
  // Reflowable formats always get footnotes as notes, never page-bottom layout.
  const s: TemplateSettings = { ...settings, footnotes: 'page' };
  const assets = new Map<string, { blob: Blob; type: string; name: string }>();
  for (const a of await repo.listAssets(project.id)) assets.set(a.id, { blob: a.blob, type: a.type, name: a.name });
  const urls = new Map<string, string>();
  const words = all.reduce((n, x) => n + (x.kind === 'title' || x.kind === 'toc' ? 0 : x.words), 0);
  const ctx = { settings: s, meta: project.meta, assetUrl: (id: string) => { if (!assets.has(id)) return undefined; urls.set(id, `asset-export:${id}`); return `asset-export:${id}`; }, bookWords: words, toc: [], cite: citeContext(all.filter((x) => !settings.hiddenKinds.includes(x.kind)), settings.citations), index: [] };
  const out: FlowSection[] = [];
  let chapter = 0;
  let part = 0;
  for (const sec of all) {
    if (settings.hiddenKinds.includes(sec.kind) || sec.kind === 'toc' || sec.kind === 'index') continue; // page numbers mean nothing in reflowable formats
    const r = renderSection(sec, ctx);
    const body = document.createElement('div');
    let label = '';
    let titleHtml = '';
    let subtitleHtml = '';
    if (r.fixed) {
      if (sec.kind === 'part') {
        label = formatLabel(settings.chapter.partLabel, ++part);
        titleHtml = r.fixed.querySelector('.pt-title')?.innerHTML || escapeHtml(sec.title);
        const pb = r.fixed.querySelector('.pt-body');
        if (pb) body.append(...Array.from(pb.childNodes));
      } else if (sec.kind === 'title') {
        titleHtml = escapeHtml(plainTitle(project.meta));
      } else {
        body.append(...Array.from(r.fixed.childNodes));
        if (sec.kind === 'dedication') { const d = body.querySelector('.ded-body'); if (d) body.replaceChildren(...Array.from(d.childNodes)); }
      }
    }
    if (r.opener) {
      if (sec.kind === 'chapter') label = formatLabel(settings.chapter.label, ++chapter);
      titleHtml = r.opener.querySelector('.op-title')?.innerHTML || '';
      subtitleHtml = r.opener.querySelector('.op-sub')?.innerHTML || '';
    }
    for (const b of r.blocks) body.appendChild(b);
    // in-flow chapter/part headings get their numbers too
    for (const lbl of Array.from(body.querySelectorAll<HTMLElement>('[data-label]'))) lbl.textContent = lbl.dataset.label === 'chapter' ? formatLabel(settings.chapter.label, ++chapter) : formatLabel(settings.chapter.partLabel, ++part);
    for (const hn of Array.from(body.querySelectorAll<HTMLElement>('.h-num'))) hn.textContent = sec.kind === 'chapter' ? `${chapter}.${hn.dataset.hnum}\u2002` : hn.dataset.hnum + '\u2002';
    for (const el of Array.from(body.querySelectorAll('[data-line]'))) el.removeAttribute('data-line');
    const tmp = document.createElement('div');
    tmp.innerHTML = titleHtml;
    out.push({ id: sec.id, kind: sec.kind, label, titleHtml, titleText: (tmp.textContent || '').trim(), subtitleHtml, body, notes: [...r.notes.entries()].map(([id, el]) => ({ id, el })) });
  }
  return { project, settings, sections: out, assets, title: plainTitle(project.meta) };
}

export const xmlEscape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

export function extFor(type: string): string {
  return ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif' } as Record<string, string>)[type] || 'bin';
}

export async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A reflowable stylesheet that carries the template's character (EPUB/HTML). */
export function reflowCss(s: TemplateSettings, fontFamilies: { body: string; display: string }, opts: { screen?: boolean } = {}): string {
  const lh = (1.2 * s.type.leading).toFixed(3);
  const caps = (sp: number) => `text-transform: uppercase; letter-spacing: ${sp}em;`;
  const spaced = s.ornaments === 'classic' || s.ornaments === 'victorian';
  return `
body { font-family: ${fontFamilies.body}; line-height: ${lh}; color: ${s.color.ink}; ${opts.screen ? `background: ${s.color.paper}; margin: 0;` : ''}
  font-variant-numeric: ${s.type.oldstyleNums ? 'oldstyle-nums' : 'normal'}; font-kerning: normal; font-variant-ligatures: common-ligatures; }
${opts.screen ? `main { max-width: 34em; margin: 0 auto; padding: 8vh 1.5em 20vh; font-size: ${Math.max(17, s.type.size * 1.6).toFixed(1)}px; }
section.chapter, section.part, section.front { margin-bottom: 6em; }` : ''}
p { margin: 0; text-indent: ${s.type.paragraphStyle === 'block' ? 0 : s.type.indent}em; text-align: ${s.type.justify ? 'justify' : 'left'}; ${s.type.paragraphStyle === 'block' ? 'margin-bottom: .7em;' : ''} -webkit-hyphens: ${s.type.hyphenate ? 'auto' : 'manual'}; hyphens: ${s.type.hyphenate ? 'auto' : 'manual'}; }
h1 + p, header + p, .scene-break + p, p.first, p.dropcap, p.after-break, blockquote p, figure + p, ul + p, ol + p, h2 + p, h3 + p, h4 + p { text-indent: 0; }
header.opener { text-align: center; margin: 3em 0 2.4em; ${opts.screen ? '' : 'page-break-before: always; break-before: page;'} }
.op-label { font-family: ${fontFamilies.display}; color: ${s.color.accent}; ${spaced ? caps(0.18) : ''} font-size: .9em; margin: 0 0 .6em; }
h1 { font-family: ${fontFamilies.display}; font-weight: normal; font-size: 1.6em; line-height: 1.25; margin: 0; ${spaced ? caps(0.12) : ''} }
.op-sub { font-style: italic; margin-top: .5em; }
.orn { color: ${s.color.accent}; }
.op-orn svg { width: 9em; height: auto; margin-top: .8em; }
.scene-break { text-align: center; margin: 1em 0; color: ${s.color.accent}; text-indent: 0; }
.scene-break svg { height: 1em; width: auto; }
.lead-in { font-variant: small-caps; letter-spacing: .03em; }
p.leadin-line::first-line { font-variant: small-caps; }
p.dropcap::first-letter { ${s.dropCap.enabled ? `float: left; font-family: ${fontFamilies.display}; font-size: ${(s.dropCap.lines * 1.02).toFixed(2)}em; line-height: .82; margin: .06em .08em 0 0; color: ${s.color.accent};` : ''} }
blockquote { margin: .8em 1.5em; font-size: .95em; }
h2, h3, h4, h5, h6 { font-family: ${fontFamilies.display}; font-weight: normal; margin: 1.4em 0 .6em; text-align: center; font-size: 1em; }
.h-section { ${caps(0.12)} font-size: .9em; }
.h-subsection { font-style: italic; }
.h-minor, .h-runin { text-align: left; font-variant: small-caps; }
ul, ol { margin: .6em 0; padding-left: 1.6em; }
li.task { list-style: none; }
table { border-collapse: collapse; width: 100%; margin: .8em 0; font-size: .9em; }
th, td { border-bottom: 1px solid #bbb; padding: .25em .4em; text-align: left; }
th { font-variant: small-caps; border-bottom: 1.5px solid ${s.color.ink}; font-weight: normal; }
pre { font-size: .8em; white-space: pre-wrap; margin: .6em 0; padding: .4em .6em; border-left: 2px solid #ccc; }
code { font-family: Menlo, Consolas, monospace; font-size: .88em; }
figure { margin: 1em 0; text-align: center; }
figure img, img { max-width: 100%; height: auto; }
figcaption { font-size: .85em; font-style: italic; margin-top: .4em; }
a { color: inherit; }
.bib-entry { text-indent: -2em; padding-left: 2em; text-align: left; margin-bottom: .4em; }
.sc { font-variant: small-caps; }
.abbr { font-variant: all-small-caps; letter-spacing: .04em; }
p.ind { text-indent: 0; text-align: left; } p.ind1 { margin-left: 2em; } p.ind2 { margin-left: 4em; } p.ind3 { margin-left: 6em; } p.ind4 { margin-left: 8em; }
.tbl-cap { text-indent: 0; text-align: center; font-size: .85em; }
.cap-label { font-style: normal; font-variant: small-caps; }
math { font-family: 'STIX Two Math', 'Cambria Math', math; }
.math-block { text-align: center; margin: .5em 0; }
sup.fn-ref, a.noteref { font-size: .7em; vertical-align: super; line-height: 0; text-decoration: none; }
.footnotes { margin-top: 2.5em; font-size: .85em; border-top: 1px solid #ccc; padding-top: .8em; }
.footnotes p, aside.fn p { text-indent: 0; margin: 0 0 .5em; }
.fn-num { font-size: .8em; vertical-align: super; margin-right: .3em; line-height: 0; }
section.front { text-align: center; }
section.front p { text-indent: 0; text-align: center; }
.title-page { text-align: center; margin: 4em 0; }
.title-page .tp-title { font-family: ${fontFamilies.display}; font-size: 2em; line-height: 1.25; ${spaced ? caps(0.14) : ''} white-space: pre-line; }
.title-page .tp-subtitle { font-style: italic; margin-top: 1em; }
.title-page .tp-author { margin-top: 3em; ${spaced ? caps(0.14) : 'font-variant: small-caps;'} }
.title-page .tp-publisher { margin-top: 4em; font-size: .85em; ${spaced ? caps(0.14) : ''} }
.copyright { font-size: .8em; margin-top: 50%; }
.copyright p { text-indent: 0; text-align: left; margin-bottom: .6em; }
.dedication { margin-top: 30%; font-style: italic; }
.epigraph { margin: 30% 1.5em 0; }
.epigraph p { font-style: italic; text-indent: 0; text-align: left; }
.epigraph p.attrib { font-style: normal; text-align: right; margin-top: .5em; }
section.part { text-align: center; ${opts.screen ? '' : 'page-break-before: always;'} padding-top: 30%; }
section.part .op-label { margin-bottom: 1em; }
.part-body p { text-align: center; text-indent: 0; font-style: italic; margin-top: 2em; }
`;
}
