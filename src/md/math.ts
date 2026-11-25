// TeX math: $inline$ and $$display$$, set as MathML (which browsers render
// natively). The TeX→MathML engine (Temml) is loaded only for books that use it.

import { escapeHtml } from '../util.ts';

let temml: { renderToString: (tex: string, o: object) => string } | null = null;
export const mathReady = () => !!temml;
/** Loads the engine if any text could hold math. Resolves true if it was newly loaded. */
export async function loadMath(texts: string[] = ['$']): Promise<boolean> {
  if (temml || !texts.some((t) => t.includes('$'))) return false;
  temml = (await import('temml')).default as any;
  return true;
}

export function math(md: any): void {
  md.inline.ruler.after('escape', 'math', (state: any, silent: boolean) => {
    const src: string = state.src;
    const p = state.pos;
    if (src[p] !== '$') return false;
    const d = src[p + 1] === '$' ? '$$' : '$';
    const start = p + d.length;
    if (d === '$' && /\s/.test(src[start] ?? ' ')) return false; // "$ 5"
    let end = start;
    while ((end = src.indexOf(d, end)) !== -1 && src[end - 1] === '\\') end++;
    if (end <= start || end > state.posMax) return false;
    if (d === '$' && (/\s/.test(src[end - 1]) || /\d/.test(src[end + 1] ?? ''))) return false; // "$5 and $10"
    const label = d === '$$' ? /^[ \t]*\{#(eq:[\w:.-]+)\}/.exec(src.slice(end + 2, state.posMax)) : null;
    if (!silent) { const t = state.push('math', '', 0); t.content = src.slice(start, end).trim(); t.markup = d; t.info = label?.[1] || ''; }
    state.pos = end + d.length + (label ? label[0].length : 0);
    return true;
  });
  md.renderer.rules.math = (tokens: any, idx: number, _o: unknown, env: any) => {
    const t = tokens[idx];
    const n = t.info && env?.cite?.refs.get(t.info);
    return `<span class="math${t.markup === '$$' ? ' math-display' : ''}" data-tex="${escapeHtml(t.content + (n ? ` \\tag{${n}}` : ''))}"></span>`;
  };
}

/** Fills sanitised math placeholders with MathML; a paragraph holding only display math becomes an unbreakable block. */
export function typesetMath(root: DocumentFragment): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.math[data-tex]'))) {
    const tex = el.dataset.tex!;
    const display = el.classList.contains('math-display');
    if (!temml) { el.textContent = display ? `$$${tex}$$` : `$${tex}$`; continue; }
    try { el.innerHTML = temml.renderToString(tex, { displayMode: display, throwOnError: true }); }
    catch (e: any) { el.textContent = tex; el.classList.add('math-error'); el.title = String(e.message || e); }
    const p = el.parentElement;
    if (display && p?.tagName === 'P' && p.childNodes.length === 1) {
      const div = document.createElement('div');
      div.className = 'math-block sw-atomic';
      if (p.dataset.line) div.dataset.line = p.dataset.line;
      p.replaceWith(div);
      div.appendChild(el);
    }
  }
}
