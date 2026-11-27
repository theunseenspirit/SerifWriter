import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import { sanitizeInto } from './sanitize.ts';
import { citations, type CiteCtx } from './cite.ts';
import { math, typesetMath } from './math.ts';
import { indentedLines } from './indent.ts';
import { indexMarks } from './terms.ts';

// CommonMark + GFM (tables, strikethrough, autolinks, task lists) + footnotes,
// with smart typography. Every block carries data-line so the preview can be
// mapped back to the editor.

const QUOTES: Record<string, string> = {
  en: '“”‘’', fr: ['« ', ' »', '‹ ', ' ›'] as any, de: '„“‚‘', es: '«»“”', it: '«»“”', nl: '‘’‚’', sv: '””’’', da: '»«›‹', pl: '„”‚’', ru: '«»„“', pt: '«»“”', cs: '„“‚‘',
};

function taskLists(md: any) {
  md.core.ruler.after('inline', 'task-lists', (state: any) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i];
      if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
      const first = inline.children?.[0];
      const m = first && first.type === 'text' ? /^\[([ xX])\][  ]/.exec(first.content) : null;
      if (!m) continue;
      first!.content = first!.content.slice(m[0].length);
      const box = new state.Token('html_inline', '', 0);
      box.content = `<input type="checkbox" disabled${m[1] !== ' ' ? ' checked' : ''}>`;
      inline.children!.unshift(box);
      tokens[i - 2].attrJoin('class', 'task');
    }
    return false;
  });
}

function lineNumbers(md: any) {
  md.core.ruler.push('source-lines', (state: any) => {
    const offset = (state.env && state.env.lineOffset) || 0;
    for (const t of state.tokens as any[]) {
      if (t.map && t.nesting >= 0 && t.type !== 'inline') t.attrSet('data-line', String(t.map[0] + offset));
    }
    return false;
  });
}

function footnoteRenderers(md: any) {
  const r = md.renderer.rules;
  r.footnote_ref = (tokens: any, idx: number) => {
    const id = tokens[idx].meta.id as number;
    return `<sup class="fn-ref" data-fn="${id}">${id + 1}</sup>`;
  };
  r.footnote_block_open = () => '<section class="footnotes">';
  r.footnote_block_close = () => '</section>';
  r.footnote_open = (tokens: any, idx: number) => `<div class="fn" data-fn="${tokens[idx].meta.id}">`;
  r.footnote_close = () => '</div>';
  r.footnote_anchor = () => '';
  r.footnote_caption = (tokens: any, idx: number) => String(tokens[idx].meta.id + 1);
}

/** With `env.breaks` (the book's "Return starts a new line"), a single line break in a paragraph is kept. */
function lineBreaks(md: any) {
  md.renderer.rules.softbreak = (_tokens: any, _idx: number, options: any, env: any) => (options.breaks || env?.breaks ? '<br>\n' : '\n');
}

const cache = new Map<string, MarkdownIt>();

export function markdown(lang = 'en'): MarkdownIt {
  const key = lang.slice(0, 2).toLowerCase();
  let md = cache.get(key);
  if (md) return md;
  md = new MarkdownIt('default', {
    html: true,
    linkify: true,
    typographer: true,
    breaks: false,
    quotes: QUOTES[key] || QUOTES.en,
  });
  md.use(footnote as any);
  md.use(taskLists);
  md.use(indentedLines);
  md.use(indexMarks);
  md.use(lineNumbers);
  md.use(citations);
  md.use(math);
  footnoteRenderers(md);
  lineBreaks(md);
  // Keep ‘---’ inline as an em dash and ‘--’ as an en dash (typographer default).
  cache.set(key, md);
  return md;
}

/** Renders Markdown to a sanitised DocumentFragment. */
export function renderMarkdown(src: string, opts: { lang?: string; lineOffset?: number; cite?: CiteCtx | null; breaks?: boolean } = {}): DocumentFragment {
  const html = markdown(opts.lang).render(src, { lineOffset: opts.lineOffset || 0, cite: opts.cite || undefined, breaks: !!opts.breaks });
  const frag = sanitizeInto(html);
  if (src.includes('$')) typesetMath(frag);
  return frag;
}

/** Renders inline Markdown (titles, labels) to sanitised HTML. */
export function renderInline(src: string, lang = 'en'): string {
  const frag = sanitizeInto(markdown(lang).renderInline(src));
  if (src.includes('$')) typesetMath(frag);
  const div = document.createElement('div');
  div.appendChild(frag);
  return div.innerHTML;
}
