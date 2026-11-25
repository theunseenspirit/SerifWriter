import type { Section, SectionKind } from '../model/types.ts';
import { h, icon } from './dom.ts';
import { showMenu, type MenuItem } from './dialogs.ts';
import { KINDS, KIND_ORDER, sectionTitle } from '../model/defaults.ts';
import { fmtNum } from '../util.ts';

// The book's sections in order. Drag to reorder (or Alt+↑/↓), right-click or
// "…" for options.

export interface SidebarOptions {
  onSelect: (id: string) => void;
  onReorder: (ids: string[]) => void;
  onAdd: (kind: SectionKind, afterId: string | null) => void;
  onRename: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onKind: (id: string, kind: SectionKind) => void;
}

const KIND_GLYPH: Record<SectionKind, string> = {
  title: 'T', copyright: '©', dedication: 'D', epigraph: '“', toc: '≡', part: 'P', chapter: '', section: '§', about: 'A', bibliography: 'B',
};

export class Sidebar {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private totals: HTMLElement;
  private sections: Section[] = [];
  private active: string | null = null;
  private hidden = new Set<SectionKind>();
  private dragId: string | null = null;
  private opts: SidebarOptions;

  constructor(opts: SidebarOptions) {
    this.opts = opts;
    this.list = h('ol', { class: 'sb-list', role: 'listbox', 'aria-label': 'Sections' });
    this.totals = h('div', { class: 'sb-totals' });
    const add = h('button', { class: 'btn sb-add', type: 'button' }, icon('plus', 16), h('span', null, 'Add'));
    add.addEventListener('click', () => this.addMenu(add, this.active));
    this.el = h('aside', { class: 'sidebar' },
      h('div', { class: 'sb-head' }, h('span', null, 'Contents'), add),
      this.list, this.totals);
    this.list.addEventListener('dragover', (e) => this.onDragOver(e));
    this.list.addEventListener('drop', (e) => this.onDrop(e));
  }

  setHidden(kinds: SectionKind[]): void { this.hidden = new Set(kinds); }

  render(sections: Section[], active: string | null, totals: { words: number; today: number; pages: number }): void {
    this.sections = sections;
    this.active = active;
    let chapterNo = 0;
    const rows = sections.map((s) => {
      const isChapter = s.kind === 'chapter';
      if (isChapter) chapterNo++;
      const glyph = isChapter ? String(chapterNo) : KIND_GLYPH[s.kind];
      const more = h('button', { class: 'btn icon sb-more', type: 'button', 'aria-label': 'Section options', tabindex: '-1' }, icon('more', 16));
      const li = h('li', {
        class: `sb-item k-${s.kind} ${s.id === active ? 'on' : ''} ${this.hidden.has(s.kind) ? 'hidden-kind' : ''}`,
        draggable: 'true', role: 'option', 'aria-selected': String(s.id === active), tabindex: s.id === active ? '0' : '-1',
        title: this.hidden.has(s.kind) ? `${KINDS[s.kind].label} — not shown in this template` : KINDS[s.kind].label,
      },
      h('span', { class: 'sb-glyph' }, glyph),
      h('span', { class: 'sb-title' }, sectionTitle(s)),
      s.kind !== 'title' && s.kind !== 'toc' ? h('span', { class: 'sb-words' }, s.words ? fmtNum(s.words) : '') : h('span', { class: 'sb-words' }),
      more);
      li.dataset.id = s.id;
      li.addEventListener('click', (e) => { if (!more.contains(e.target as Node)) this.opts.onSelect(s.id); });
      li.addEventListener('contextmenu', (e) => { e.preventDefault(); this.itemMenu({ x: e.clientX, y: e.clientY }, s); });
      more.addEventListener('click', (e) => { e.stopPropagation(); this.itemMenu(more, s); });
      li.addEventListener('keydown', (e) => this.onKey(e, s));
      li.addEventListener('dragstart', (e) => { this.dragId = s.id; li.classList.add('dragging'); e.dataTransfer!.effectAllowed = 'move'; e.dataTransfer!.setData('text/plain', s.id); });
      li.addEventListener('dragend', () => { this.dragId = null; li.classList.remove('dragging'); this.clearDrop(); });
      return li;
    });
    this.list.replaceChildren(...rows);
    this.totals.replaceChildren(
      h('div', { class: 'sb-total-main' }, h('strong', null, fmtNum(totals.words)), ' words'),
      h('div', { class: 'sb-total-sub' }, totals.today > 0 ? `+${fmtNum(totals.today)} today` : totals.today < 0 ? `${fmtNum(totals.today)} today` : 'Nothing yet today', totals.pages ? ` · ${totals.pages} pages` : ''),
    );
  }

  updateWords(s: Section, totals: { words: number; today: number; pages: number }): void {
    const li = this.list.querySelector<HTMLElement>(`[data-id="${s.id}"]`);
    if (li) {
      const w = li.querySelector('.sb-words');
      if (w && s.kind !== 'title' && s.kind !== 'toc') w.textContent = s.words ? fmtNum(s.words) : '';
      const t = li.querySelector('.sb-title');
      const title = sectionTitle(s);
      if (t && t.textContent !== title) t.textContent = title;
    }
    const main = this.totals.querySelector('strong');
    if (main) main.textContent = fmtNum(totals.words);
    const sub = this.totals.querySelector('.sb-total-sub');
    if (sub) sub.textContent = `${totals.today > 0 ? `+${fmtNum(totals.today)} today` : totals.today < 0 ? `${fmtNum(totals.today)} today` : 'Nothing yet today'}${totals.pages ? ` · ${totals.pages} pages` : ''}`;
  }

  private addMenu(anchor: HTMLElement | { x: number; y: number }, after: string | null): void {
    const has = (k: SectionKind) => this.sections.some((s) => s.kind === k);
    const items: MenuItem[] = KIND_ORDER.map((k) => ({
      label: KINDS[k].label,
      hint: (k === 'title' || k === 'toc') && has(k) ? 'already added' : '',
      onClick: () => this.opts.onAdd(k, after),
    }));
    showMenu(anchor, items);
  }

  private itemMenu(anchor: HTMLElement | { x: number; y: number }, s: Section): void {
    const idx = this.sections.findIndex((x) => x.id === s.id);
    const kinds: MenuItem[] = KIND_ORDER.filter((k) => k !== s.kind && k !== 'title' && k !== 'toc' && s.kind !== 'title' && s.kind !== 'toc')
      .map((k) => ({ label: `Make it ${/^[aeiou]/i.test(KINDS[k].label) ? 'an' : 'a'} ${KINDS[k].label.toLowerCase()}`, onClick: () => this.opts.onKind(s.id, k) }));
    showMenu(anchor, [
      { label: 'Rename…', icon: 'edit', onClick: () => this.opts.onRename(s.id), disabled: s.kind === 'title' },
      { label: 'Duplicate', icon: 'copy', onClick: () => this.opts.onDuplicate(s.id) },
      { label: 'Add section below…', icon: 'plus', onClick: () => this.addMenu(anchor, s.id) },
      { label: 'Move up', icon: 'up', hint: '⌥↑', disabled: idx <= 0, onClick: () => this.move(s.id, -1) },
      { label: 'Move down', icon: 'down', hint: '⌥↓', disabled: idx >= this.sections.length - 1, onClick: () => this.move(s.id, 1) },
      ...(kinds.length ? [{ separator: true, label: '' }, ...kinds] : []),
      { separator: true, label: '' },
      { label: 'Delete…', icon: 'trash', danger: true, onClick: () => this.opts.onDelete(s.id) },
    ]);
  }

  private move(id: string, delta: number): void {
    const ids = this.sections.map((s) => s.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    this.opts.onReorder(ids);
    requestAnimationFrame(() => this.list.querySelector<HTMLElement>(`[data-id="${id}"]`)?.focus());
  }

  private onKey(e: KeyboardEvent, s: Section): void {
    const items = Array.from(this.list.children) as HTMLElement[];
    const i = items.findIndex((x) => x.dataset.id === s.id);
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); this.move(s.id, e.key === 'ArrowUp' ? -1 : 1); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); items[i + 1]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[i - 1]?.focus(); }
    else if (e.key === 'Enter') { e.preventDefault(); this.opts.onSelect(s.id); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (e.metaKey || e.ctrlKey) { e.preventDefault(); this.opts.onDelete(s.id); } }
  }

  private clearDrop(): void {
    for (const li of Array.from(this.list.querySelectorAll('.drop-before, .drop-after'))) li.classList.remove('drop-before', 'drop-after');
  }

  private onDragOver(e: DragEvent): void {
    if (!this.dragId) return;
    e.preventDefault();
    const li = (e.target as HTMLElement).closest('.sb-item') as HTMLElement | null;
    this.clearDrop();
    if (!li || li.dataset.id === this.dragId) return;
    const r = li.getBoundingClientRect();
    li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  }

  private onDrop(e: DragEvent): void {
    if (!this.dragId) return;
    e.preventDefault();
    const li = (e.target as HTMLElement).closest('.sb-item') as HTMLElement | null;
    const target = li?.dataset.id;
    const before = li?.classList.contains('drop-before');
    this.clearDrop();
    if (!target || target === this.dragId) return;
    const ids = this.sections.map((s) => s.id).filter((id) => id !== this.dragId);
    const at = ids.indexOf(target) + (before ? 0 : 1);
    ids.splice(at, 0, this.dragId);
    this.opts.onReorder(ids);
  }
}
