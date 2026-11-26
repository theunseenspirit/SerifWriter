import type { Section, SectionKind, TemplateSettings } from '../model/types.ts';
import { h, icon } from './dom.ts';
import { showMenu, type MenuItem } from './dialogs.ts';
import { KINDS, KIND_ORDER, sectionTitle } from '../model/defaults.ts';
import { fmtNum } from '../util.ts';
import { outline, type OutlineEntry } from '../model/outline.ts';

// The book's sections in order. Drag to reorder (or Alt+↑/↓), right-click or
// "…" for options. Under the selected one, its sections and subsections, which
// open and close as the selection moves; a click jumps the editor there.

export interface SidebarOptions {
  onStats: () => void;
  onSelect: (id: string) => void;
  onJump: (id: string, line: number) => void;
  onReorder: (ids: string[]) => void;
  onAdd: (kind: SectionKind, afterId: string | null) => void;
  onRename: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onKind: (id: string, kind: SectionKind) => void;
}

const KIND_GLYPH: Record<SectionKind, string> = {
  title: 'T', copyright: '©', dedication: 'D', epigraph: '“', toc: '≡', part: 'P', chapter: '', section: '§', about: 'A', bibliography: 'B', index: 'X',
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
  private headings: TemplateSettings['headings'] = { h1: 'chapter', h2: 'section', h3: 'subsection', h4: 'minor', h5: 'minor', h6: 'runin' };
  private numbered = false;
  private outlineEl: HTMLElement | null = null; // the open outline under the active row
  private outlineKey = '';
  private rendered = false;

  constructor(opts: SidebarOptions) {
    this.opts = opts;
    this.list = h('ol', { class: 'sb-list', role: 'listbox', 'aria-label': 'Sections' });
    this.totals = h('button', { class: 'sb-totals', type: 'button', title: 'Writing stats' });
    this.totals.addEventListener('click', () => opts.onStats());
    const add = h('button', { class: 'btn sb-add', type: 'button' }, icon('plus', 16), h('span', null, 'Add'));
    add.addEventListener('click', () => this.addMenu(add, this.active));
    this.el = h('aside', { class: 'sidebar' },
      h('div', { class: 'sb-head' }, h('span', null, 'Contents'), add),
      this.list, this.totals);
    this.list.addEventListener('dragover', (e) => this.onDragOver(e));
    this.list.addEventListener('drop', (e) => this.onDrop(e));
  }

  setHidden(kinds: SectionKind[]): void { this.hidden = new Set(kinds); }

  setHeadings(headings: TemplateSettings['headings'], numbered: boolean): void {
    this.headings = headings;
    this.numbered = numbered;
    this.outlineKey = ''; // rebuild on the next render
  }

  render(sections: Section[], active: string | null, totals: { words: number; today: number; pages: number }): void {
    const was = this.active;
    const wasOutline = this.outlineEl;
    const animate = this.rendered && was !== active;
    this.sections = sections;
    this.active = active;
    this.rendered = true;
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
    this.outlineEl = null;
    this.outlineKey = '';
    // The outline of the section just left closes where it was.
    if (animate && wasOutline && was) {
      const row = this.row(was);
      if (row) { row.after(wasOutline); this.collapse(wasOutline); }
    }
    const cur = active ? sections.find((x) => x.id === active) : undefined;
    if (cur) this.refreshOutline(cur, animate);
    this.totals.replaceChildren(
      h('div', { class: 'sb-total-main' }, h('strong', null, fmtNum(totals.words)), ' words'),
      h('div', { class: 'sb-total-sub' }, totals.today > 0 ? `+${fmtNum(totals.today)} today` : totals.today < 0 ? `${fmtNum(totals.today)} today` : 'Nothing yet today', totals.pages ? ` · ${totals.pages} pages` : ''),
    );
  }

  updateWords(s: Section, totals: { words: number; today: number; pages: number }): void {
    if (s.id === this.active) this.refreshOutline(s, true);
    const li = this.row(s.id);
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

  private row(id: string): HTMLElement | null {
    return this.list.querySelector<HTMLElement>(`.sb-item[data-id="${id}"]`);
  }

  /** Builds, updates or removes the outline under the active row. */
  private refreshOutline(s: Section, animate: boolean): void {
    const entries = outline(s.content, this.headings, this.numbered);
    const key = JSON.stringify(entries);
    if (key === this.outlineKey && (this.outlineEl || !entries.length)) return;
    this.outlineKey = key;
    if (!entries.length) {
      if (this.outlineEl) { this.collapse(this.outlineEl); this.outlineEl = null; }
      return;
    }
    const row = this.row(s.id);
    if (!row) return;
    const chapterNo = s.kind === 'chapter' ? this.sections.filter((x, i) => x.kind === 'chapter' && i <= this.sections.indexOf(s)).length : 0;
    const items = entries.map((e) => this.outlineItem(s, e, chapterNo));
    if (this.outlineEl) { this.outlineEl.querySelector('.sb-subs')!.replaceChildren(...items); return; }
    const list = h('ol', { class: 'sb-subs', role: 'group', 'aria-label': `Headings in ${sectionTitle(s)}` }, ...items);
    const el = h('li', { class: 'sb-outline', role: 'none' }, h('div', { class: 'sb-outline-inner' }, list));
    row.after(el);
    this.outlineEl = el;
    if (animate) {
      void el.offsetHeight; // start from closed
      requestAnimationFrame(() => el.classList.add('open'));
    } else el.classList.add('open');
  }

  private outlineItem(s: Section, e: OutlineEntry, chapterNo: number): HTMLElement {
    const num = e.hnum ? (chapterNo ? `${chapterNo}.${e.hnum}` : e.hnum) : '';
    const li = h('li', { class: `sb-sub lv-${e.level}`, role: 'option', tabindex: '-1', 'aria-selected': 'false', title: e.title },
      num ? h('span', { class: 'sb-sub-num' }, num) : null,
      h('span', { class: 'sb-sub-title' }, e.title));
    li.addEventListener('click', () => this.opts.onJump(s.id, e.line));
    li.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); this.opts.onJump(s.id, e.line); }
      else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); this.focusStep(li, ev.key === 'ArrowUp' ? -1 : 1); }
    });
    return li;
  }

  private collapse(el: HTMLElement): void {
    void el.offsetHeight; // it may have just been put back: close from open
    el.classList.remove('open');
    el.classList.add('closing');
    el.setAttribute('aria-hidden', 'true');
    setTimeout(() => el.remove(), 320);
  }

  /** Moves focus to the row or heading above or below. */
  private focusStep(from: HTMLElement, delta: number): void {
    const items = Array.from(this.list.querySelectorAll<HTMLElement>('.sb-item, .sb-outline.open .sb-sub'));
    items[items.indexOf(from) + delta]?.focus();
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
    requestAnimationFrame(() => this.row(id)?.focus());
  }

  private onKey(e: KeyboardEvent, s: Section): void {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); this.move(s.id, e.key === 'ArrowUp' ? -1 : 1); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.focusStep(e.currentTarget as HTMLElement, e.key === 'ArrowUp' ? -1 : 1); }
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
