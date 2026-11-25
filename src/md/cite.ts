// Citations: a small BibTeX reader and three styles — author–date
// (Chicago/APA-like), numeric (by first citation) and notes (Chicago notes:
// a full note the first time a work is cited in a chapter, a short note after).
// Pandoc syntax: [@key], [see @key, 33; @other], [-@key] (year only),
// @key (narrative), @key [33].

import { escapeHtml, hashString } from '../util.ts';

export type CiteStyle = 'author-date' | 'numeric' | 'note';
interface Name { family: string; given: string }
export interface BibEntry { key: string; type: string; f: Record<string, string>; names: Name[]; eds: boolean; year: string }
export interface CiteCtx { bib: Map<string, BibEntry>; style: CiteStyle; num: Map<string, number>; order: string[]; key: string }
interface Item { prefix: string; suppress: boolean; key: string; loc: string }

const KEY = String.raw`\w[\w:.#$%&+?<>~/-]*`;
const cleanKey = (k: string) => k.replace(/[^\w]+$/, '');

// ───────── BibTeX ─────────

function fields(s: string): Record<string, string> {
  const f: Record<string, string> = {};
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    const nm = /^([\w:.+-]+)\s*=\s*/.exec(s.slice(i));
    if (!nm) break;
    i += nm[0].length;
    let v = '';
    for (;;) {
      if (s[i] === '{' || s[i] === '"') {
        const close = s[i] === '{' ? '}' : '"';
        let d = 0;
        let j = i + 1;
        for (; j < s.length; j++) {
          const c = s[j];
          if (c === '\\') j++;
          else if (c === '{') d++;
          else if (c === '}' && d > 0) d--;
          else if (c === close && d === 0) break;
        }
        v += s.slice(i + 1, j);
        i = j + 1;
      } else {
        const w = /^[^\s,#}]+/.exec(s.slice(i));
        v += w ? w[0] : '';
        i += w ? w[0].length : 1;
      }
      while (/\s/.test(s[i] ?? '')) i++;
      if (s[i] !== '#') break;
      i++;
      while (/\s/.test(s[i] ?? '')) i++;
    }
    f[nm[1].toLowerCase()] = v.replace(/\s+/g, ' ').trim();
  }
  return f;
}

const ACCENT: Record<string, string> = { '"': '̈', "'": '́', '`': '̀', '^': '̂', '~': '̃', '=': '̄', '.': '̇', c: '̧', v: '̌', u: '̆', H: '̋', k: '̨' };
const SYMBOL: Record<string, string> = { ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'ı' };

/** LaTeX-flavoured BibTeX text → safe HTML. */
export function tex(s = ''): string {
  const t = s
    .replace(/\\([cvuHk])(?:\{(\w)\}|\s+(\w))/g, (_, a, x, y) => (x || y) + ACCENT[a])
    .replace(/\\(["'`^~=.])\s*(?:\{(\w)\}|(\w))/g, (_, a, x, y) => (x || y) + ACCENT[a])
    .replace(/\\(ss|ae|AE|oe|OE|aa|AA|o|O|l|L|i)(?![a-zA-Z])\s?/g, (_, k) => SYMBOL[k])
    .replace(/\\([&%$_#])/g, '$1')
    .replace(/---/g, '—').replace(/--/g, '–').replace(/~/g, ' ')
    .replace(/``/g, '“').replace(/''/g, '”')
    .normalize('NFC');
  return escapeHtml(t)
    .replace(/\\(emph|textit|mkbibemph)\s*\{([^{}]*)\}/g, '<em>$2</em>')
    .replace(/\\textbf\s*\{([^{}]*)\}/g, '<strong>$1</strong>')
    .replace(/\\textsc\s*\{([^{}]*)\}/g, '<span class="sc">$1</span>')
    .replace(/\\[a-zA-Z]+\*?\s*/g, '')
    .replace(/[{}]/g, '');
}

function parseNames(s = ''): Name[] {
  // Protect braced groups ({World Health Organization}, G{\"o}del) while splitting.
  const keep: string[] = [];
  let t = s;
  while (/\{[^{}]*\}/.test(t)) t = t.replace(/\{[^{}]*\}/g, (m) => `\u0000${keep.push(m) - 1}\u0001`);
  const back = (x: string): string => x.replace(/\u0000(\d+)\u0001/g, (_, n) => back(keep[+n]));
  return t.split(/\s+and\s+/i).filter((x) => x.trim()).map((raw) => {
    if (raw.trim() === 'others') return { family: 'others', given: '' };
    const p = raw.split(',').map((x) => x.trim());
    let family: string;
    let given: string;
    if (p.length > 1) { family = p[0]; given = p[p.length - 1]; } else {
      const w = raw.trim().split(/\s+/);
      let k = w.findIndex((x, i) => i > 0 && i < w.length - 1 && /^[a-z]/.test(x));
      if (k < 0) k = w.length - 1;
      family = w.slice(k).join(' ');
      given = w.slice(0, k).join(' ');
    }
    return { family: tex(back(family)), given: tex(back(given)) };
  });
}

export function parseBibtex(src: string): Map<string, BibEntry> {
  const out = new Map<string, BibEntry>();
  const re = /@(\w+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let d = 1;
    let j = re.lastIndex;
    for (; j < src.length && d; j++) { if (src[j] === '{') d++; else if (src[j] === '}') d--; }
    const type = m[1].toLowerCase();
    const body = src.slice(re.lastIndex, j - 1);
    re.lastIndex = j;
    if (type === 'comment' || type === 'string' || type === 'preamble') continue;
    const comma = body.indexOf(',');
    const key = (comma < 0 ? body : body.slice(0, comma)).trim();
    if (!key) continue;
    const f = fields(comma < 0 ? '' : body.slice(comma + 1));
    const authors = parseNames(f.author);
    const year = f.year || (f.date || '').slice(0, 4) || 'n.d.';
    out.set(key, { key, type, f, names: authors.length ? authors : parseNames(f.editor), eds: !authors.length && !!f.editor, year });
  }
  // Same author, same year: 2001a, 2001b.
  const groups = new Map<string, BibEntry[]>();
  for (const e of out.values()) {
    const g = `${e.names.map((n) => n.family).join('|')}#${e.year}`;
    groups.set(g, [...(groups.get(g) || []), e]);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => (a.f.title || '').localeCompare(b.f.title || ''));
    g.forEach((e, i) => { e.year += String.fromCharCode(97 + i); });
  }
  return out;
}

// ───────── Formatting ─────────

const end = (s: string) => (!s || /[.?!]$/.test(s.replace(/<[^>]+>|[”’]/g, '')) ? s : s + '.');
const dash = (s: string) => s.replace(/(\d)\s*-+\s*(\d)/g, '$1–$2');

function nameList(ns: Name[], invertFirst: boolean): string {
  const etal = ns.at(-1)?.family === 'others';
  const xs = (etal ? ns.slice(0, -1) : ns).map((n, i) => (!n.given ? n.family : i === 0 && invertFirst ? `${n.family}, ${n.given}` : `${n.given} ${n.family}`));
  const s = xs.length < 2 ? xs.join('') : xs.length === 2 ? `${xs[0]}${invertFirst && /,/.test(xs[0]) ? ',' : ''} and ${xs[1]}` : `${xs.slice(0, -1).join(', ')}, and ${xs.at(-1)}`;
  return etal ? `${s} et al.` : s;
}

/** "Doe", "Doe and Roe", "Doe et al." — or the title when there is no author. */
function shortName(e: BibEntry): string {
  const n = e.names.filter((x) => x.family !== 'others');
  if (!n.length) return `<em>${tex(e.f.shorttitle || e.f.title || e.key)}</em>`;
  return n.length === 1 && e.names.length === 1 ? n[0].family : n.length === 2 && e.names.length === 2 ? `${n[0].family} and ${n[1].family}` : `${n[0].family} et al.`;
}

function parts(e: BibEntry) {
  const f = e.f;
  const title = tex(f.title);
  const journal = tex(f.journal || f.journaltitle);
  const book = tex(f.booktitle);
  const quoted = !!(journal || book) || /^(article|incollection|inproceedings|inbook|conference|thesis|phdthesis|mastersthesis|online|misc)$/.test(e.type) && !f.publisher;
  const pages = f.pages ? dash(tex(f.pages)) : '';
  let container = '';
  if (journal) container = `<em>${journal}</em>${f.volume ? ` ${tex(f.volume)}` : ''}${f.number || f.issue ? ` (${tex(f.number || f.issue)})` : ''}${pages ? `: ${pages}` : ''}`;
  else if (book) container = `In <em>${book}</em>${f.editor && !e.eds ? `, edited by ${nameList(parseNames(f.editor), false)}` : ''}${pages ? `, ${pages}` : ''}`;
  const thesis = /thesis/.test(e.type) ? (e.type === 'mastersthesis' ? 'Master’s thesis' : tex(f.type) || 'PhD diss.') : '';
  const pub = [thesis, [tex(f.address || f.location), tex(f.publisher || f.school || f.institution || f.organization)].filter(Boolean).join(': ')].filter(Boolean).join(', ') || tex(f.howpublished);
  const link = f.doi ? `https://doi.org/${escapeHtml(f.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, ''))}` : f.url ? escapeHtml(f.url) : '';
  return { title, quoted, container, edition: f.edition ? `${tex(f.edition)}${/^\d+$/.test(f.edition) ? ['th', 'st', 'nd', 'rd'][+f.edition % 10 > 3 || [11, 12, 13].includes(+f.edition % 100) ? 0 : +f.edition % 10] : ''} ed.` : '', pub, link };
}

/** One bibliography entry, as HTML. Notes style puts the year at the end (Chicago notes–bibliography). */
export function bibEntry(e: BibEntry, style: CiteStyle): string {
  const p = parts(e);
  const who = e.names.length ? nameList(e.names, true) + (e.eds ? (e.names.length > 1 ? ', eds' : ', ed') : '') : '';
  const title = p.quoted ? `“${end(p.title)}”` : `<em>${p.title}</em>`;
  const yearEnd = style === 'note';
  const pub = yearEnd && !p.container.startsWith('<em>') ? [p.pub, e.year].filter(Boolean).join(', ') : p.pub;
  const container = yearEnd && p.container.startsWith('<em>') ? p.container.replace(/(: [^:<]*)?$/, ` (${e.year})$1`) : p.container;
  return [who, yearEnd ? '' : e.year, title, container, p.edition, pub, p.link].filter(Boolean).map(end).join(' ');
}

/** A full first note: Given Family, Title (Place: Publisher, Year), 33. */
function noteFull(e: BibEntry, loc: string): string {
  const p = parts(e);
  const who = e.names.length ? nameList(e.names, false) + (e.eds ? (e.names.length > 1 ? ', eds.' : ', ed.') : '') : '';
  const title = p.quoted ? `“${p.title},”` : `<em>${p.title}</em>${p.container || p.pub ? '' : ','}`;
  const pubYear = [p.pub, e.year].filter(Boolean).join(', ');
  const tail = p.container.startsWith('<em>') ? `${p.container.replace(/(: [^:<]*)?$/, ` (${e.year})$1`)}` : [p.container, `(${pubYear})`].filter(Boolean).join(' ');
  return `${who ? who + ', ' : ''}${title} ${tail}${loc ? `, ${loc}` : ''}`.replace(/,\s*,/g, ',');
}

function noteShort(e: BibEntry, loc: string): string {
  const t = tex(e.f.shorttitle || (e.f.title || '').split(/[:.?]/)[0]);
  const title = /article|incollection|inproceedings|inbook/.test(e.type) ? `“${t}”` : `<em>${t}</em>`;
  return `${e.names.length ? shortName(e) + ', ' : ''}${title}${loc ? `, ${loc}` : ''}`;
}

// ───────── markdown-it plugin ─────────

function parseItem(s: string): Item | null {
  const m = new RegExp(String.raw`^\s*((?:[^]*\s)?)(-?)@(${KEY})([^]*)$`).exec(s);
  if (!m) return null;
  const key = cleanKey(m[3]);
  const rest = m[3].slice(key.length) + m[4];
  return { prefix: m[1], suppress: !!m[2], key, loc: dash(escapeHtml(rest.replace(/^[\s,]+/, '').trim())) };
}

function inlineCite(c: CiteCtx, items: Item[], narrative: boolean, env: any): string {
  const missing = (k: string) => `<span class="cite-missing" title="Not in the bibliography">${escapeHtml(k)}?</span>`;
  if (c.style === 'note') {
    env.citeSeen ??= new Set<string>();
    const out = items.map((it) => {
      const e = c.bib.get(it.key);
      if (!e) return missing(it.key);
      const first = !env.citeSeen.has(it.key);
      env.citeSeen.add(it.key);
      return escapeHtml(it.prefix) + (first ? noteFull(e, it.loc) : noteShort(e, it.loc));
    }).join('; ');
    return out;
  }
  if (narrative) {
    const it = items[0];
    const e = c.bib.get(it.key);
    if (!e) return missing(it.key);
    const ref = c.style === 'numeric' ? `[${c.num.get(it.key) ?? '?'}${it.loc ? `, ${it.loc}` : ''}]` : `(${e.year}${it.loc ? `, ${it.loc}` : ''})`;
    return `${shortName(e)} ${ref}`;
  }
  const body = items.map((it) => {
    const e = c.bib.get(it.key);
    if (!e) return escapeHtml(it.prefix) + missing(it.key);
    const core = c.style === 'numeric' ? String(c.num.get(it.key) ?? '?') : it.suppress ? e.year : `${shortName(e)} ${e.year}`;
    return `${escapeHtml(it.prefix)}${core}${it.loc ? `, ${it.loc}` : ''}`;
  }).join(c.style === 'numeric' ? ', ' : '; ');
  return c.style === 'numeric' ? `[${body}]` : `(${body})`;
}

export function citations(md: any): void {
  // The core inline pass, re-done so citations know whether they sit inside a footnote.
  md.core.ruler.at('inline', (state: any) => {
    let depth = 0;
    for (const t of state.tokens) {
      if (t.type === 'footnote_reference_open') depth++;
      else if (t.type === 'footnote_reference_close') depth--;
      else if (t.type === 'inline') { state.env.inNote = depth > 0; state.md.inline.parse(t.content, state.md, state.env, t.children); }
    }
    state.env.inNote = false;
  });
  md.inline.ruler.before('link', 'cite', (state: any, silent: boolean) => {
    const c: CiteCtx | undefined = state.env?.cite;
    if (!c) return false;
    const src: string = state.src.slice(state.pos, state.posMax);
    let items: Item[];
    let len: number;
    let narrative = false;
    if (src[0] === '[') {
      const m = /^\[([^[\]]*@[^[\]]*)\](?![[(:])/.exec(src);
      const parsed = m ? m[1].split(';').map(parseItem) : [];
      if (!m || parsed.some((x) => !x)) return false;
      items = parsed as Item[];
      len = m[0].length;
    } else if (src[0] === '@') {
      if (state.pos > 0 && /\w/.test(state.src[state.pos - 1])) return false;
      const m = new RegExp(`^@(${KEY})`).exec(src);
      const key = m ? cleanKey(m[1]) : '';
      if (!c.bib.has(key)) return false;
      len = 1 + key.length;
      const lm = /^ \[([^[\]@]+)\]/.exec(src.slice(len));
      if (lm) len += lm[0].length;
      items = [{ prefix: '', suppress: false, key, loc: lm ? dash(escapeHtml(lm[1].trim())) : '' }];
      narrative = true;
    } else return false;
    if (!silent) {
      const env = state.env;
      if (c.style === 'note' && !env.inNote) {
        if (narrative) state.push('html_inline', '', 0).content = shortName(c.bib.get(items[0].key)!);
        else state.pending = state.pending.replace(/\s+$/, ''); // the note mark hugs the word
        env.footnotes ??= {};
        env.footnotes.list ??= [];
        const id = env.footnotes.list.length;
        const t = new state.Token('html_inline', '', 0);
        t.content = `<span class="cite">${end(inlineCite(c, items, false, env).replace(/^./, (x) => x.toUpperCase()))}</span>`;
        env.footnotes.list[id] = { content: '', tokens: [t] };
        state.push('footnote_ref', '', 0).meta = { id };
      } else state.push('html_inline', '', 0).content = `<span class="cite">${inlineCite(c, items, narrative, env)}</span>`;
    }
    state.pos += len;
    return true;
  });
}

// ───────── Book-level context ─────────

let lastBib = { text: '', bib: new Map<string, BibEntry>() };

/** Gathers the bibliography and the order works are first cited in. Null when the book has no bibliography. */
export function citeContext(sections: { kind: string; content: string }[], style: CiteStyle = 'author-date'): CiteCtx | null {
  const text = sections.filter((s) => s.kind === 'bibliography').map((s) => s.content).join('\n');
  if (!text.trim()) return null;
  if (lastBib.text !== text) lastBib = { text, bib: parseBibtex(text) };
  const bib = lastBib.bib;
  const order: string[] = [];
  const seen = new Set<string>();
  const scan = new RegExp(String.raw`(?:^|[\s[;(])-?@(${KEY})`, 'g');
  for (const s of sections) {
    if (s.kind === 'bibliography' || !s.content.includes('@')) continue;
    for (const m of s.content.matchAll(scan)) {
      const k = cleanKey(m[1]);
      if (bib.has(k) && !seen.has(k)) { seen.add(k); order.push(k); }
    }
  }
  return { bib, style, order, num: new Map(order.map((k, i) => [k, i + 1])), key: hashString(text + style + order.join(',')) };
}

/** The reference list: cited works (or every work, if nothing is cited yet). */
export function bibliographyHtml(c: CiteCtx): string[] {
  const list = (c.order.length ? c.order : [...c.bib.keys()]).map((k) => c.bib.get(k)!);
  const sortKey = (e: BibEntry) => `${(e.names[0]?.family || e.f.title || '').replace(/<[^>]+>/g, '')} ${e.year}`.toLowerCase();
  if (c.style !== 'numeric') list.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return list.map((e) => (c.style === 'numeric' ? `<span class="bib-num">[${c.num.get(e.key) ?? ''}]</span> ` : '') + bibEntry(e, c.style));
}
