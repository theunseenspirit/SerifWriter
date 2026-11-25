import type { BookMeta, HeadingRole, Section, SectionKind, TemplateSettings } from '../model/types.ts';
import { renderMarkdown, renderInline } from '../md/render.ts';
import { splitFrontMatter, fmString } from '../md/frontmatter.ts';
import { ORNAMENT_SETS, sceneBreakHtml, type OrnamentSet } from './ornaments.ts';
import { formatLabel, escapeHtml } from '../util.ts';
import { roundedWords } from '../model/words.ts';
import { FONTS } from './fonts.ts';
import { bibliographyHtml, LABEL, type CiteCtx } from '../md/cite.ts';
import { plainTitle, sectionTitle } from '../model/defaults.ts';
export { sectionTitle };

export interface TocEntry {
  id: string;
  kind: 'part' | 'chapter' | 'section' | 'back';
  title: string; // inline HTML
  plain: string;
}

export interface RenderCtx {
  settings: TemplateSettings;
  meta: BookMeta;
  assetUrl: (id: string) => string | undefined;
  bookWords: number;
  toc: TocEntry[]; // only used when rendering the contents page
  cite: CiteCtx | null;
}

export interface Rendered {
  id: string;
  kind: SectionKind;
  hidden: boolean;
  /** Content for a single fixed page (title page, dedication…). Falls back to flow if it overflows. */
  fixed: HTMLElement | null;
  /** Elements placed directly on the page (frames, corners) rather than in the text block. */
  decor: HTMLElement[];
  opener: HTMLElement | null;
  blocks: HTMLElement[];
  notes: Map<string, HTMLElement>;
  toc: TocEntry[];
  rh: string; // running-head title for pages of this section
  pageClass: string;
}

const h = (tag: string, cls = '', html = ''): HTMLElement => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html) el.innerHTML = html;
  return el;
};

const textOf = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return (d.textContent || '').trim(); };

function fillTokens(text: string, meta: BookMeta, s: TemplateSettings): string {
  return text
    .replace(/\{author\}/g, meta.author || 'the author')
    .replace(/\{title\}/g, plainTitle(meta))
    .replace(/\{year\}/g, meta.year)
    .replace(/\{thisYear\}/g, String(new Date().getFullYear()))
    .replace(/\{publisher\}/g, meta.publisher)
    .replace(/\{font\}/g, FONTS[s.type.body]?.name || 'a serif');
}

function headingRole(el: Element, s: TemplateSettings): HeadingRole | null {
  const m = /^H([1-6])$/.exec(el.tagName);
  if (!m) return null;
  return s.headings[`h${m[1]}` as keyof TemplateSettings['headings']] || 'minor';
}

function opener(kind: 'chapter' | 'section' | 'about' | 'toc', titleHtml: string, sub: string, set: OrnamentSet, s: TemplateSettings, tocId: string): HTMLElement {
  const el = h('header', `opener opener-${kind}${kind === 'about' || kind === 'toc' ? ' opener-small' : ''}`);
  el.dataset.rh = textOf(titleHtml);
  if (tocId) el.dataset.tocId = tocId;
  if (set.headpiece && kind === 'chapter') el.appendChild(h('div', 'op-head', set.headpiece));
  const label = h('div', 'op-label');
  if (kind === 'chapter') { label.dataset.label = 'chapter'; label.textContent = formatLabel(s.chapter.label, 1); }
  el.appendChild(label);
  el.appendChild(h('h1', 'op-title', titleHtml));
  if (sub) el.appendChild(h('div', 'op-sub', sub));
  if (s.chapter.ornament && set.chapter && kind !== 'toc') el.appendChild(h('div', 'op-orn', set.chapter));
  return el;
}

/** Wraps the first N words of a paragraph in a small-caps lead-in span. */
function leadIn(p: HTMLElement, words: number): void {
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let count = 0;
  let started = false;
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const t of nodes) {
    if (count >= words) break;
    if (t.parentElement?.closest('.fn-ref, code')) continue;
    const s = t.data;
    let i = 0;
    let end = s.length;
    let stop = false;
    while (i < s.length) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (i >= s.length) break;
      started = true;
      let j = i;
      while (j < s.length && !/\s/.test(s[j])) j++;
      count++;
      const word = s.slice(i, j);
      if (count >= words || /[.,;:!?—–)]$/.test(word)) { end = j; stop = true; break; }
      i = j;
    }
    if (!started) continue;
    const take = stop ? end : s.length;
    if (take <= 0) continue;
    if (take < s.length) t.splitText(take);
    const span = document.createElement('span');
    span.className = 'lead-in';
    t.replaceWith(span);
    span.appendChild(t);
    if (stop) break;
  }
}

function isPlainParagraph(el: Element): boolean {
  if (el.tagName !== 'P' || el.classList.contains('ind')) return false;
  const text = (el.textContent || '').trim();
  return text.length > 0 && !el.querySelector('img');
}

/** Post-processes rendered Markdown: heading roles, scene breaks, drop caps, figures, notes. */
function processFlow(frag: DocumentFragment, ctx: RenderCtx, sec: Section, set: OrnamentSet, numbered: boolean) {
  const s = ctx.settings;
  const notes = new Map<string, HTMLElement>();
  const fnSection = frag.querySelector('section.footnotes');
  if (fnSection) {
    for (const fn of Array.from(fnSection.querySelectorAll<HTMLElement>('.fn'))) {
      const id = fn.dataset.fn!;
      const num = h('span', 'fn-num', String(Number(id) + 1));
      const firstP = fn.querySelector('p');
      (firstP || fn).prepend(num);
      notes.set(id, fn);
    }
    fnSection.remove();
  }
  for (const img of Array.from(frag.querySelectorAll('img'))) {
    const src = img.getAttribute('src') || '';
    if (src.startsWith('asset:')) {
      const url = ctx.assetUrl(src.slice(6));
      if (url) img.setAttribute('src', url);
      else img.replaceWith(h('span', 'missing-img', `[missing image: ${escapeHtml(img.getAttribute('alt') || src)}]`));
    }
  }

  const blocks: HTMLElement[] = [];
  const toc: TocEntry[] = [];
  let leadTitle: string | null = null;
  let leadSub = '';
  let wantDrop = numbered || sec.kind === 'section';
  let afterBreak = false;
  let n = 0;
  const num = [0, 0];
  const children = Array.from(frag.children) as HTMLElement[];
  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    const role = headingRole(el, s);
    if (role === 'chapter' || role === 'part') {
      const titleHtml = el.innerHTML;
      if (role === 'chapter' && blocks.length === 0 && leadTitle === null && (sec.kind === 'chapter' || sec.kind === 'section' || sec.kind === 'about')) {
        leadTitle = titleHtml; // the section's own title
        const next = children[i + 1];
        if (next && /^H[1-6]$/.test(next.tagName) && headingRole(next, s) === 'subsection') { leadSub = next.innerHTML; i++; }
        continue;
      }
      const id = `${sec.id}:h${++n}`;
      if (role === 'chapter') {
        const op = opener(sec.kind === 'section' ? 'section' : 'chapter', titleHtml, '', set, s, id);
        op.classList.add('force-break');
        blocks.push(op);
        toc.push({ id, kind: sec.kind === 'section' ? 'section' : 'chapter', title: titleHtml, plain: textOf(titleHtml) });
      } else {
        const part = h('div', 'inflow-part fixed-content part-page force-break full-page');
        part.dataset.tocId = id;
        part.dataset.rh = textOf(titleHtml);
        const lbl = h('div', 'pt-label'); lbl.dataset.label = 'part'; lbl.textContent = formatLabel(s.chapter.partLabel, 1);
        part.append(lbl, h('h1', 'pt-title', titleHtml));
        if (set.rule) part.appendChild(h('div', 'pt-orn', set.chapter || set.rule));
        blocks.push(part);
        toc.push({ id, kind: 'part', title: titleHtml, plain: textOf(titleHtml) });
      }
      wantDrop = true;
      afterBreak = false;
      num[0] = num[1] = 0;
      continue;
    }
    if (role) {
      el.classList.add(`h-${role}`);
      if (s.numberHeadings && (role === 'section' || role === 'subsection')) {
        if (role === 'section') { num[0]++; num[1] = 0; } else num[1]++;
        const hn = role === 'section' ? String(num[0]) : `${num[0]}.${num[1]}`;
        const span = h('span', 'h-num', hn + '\u2002');
        span.dataset.hnum = hn;
        el.prepend(span);
      }
      if (role === 'runin') el.classList.add('h-minor');
      blocks.push(el);
      afterBreak = true;
      continue;
    }
    if (el.tagName === 'HR') {
      const sb = h('div', 'scene-break', sceneBreakHtml(s.sceneBreak, set));
      if (el.dataset.line) sb.dataset.line = el.dataset.line;
      blocks.push(sb);
      afterBreak = true;
      continue;
    }
    const figLabel = el.tagName === 'P' && el.children.length === 1 && el.firstElementChild!.tagName === 'IMG' ? /^\s*(?:\{#(fig:[\w:.-]+)\})?\s*$/.exec(el.textContent || '') : null;
    if (figLabel) {
      // ![Caption](image){#fig:label} → "Figure 3. Caption" (an image title, if given, wins)
      const img = el.firstElementChild as HTMLImageElement;
      const fig = h('figure', 'img-fig');
      fig.dataset.line = el.dataset.line || '';
      fig.appendChild(img);
      const n = figLabel[1] && ctx.cite?.refs.get(figLabel[1]);
      const cap = escapeHtml(img.getAttribute('title') || (figLabel[1] ? img.alt : ''));
      if (cap || n) fig.appendChild(h('figcaption', '', `${n ? `<span class="cap-label">Figure ${n}.</span> ` : ''}${cap}`));
      blocks.push(fig);
      continue;
    }
    if (el.tagName === 'P' && (children[i + 1]?.tagName === 'TABLE' || blocks.at(-1)?.tagName === 'TABLE') && /^Table:\s/.test(el.textContent || '')) {
      // "Table: Caption {#tbl:label}" just before or after a table → a numbered caption above it
      const m = LABEL.exec(el.textContent || '');
      const n = m && m[2] === 'tbl' && ctx.cite?.refs.get(m[1]);
      el.innerHTML = `${n ? `<span class="cap-label">Table ${n}.</span> ` : ''}${el.innerHTML.replace(/^\s*Table:\s*/, '').replace(/\s*\{#tbl:[\w:.-]+\}\s*$/, '')}`;
      el.className = 'tbl-cap keep-next';
      if (blocks.at(-1)?.tagName === 'TABLE') blocks.splice(blocks.length - 1, 0, el); else blocks.push(el);
      continue;
    }
    if (isPlainParagraph(el)) {
      if (wantDrop) {
        if (s.dropCap.enabled && /^[\s“"‘'(\[]*[\p{L}\p{N}]/u.test(el.textContent || '')) el.classList.add('dropcap');
        else el.classList.add('first');
        if (s.leadIn.mode === 'words') leadIn(el, s.leadIn.words);
        else if (s.leadIn.mode === 'line') el.classList.add('leadin-line');
        wantDrop = false;
      } else if (afterBreak) {
        el.classList.add('after-break');
        if (s.leadIn.afterBreak) {
          if (s.leadIn.mode === 'words') leadIn(el, Math.min(3, s.leadIn.words));
          else if (s.leadIn.mode === 'line') el.classList.add('leadin-line');
        }
      }
      afterBreak = false;
    } else if (el.tagName !== 'DIV' || !el.classList.contains('force-break')) {
      // blockquotes etc. before the first paragraph keep the drop cap for later
      afterBreak = false;
    }
    blocks.push(el);
  }

  if (s.footnotes === 'endnotes' && notes.size) {
    const en = h('div', 'endnotes');
    en.appendChild(h('div', 'en-title', 'Notes'));
    for (const fn of notes.values()) en.appendChild(fn);
    blocks.push(en);
    notes.clear();
  } else {
    // page-bottom notes reference the number shown in the text
  }
  return { blocks, notes, toc, leadTitle, leadSub };
}

// ───────── Fixed pages ─────────

function titlePage(ctx: RenderCtx, set: OrnamentSet): { content: HTMLElement; decor: HTMLElement[] } {
  const { meta, settings: s } = ctx;
  const tp = s.titlePage;
  if (tp.layout === 'manuscript') {
    const c = h('div', 'fixed-content ms-title-page');
    const author = meta.author || 'Author Name';
    const contact = [meta.extra.legal_name || author, meta.extra.address || meta.extra.contact || '', meta.extra.email || '', meta.extra.phone || '', meta.extra.website || '']
      .filter(Boolean).join('\n');
    c.append(
      h('div', 'ms-contact', escapeHtml(contact)),
      h('div', 'ms-words', `about ${roundedWords(ctx.bookWords)} words`),
      h('div', 'ms-center', `<div class="ms-title">${escapeHtml(plainTitle(meta))}</div>${meta.subtitle ? `<div>${escapeHtml(meta.subtitle)}</div>` : ''}<div>by ${escapeHtml(meta.extra.pen_name || author)}</div>`),
    );
    return { content: c, decor: [] };
  }
  const c = h('div', 'fixed-content title-page');
  const title = escapeHtml(meta.title.trim() || 'Untitled Book');
  c.appendChild(h('div', 'tp-title', title));
  if (set.rule) c.appendChild(h('div', 'tp-rule', set.rule));
  if (meta.subtitle) c.appendChild(h('div', 'tp-subtitle', renderInline(meta.subtitle, meta.language)));
  if (meta.author) {
    c.appendChild(h('div', 'tp-by', 'by'));
    c.appendChild(h('div', 'tp-author', escapeHtml(meta.author)));
  }
  c.appendChild(h('div', 'tp-spacer'));
  if (set.fleuron) c.appendChild(h('div', 'tp-fleuron', set.fleuron));
  if (meta.publisher) c.appendChild(h('div', 'tp-publisher', escapeHtml(meta.publisher)));
  if (meta.year) c.appendChild(h('div', 'tp-year', escapeHtml(meta.year)));
  c.appendChild(h('div', 'tp-foot-gap'));
  const decor: HTMLElement[] = [];
  if (tp.frame !== 'none') decor.push(h('div', `tp-frame tp-frame-${tp.frame}`));
  if (tp.corners && set.corner) for (const pos of ['tl', 'tr', 'bl', 'br']) decor.push(h('div', `tp-corner ${pos}`, set.corner));
  return { content: c, decor };
}

function epigraph(frag: DocumentFragment): void {
  for (const p of Array.from(frag.querySelectorAll('p'))) {
    const t = (p.textContent || '').trim();
    if (/^(—|–|--|―)/.test(t)) {
      p.classList.add('attrib');
      // normalise the leading dash
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      const first = walker.nextNode() as Text | null;
      if (first) first.data = first.data.replace(/^\s*(—|–|--|―)\s*/, '— ');
    }
  }
}

// ───────── Entry point ─────────

export function renderSection(sec: Section, ctx: RenderCtx): Rendered {
  const s = ctx.settings;
  const set = ORNAMENT_SETS[s.ornaments] || ORNAMENT_SETS.classic;
  const lang = ctx.meta.language || 'en';
  const base: Rendered = {
    id: sec.id, kind: sec.kind, hidden: s.hiddenKinds.includes(sec.kind), fixed: null, decor: [], opener: null,
    blocks: [], notes: new Map(), toc: [], rh: '', pageClass: `k-${sec.kind}`,
  };
  const fm = splitFrontMatter(sec.content);
  const lineOffset = fm.lines;

  switch (sec.kind) {
    case 'title': {
      const { content, decor } = titlePage(ctx, set);
      return { ...base, fixed: content, decor };
    }
    case 'copyright': {
      const c = h('div', 'fixed-content copyright-page');
      c.appendChild(renderMarkdown(fillTokens(fm.body, ctx.meta, s), { lang, lineOffset, cite: ctx.cite }));
      return { ...base, fixed: c };
    }
    case 'dedication': {
      const c = h('div', 'fixed-content dedication-page');
      const body = h('div', 'ded-body');
      body.appendChild(renderMarkdown(fm.body, { lang, lineOffset, cite: ctx.cite }));
      c.appendChild(body);
      return { ...base, fixed: c };
    }
    case 'epigraph': {
      const c = h('div', 'fixed-content epigraph-page');
      const frag = renderMarkdown(fm.body, { lang, lineOffset, cite: ctx.cite });
      epigraph(frag);
      c.appendChild(frag);
      return { ...base, fixed: c };
    }
    case 'part': {
      const c = h('div', 'fixed-content part-page');
      const frag = renderMarkdown(fm.body, { lang, lineOffset, cite: ctx.cite });
      let titleHtml = escapeHtml(fmString(fm.data.title) || sec.title);
      const firstHeading = frag.firstElementChild;
      if (firstHeading && /^H[1-6]$/.test(firstHeading.tagName)) { titleHtml = firstHeading.innerHTML; firstHeading.remove(); }
      const lbl = h('div', 'pt-label'); lbl.dataset.label = 'part'; lbl.textContent = formatLabel(s.chapter.partLabel, 1);
      c.append(lbl, h('h1', 'pt-title', titleHtml));
      if (set.chapter || set.rule) c.appendChild(h('div', 'pt-orn', set.chapter || set.rule));
      if (frag.childNodes.length) { const b = h('div', 'pt-body'); b.appendChild(frag); c.appendChild(b); }
      return { ...base, fixed: c, toc: [{ id: sec.id, kind: 'part', title: titleHtml, plain: textOf(titleHtml) }], rh: textOf(titleHtml) };
    }
    case 'toc': {
      const title = escapeHtml(fmString(fm.data.title) || sec.title || 'Contents');
      const op = opener('toc', title, '', set, s, '');
      const blocks: HTMLElement[] = [];
      for (const e of ctx.toc) {
        const row = h('div', `toc-entry toc-${e.kind}`);
        const label = h('span', 'toc-label');
        if (e.kind === 'chapter') label.dataset.tocLabel = e.id;
        row.append(label, h('span', 'toc-title', e.title), h('span', 'toc-leader'));
        const num = h('span', 'toc-num', '0');
        num.dataset.tocRef = e.id;
        row.appendChild(num);
        blocks.push(row);
      }
      return { ...base, opener: op, blocks, rh: textOf(title) };
    }
    case 'bibliography': {
      const title = renderInline(fmString(fm.data.title) || sec.title || 'Bibliography', lang);
      const blocks = (ctx.cite ? bibliographyHtml(ctx.cite) : []).map((html) => h('p', 'bib-entry', html));
      return { ...base, opener: opener('section', title, '', set, s, sec.id), blocks, toc: [{ id: sec.id, kind: 'back', title, plain: textOf(title) }], rh: textOf(title) };
    }
    default: {
      const numbered = sec.kind === 'chapter';
      const frag = renderMarkdown(fm.body, { lang, lineOffset, cite: ctx.cite });
      const flow = processFlow(frag, ctx, sec, set, numbered);
      const titleHtml = fm.data.title ? renderInline(fmString(fm.data.title), lang) : flow.leadTitle ?? escapeHtml(sec.title || 'Untitled');
      const sub = fm.data.subtitle ? renderInline(fmString(fm.data.subtitle), lang) : flow.leadSub;
      const kind = sec.kind === 'about' ? 'about' : numbered ? 'chapter' : 'section';
      const op = opener(kind, titleHtml, sub, set, s, sec.id);
      const own: TocEntry = { id: sec.id, kind: sec.kind === 'about' ? 'back' : numbered ? 'chapter' : 'section', title: titleHtml, plain: textOf(titleHtml) };
      return { ...base, opener: op, blocks: flow.blocks, notes: flow.notes, toc: [own, ...flow.toc], rh: textOf(titleHtml) };
    }
  }
}
