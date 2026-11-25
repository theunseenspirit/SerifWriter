// Back-of-book index. {^Term} (or {^Term!Subterm}) marks a place in the text;
// it prints nothing. The Index page lists every term alphabetically, and the
// page numbers are filled in when the book is assembled, like the contents.

import { escapeHtml } from '../util.ts';

const MARK = /\{\^([^{}\n]+)\}/g;

export function indexMarks(md: any): void {
  md.inline.ruler.before('emphasis', 'index_mark', (state: any, silent: boolean) => {
    if (state.src.charCodeAt(state.pos) !== 0x7b || state.src.charCodeAt(state.pos + 1) !== 0x5e) return false;
    const m = /^\{\^([^{}\n]+)\}/.exec(state.src.slice(state.pos, state.posMax));
    if (!m) return false;
    if (!silent) state.push('html_inline', '', 0).content = `<span class="idx" data-idx="${escapeHtml(key(m[1]))}"></span>`;
    state.pos += m[0].length;
    return true;
  });
}

/** "Plato ! Republic" → "Plato!Republic" */
const key = (raw: string) => raw.split('!').map((s) => s.trim()).filter(Boolean).slice(0, 2).join('!');

export interface IndexEntry { term: string; subs: string[] }

/** Every marked term, sorted as an index is (case- and accent-insensitive), with its subterms. */
export function indexEntries(texts: string[]): IndexEntry[] {
  const map = new Map<string, Set<string>>();
  for (const t of texts) {
    if (!t.includes('{^')) continue;
    for (const m of t.matchAll(MARK)) {
      const [term, sub] = key(m[1]).split('!');
      if (!term) continue;
      if (!map.has(term)) map.set(term, new Set());
      if (sub) map.get(term)!.add(sub);
    }
  }
  const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
  return [...map].sort((a, b) => cmp(a[0], b[0])).map(([term, subs]) => ({ term, subs: [...subs].sort(cmp) }));
}

/** "3, 4, 5, 9, xii" → "3–5, 9, xii" */
export function pageList(folios: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < folios.length; i++) {
    let j = i;
    while (j + 1 < folios.length && /^\d+$/.test(folios[j]) && +folios[j + 1] === +folios[j] + 1) j++;
    out.push(j > i ? `${folios[i]}–${folios[j]}` : folios[i]);
    i = j;
  }
  return out.join(', ');
}
