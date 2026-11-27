import type { ProjectCtx } from './project.ts';
import { h } from './dom.ts';
import { modal } from './dialogs.ts';
import { SYMBOLS } from '../model/symbols.ts';

// Insert symbol (⌘⇧L): logic, philosophy and maths symbols, searchable by name or meaning.

export function openSymbolPicker(ctx: ProjectCtx): void {
  const { editor } = ctx;
  const sel = { a: editor.ta.selectionStart, b: editor.ta.selectionEnd };
  const m = modal('Insert symbol', { wide: true, className: 'find-dlg' });
  const q = h('input', { class: 'input', type: 'text', placeholder: 'Search: and, necessarily, forall, entails…', spellcheck: 'false' }) as HTMLInputElement;
  const grid = h('div', { class: 'sym-grid' });
  const seen = new Set<string>();
  const items = SYMBOLS.filter(([, c]) => !seen.has(c) && seen.add(c));
  const pick = (c: string) => { m.close(); editor.ta.setSelectionRange(sel.a, sel.b); editor.insert(c); };
  const paint = () => {
    const w = q.value.toLowerCase().trim();
    grid.replaceChildren(...items.filter(([n, c, l]) => !w || `${n} ${l} ${c}`.toLowerCase().includes(w) || SYMBOLS.some(([n2, c2]) => c2 === c && n2.toLowerCase().includes(w))).map(([n, c, l]) => {
      const b = h('button', { class: 'sym', type: 'button', title: `${l || n} — type \\${n}` }, h('span', { class: 'sym-c' }, c), h('span', { class: 'sym-n' }, `\\${n}`));
      b.addEventListener('click', () => pick(c));
      return b;
    }));
  };
  q.addEventListener('input', paint);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); (grid.firstElementChild as HTMLElement | null)?.click(); } });
  m.body.append(q, h('p', { class: 'dlg-note' }, 'Or type the name in the text — \\forall then a space gives ∀. Whole formulas read best as math: $\\forall x\\,(Fx \\to Gx)$.'), grid);
  paint();
  // On a phone the keyboard would cover the symbols: search only when asked.
  if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => q.focus(), 0);
}
