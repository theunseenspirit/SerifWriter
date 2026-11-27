import type { ProjectCtx } from './project.ts';
import { h } from './dom.ts';
import { modal, toast } from './dialogs.ts';
import { citeContext } from '../md/cite.ts';

// Insert citation (⌘⇧K): search the bibliography by author, year, title or key.

export function openCitePicker(ctx: ProjectCtx): void {
  const c = citeContext(ctx.session.sections);
  if (!c?.bib.size) { toast('Add a Bibliography section with your BibTeX first (Add ▸ Bibliography).'); return; }
  const { editor } = ctx;
  const sel = { a: editor.ta.selectionStart, b: editor.ta.selectionEnd };
  const m = modal('Insert citation', { wide: true, className: 'find-dlg' });
  const q = h('input', { class: 'input', type: 'search', placeholder: 'Author, year, title or key', spellcheck: 'false', autocapitalize: 'none', autocorrect: 'off', autocomplete: 'off', enterkeyhint: 'search' }) as HTMLInputElement;
  const list = h('ol', { class: 'find-results' });
  const strip = (s: string) => s.replace(/<[^>]+>/g, '');
  const rows = [...c.bib.values()].map((e) => ({ e, text: strip(`${e.key} ${e.names.map((n) => `${n.given} ${n.family}`).join(' ')} ${e.year} ${e.f.title || ''}`).toLowerCase() }));
  const pick = (key: string) => {
    m.close();
    editor.ta.setSelectionRange(sel.a, sel.b);
    editor.insert(`[@${key}]`);
  };
  const paint = () => {
    const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
    list.replaceChildren(...rows.filter((r) => words.every((w) => r.text.includes(w))).slice(0, 100).map(({ e }) => {
      const li = h('li', { tabindex: 0 }, h('span', { class: 'find-sec' }, e.key), h('span', { class: 'find-ctx' }, strip(`${e.names.map((n) => n.family).join(', ')} ${e.year}. ${e.f.title || ''}`).replace(/[{}]/g, '')));
      li.addEventListener('click', () => pick(e.key));
      li.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') pick(e.key); });
      return li;
    }));
  };
  q.addEventListener('input', paint);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); (list.firstElementChild as HTMLElement | null)?.click(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); (list.firstElementChild as HTMLElement | null)?.focus(); }
  });
  m.body.append(q, h('p', { class: 'dlg-note' }, 'Enter inserts [@key]. Add a page after a comma inside the brackets — [@key, 33] — or a prefix: [see @key].'), list);
  paint();
  setTimeout(() => q.focus(), 0);
}
