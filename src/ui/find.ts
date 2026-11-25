import type { ProjectCtx } from './project.ts';
import { h, button } from './dom.ts';
import { modal, toast } from './dialogs.ts';
import { sectionTitle } from '../model/defaults.ts';
import { debounce, escapeHtml } from '../util.ts';

// Find & replace across every section of the book (⌘F).

const MAX = 300;

export async function openFind(ctx: ProjectCtx): Promise<void> {
  await ctx.flush();
  const { session, editor } = ctx;
  const m = modal('Find & replace', { wide: true, className: 'find-dlg' });
  const input = (ph: string) => h('input', { class: 'input', type: 'text', placeholder: ph, spellcheck: 'false' }) as HTMLInputElement;
  const find = input('Find in the whole book');
  const repl = input('Replace with');
  const opt = (label: string) => { const c = h('input', { type: 'checkbox' }) as HTMLInputElement; return [c, h('label', { class: 'ds-toggle' }, c, h('span', null, label))] as const; };
  const [cs, csL] = opt('Match case');
  const [ww, wwL] = opt('Whole words');
  const [rx, rxL] = opt('Regular expression');
  const results = h('ol', { class: 'find-results' });
  const status = h('span', { class: 'find-status' });
  find.value = editor.ta.value.slice(editor.ta.selectionStart, editor.ta.selectionEnd).split('\n')[0];

  const pattern = (): RegExp | null => {
    if (!find.value) return null;
    let src = rx.checked ? find.value : find.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (ww.checked) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
    try { return new RegExp(src, `gu${cs.checked ? '' : 'i'}`); } catch { return null; }
  };

  const search = () => {
    const re = pattern();
    results.replaceChildren();
    if (!re) { status.textContent = find.value && rx.checked ? 'Not a valid regular expression' : ''; return; }
    let n = 0;
    for (const s of session.sections) {
      for (const mt of s.content.matchAll(re)) {
        if (!mt[0]) break;
        if (++n > MAX) continue;
        const a = mt.index!;
        const b = a + mt[0].length;
        const before = s.content.slice(Math.max(0, a - 50), a).replace(/^\S*\s/, '…');
        const after = s.content.slice(b, b + 60);
        const li = h('li', { tabindex: 0 }, h('span', { class: 'find-sec' }, sectionTitle(s)));
        li.appendChild(h('span', { class: 'find-ctx' }));
        (li.lastChild as HTMLElement).innerHTML = `${escapeHtml(before)}<mark>${escapeHtml(mt[0])}</mark>${escapeHtml(after)}`.replace(/\n+/g, ' ¶ ');
        const go = () => {
          m.close();
          ctx.select(s.id);
          requestAnimationFrame(() => { editor.goToLine(s.content.slice(0, a).split('\n').length - 1); editor.ta.setSelectionRange(a, b); });
        };
        li.addEventListener('click', go);
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        results.appendChild(li);
      }
    }
    status.textContent = n ? `${n.toLocaleString()} match${n > 1 ? 'es' : ''}${n > MAX ? ` (showing ${MAX})` : ''}` : 'No matches';
  };

  const replaceAll = async () => {
    const re = pattern();
    if (!re) return;
    await ctx.flush();
    const changed = session.sections.filter((s) => { re.lastIndex = 0; return re.test(s.content); });
    if (!changed.length) return;
    await ctx.snapshot(`Before replacing “${find.value}”`);
    let n = 0;
    for (const s of changed) {
      const next = s.content.replace(re, (...args) => { n++; return rx.checked ? repl.value.replace(/\$(\d)/g, (_, i) => args[+i] ?? '') : repl.value; });
      session.setContent(s.id, next);
    }
    const cur = session.byId.get(ctx.currentId() || '');
    if (cur) editor.load(cur);
    ctx.book.updateSections(session.project, session.sections, changed.map((s) => s.id));
    m.close();
    toast(`Replaced ${n.toLocaleString()} in ${changed.length} section${changed.length > 1 ? 's' : ''}. A version was saved first.`, { kind: 'success' });
  };

  const run = debounce(search, 150);
  for (const el of [find, cs, ww, rx]) el.addEventListener('input', run);
  find.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); (results.firstElementChild as HTMLElement | null)?.click(); } });
  m.body.append(h('div', { class: 'find-row' }, find, repl), h('div', { class: 'find-opts' }, csL, wwL, rxL, status), results);
  m.footer.append(button('Close', { onClick: () => m.close() }), button('Replace all', { class: 'primary', onClick: () => void replaceAll() }));
  search();
  setTimeout(() => { find.focus(); find.select(); }, 0);
}
