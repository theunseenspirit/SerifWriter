import type { Project, Section, TemplateDef, TemplateSettings } from '../model/types.ts';
import { renderSection, type Rendered, type TocEntry } from './sections.ts';
import { paginate } from './paginate.ts';
import { applyBookRoot, effectiveSettings, getTemplate, injectTemplateCss } from '../templates/index.ts';
import { ensureFonts } from './fonts.ts';
import { formatLabel, hashString, toRoman, yieldToMain } from '../util.ts';
import { KINDS, plainTitle } from '../model/defaults.ts';
import { citeContext, citeDependent, type CiteCtx } from '../md/cite.ts';
import { loadMath, mathReady } from '../md/math.ts';
import { indexEntries, pageList, type IndexEntry } from '../md/terms.ts';

// Book assembly: per-section pagination jobs (cached by a content+settings
// key, cancellable), then a cheap pass that inserts blank pages for recto
// starts, numbers folios (roman front matter, arabic body), fills running
// heads, chapter/part labels and the table of contents.

interface SecState {
  pages: HTMLElement[] | null;
  key: string; // key the current pages were made with
  gen: number;
  toc: TocEntry[];
  tocKey: string;
}

export interface LayoutInfo {
  pages: number;
  done: number;
  total: number;
  busy: boolean;
}

export interface PageRef { page: HTMLElement; frame: HTMLElement; sectionId: string; n: number; folio: string; blank?: boolean }

export class BookLayout {
  readonly measure: HTMLElement;
  readonly view: HTMLElement;
  private project!: Project;
  private sections: Section[] = [];
  private byId = new Map<string, Section>();
  private states = new Map<string, SecState>();
  private queue: string[] = [];
  private running = false;
  private settings!: TemplateSettings;
  private template!: TemplateDef;
  private settingsKey = '';
  private assetUrls = new Map<string, string>();
  private assembleTimer = 0;
  private lastAssemble = 0;
  private destroyed = false;
  private groups = new Map<string, HTMLElement>();
  private frames = new WeakMap<HTMLElement, HTMLElement>();
  private blanks = new Map<string, HTMLElement>();
  private cite: CiteCtx | null = null;
  private index: IndexEntry[] = [];
  pageRefs: PageRef[] = [];
  onChange: (info: LayoutInfo) => void = () => {};
  onAssembled: () => void = () => {};

  constructor(view: HTMLElement) {
    this.view = view;
    this.measure = document.createElement('div');
    this.measure.setAttribute('aria-hidden', 'true');
    this.measure.style.cssText = 'position:fixed;left:-30000px;top:0;visibility:hidden;pointer-events:none;width:20in;';
    document.body.appendChild(this.measure);
  }

  destroy(): void {
    this.destroyed = true;
    this.measure.remove();
    clearTimeout(this.assembleTimer);
  }

  get currentSettings(): TemplateSettings { return this.settings; }
  get currentTemplate(): TemplateDef { return this.template; }

  setAssets(urls: Map<string, string>): void { this.assetUrls = urls; }

  /** (Re)starts layout of the whole book. `first` is laid out before anything else. */
  async load(project: Project, sections: Section[], first?: string): Promise<void> {
    this.project = project;
    this.setSections(sections);
    await this.applySettings();
    await loadMath(sections.map((s) => s.content));
    this.refreshCite();
    const order = this.visibleIds();
    const front = first && order.includes(first) ? [first] : [];
    const toc = order.filter((id) => this.byId.get(id)!.kind === 'toc');
    const rest = order.filter((id) => !front.includes(id) && !toc.includes(id));
    for (const id of [...front, ...rest, ...toc]) this.enqueue(id);
    this.scheduleAssemble(true);
  }

  private setSections(sections: Section[]): void {
    this.sections = sections;
    this.byId = new Map(sections.map((s) => [s.id, s]));
    for (const s of sections) if (!this.states.has(s.id)) this.states.set(s.id, { pages: null, key: '', gen: 0, toc: [], tocKey: '' });
    for (const id of [...this.states.keys()]) {
      if (!this.byId.has(id)) {
        this.states.delete(id);
        this.groups.get(id)?.remove();
        this.groups.delete(id);
        this.blanks.delete(id);
      }
    }
  }

  private async applySettings(): Promise<void> {
    this.template = getTemplate(this.project.templateId);
    this.settings = effectiveSettings(this.project);
    injectTemplateCss([{ id: this.project.id, css: this.project.customCss || '' }]);
    for (const root of [this.view, this.measure]) {
      applyBookRoot(root, this.template, this.settings, this.project.meta.language);
      root.classList.add(`proj-${this.project.id}`);
    }
    this.view.classList.add('pv-root');
    this.settingsKey = hashString(JSON.stringify([this.template.id, this.template.css.length, this.settings, this.project.customCss, this.project.meta.language]));
    await ensureFonts([this.settings.type.body, this.settings.type.display]);
  }

  /** Call after template settings, custom CSS or language changed. */
  async refreshSettings(project: Project, priority?: string): Promise<void> {
    this.project = project;
    await this.applySettings();
    this.refreshCite();
    const ids = this.visibleIds();
    if (priority && ids.includes(priority)) this.enqueue(priority, true);
    for (const id of ids) if (id !== priority) this.enqueue(id);
    this.scheduleAssemble(true);
  }

  /** Call after book metadata changed (title page, running heads, copyright). */
  metaChanged(project: Project): void {
    this.project = project;
    for (const s of this.sections) if (s.kind === 'title' || s.kind === 'copyright') this.enqueue(s.id);
    this.scheduleAssemble(true);
  }

  updateSections(project: Project, sections: Section[], changed: string[] = [], priority?: string): void {
    this.project = project;
    this.setSections(sections);
    if (priority) this.enqueue(priority, true);
    for (const id of changed) if (id !== priority) this.enqueue(id);
    const withMath = changed.map((id) => this.byId.get(id)?.content || '');
    if (!mathReady()) void loadMath(withMath).then((loaded) => { if (loaded) for (const id of this.visibleIds()) if (this.byId.get(id)!.content.includes('$')) this.enqueue(id); });
    // New or changed citations renumber (and re-list) every citing section.
    if (this.refreshCite()) for (const id of this.visibleIds()) { const k = this.byId.get(id)!; if (k.kind === 'bibliography' || citeDependent(k.content)) this.enqueue(id); }
    // sections never laid out (new ones)
    for (const id of this.visibleIds()) if (!this.states.get(id)!.pages && !this.queue.includes(id)) this.enqueue(id);
    this.scheduleAssemble(true);
  }

  /** Recomputes the bibliography and citation order. True if it changed. */
  private refreshCite(): boolean {
    const before = this.cite?.key;
    const secs = this.visibleIds().map((id) => this.byId.get(id)!);
    this.cite = citeContext(secs, this.settings.citations);
    // index terms: re-render the index page when the list of terms changes
    if (secs.some((s) => s.kind === 'index')) {
      const idx = indexEntries(secs.filter((s) => s.kind !== 'bibliography').map((s) => s.content));
      if (JSON.stringify(idx) !== JSON.stringify(this.index)) { this.index = idx; for (const s of secs) if (s.kind === 'index') this.enqueue(s.id); }
    }
    return before !== this.cite?.key;
  }

  private visibleIds(): string[] {
    const hidden = new Set(this.settings?.hiddenKinds || []);
    return this.project.order.filter((id) => this.byId.has(id) && !hidden.has(this.byId.get(id)!.kind));
  }

  private keyFor(sec: Section): string {
    let extra = '';
    if (sec.kind === 'title') extra = JSON.stringify(this.project.meta) + (this.settings.titlePage.layout === 'manuscript' ? Math.round(this.project.words / 100) : '');
    else if (sec.kind === 'copyright') extra = JSON.stringify(this.project.meta);
    else if (sec.kind === 'toc') extra = JSON.stringify(this.tocEntries());
    else if (sec.kind === 'index') extra = JSON.stringify(this.index);
    if (this.cite && (sec.kind === 'bibliography' || citeDependent(sec.content))) extra += this.cite.key;
    if (mathReady() && sec.content.includes('$')) extra += 'math';
    return hashString(`${sec.kind}\u0000${sec.title}\u0000${sec.content}\u0000${extra}`) + this.settingsKey;
  }

  private tocEntries(): TocEntry[] {
    return this.visibleIds().flatMap((id) => {
      const sec = this.byId.get(id)!;
      if (sec.kind === 'toc' || KINDS[sec.kind].front && sec.kind !== 'section') return [];
      const st = this.states.get(id)!;
      const tk = hashString(sec.title + sec.content) + this.settingsKey;
      if (st.tocKey !== tk) {
        st.toc = renderSection(sec, this.ctx()).toc;
        st.tocKey = tk;
      }
      return st.toc;
    });
  }

  private ctx() {
    return {
      settings: this.settings,
      meta: this.project.meta,
      assetUrl: (id: string) => this.assetUrls.get(id),
      bookWords: this.project.words,
      toc: [] as TocEntry[],
      cite: this.cite,
      index: this.index,
    };
  }

  enqueue(id: string, priority = false): void {
    const st = this.states.get(id);
    if (!st) return;
    st.gen++; // cancels a running job for this section
    this.queue = this.queue.filter((q) => q !== id);
    if (priority) this.queue.unshift(id);
    else this.queue.push(id);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.destroyed) {
        const id = this.queue.shift()!;
        await this.layoutSection(id);
      }
    } finally {
      this.running = false;
      this.scheduleAssemble(true);
    }
  }

  private current: string | null = null;

  private async layoutSection(id: string): Promise<void> {
    const sec = this.byId.get(id);
    const st = this.states.get(id);
    if (!sec || !st) return;
    const key = this.keyFor(sec);
    if (st.pages && st.key === key) return;
    const gen = ++st.gen;
    this.current = id;
    // Let any pending keystrokes run before the (synchronous) Markdown render.
    await yieldToMain();
    if (st.gen !== gen || this.destroyed) { this.current = null; return; }
    const ctx = this.ctx();
    if (sec.kind === 'toc') ctx.toc = this.tocEntries();
    let rendered: Rendered;
    performance.mark('sw-render-start');
    try {
      rendered = renderSection(sec, ctx);
    } catch (e) {
      console.error('render failed', e);
      this.current = null;
      return;
    }
    performance.measure(`sw-render ${sec.kind}`, 'sw-render-start');
    await yieldToMain();
    // A changed chapter title or heading changes the contents page.
    const tk = hashString(sec.title + sec.content) + this.settingsKey;
    const tocChanged = sec.kind !== 'toc' && JSON.stringify(st.toc) !== JSON.stringify(rendered.toc);
    st.toc = rendered.toc;
    st.tocKey = tk;
    const pages = await paginate(rendered, this.measure, {
      widows: this.settings.widows,
      orphans: this.settings.orphans,
      isCancelled: () => st.gen !== gen || this.destroyed,
    });
    this.current = null;
    if (!pages) return;
    performance.measure(`sw-paginate ${sec.kind} (${pages.length} pages)`, 'sw-render-start');
    for (const p of pages) p.dataset.section = id;
    const old = st.pages;
    st.pages = pages;
    st.key = key;
    if (old) for (const p of old) this.frames.get(p)?.remove();
    this.onChange(this.info());
    if (tocChanged) for (const s of this.sections) if (s.kind === 'toc') this.enqueue(s.id);
    this.scheduleAssemble();
  }

  /** Cheap progress summary (called on every preview scroll, so no hashing here). */
  info(): LayoutInfo {
    const ids = this.visibleIds();
    const pending = new Set(this.queue);
    if (this.current) pending.add(this.current);
    const done = ids.filter((id) => this.states.get(id)?.pages && !pending.has(id)).length;
    return { pages: this.pageRefs.length, done, total: ids.length, busy: this.running || this.queue.length > 0 };
  }

  get busy(): boolean { return this.running || this.queue.length > 0; }

  /** Resolves when every queued section has been laid out and assembled. */
  async idle(): Promise<void> {
    while (this.busy) await new Promise((r) => setTimeout(r, 50));
    this.assemble();
  }

  private scheduleAssemble(soon = false): void {
    if (this.assembleTimer) return;
    const wait = soon ? 0 : Math.max(0, 120 - (performance.now() - this.lastAssemble));
    this.assembleTimer = window.setTimeout(() => {
      this.assembleTimer = 0;
      requestAnimationFrame(() => this.assemble());
    }, wait);
  }

  private frameFor(page: HTMLElement): HTMLElement {
    let f = this.frames.get(page);
    if (!f) {
      f = document.createElement('div');
      f.className = 'pv-frame';
      f.appendChild(page);
      this.frames.set(page, f);
    }
    return f;
  }

  private blankFor(id: string): HTMLElement {
    let b = this.blanks.get(id);
    if (!b) {
      b = document.createElement('div');
      b.className = 'pv-frame pv-blank';
      b.innerHTML = '<div class="page blank"><div class="pg-head"><span class="pg-rh"></span><span class="pg-fh"></span></div><div class="pg-body"><div class="pg-content"></div></div><div class="pg-foot"><span class="pg-folio"></span></div></div>';
      this.blanks.set(id, b);
    }
    return b;
  }

  assemble(): void {
    if (this.destroyed || !this.settings) return;
    this.lastAssemble = performance.now();
    const s = this.settings;
    const rhs = s.runningHeads;
    const twoSided = s.page.twoSided;
    const meta = this.project.meta;
    const bookTitle = plainTitle(meta);
    const msSurname = meta.extra.surname || (meta.author || 'Author').trim().split(/\s+/).pop() || 'Author';
    const msTitle = (meta.extra.short_title || bookTitle).toUpperCase();
    const ids = this.visibleIds();
    const tocLabelPattern = /\{n\}/.test(s.chapter.label) ? '{n}' : '{Roman}.';
    const refs: PageRef[] = [];
    const tocPages = new Map<string, string>();
    const hasIndex = ids.some((id) => this.byId.get(id)!.kind === 'index');
    const termPages = new Map<string, string[]>();
    const firstBody = ids.find((id) => { const k = this.byId.get(id)!.kind; return k === 'chapter' || k === 'part'; }) ?? ids.find((id) => !KINDS[this.byId.get(id)!.kind].front);
    let bodyStarted = false;
    let frontNo = 0;
    let bodyNo = 0;
    let p = 0;
    let chapterNo = 0;
    let partNo = 0;
    let anchor: Node | null = this.view.firstChild;

    const place = (el: HTMLElement, parent: HTMLElement, before: Node | null) => {
      if (el.parentNode !== parent || el.nextSibling !== before) parent.insertBefore(el, before);
    };
    const setText = (el: Element | null, text: string) => { if (el && el.textContent !== text) el.textContent = text; };
    const setSide = (page: HTMLElement, side: string) => {
      if (!page.classList.contains(side)) {
        page.classList.remove('recto', 'verso');
        page.classList.add(side);
      }
    };

    for (const id of ids) {
      const sec = this.byId.get(id)!;
      const st = this.states.get(id)!;
      let group = this.groups.get(id);
      if (!group) {
        group = document.createElement('div');
        group.className = 'pv-sec';
        group.dataset.id = id;
        this.groups.set(id, group);
      }
      place(group, this.view, anchor);
      anchor = group.nextSibling;
      if (!st.pages) continue;

      const isBodyStart = id === firstBody && !bodyStarted;
      const rule = KINDS[sec.kind].start === 'chapter' ? s.chapter.start : KINDS[sec.kind].start;
      const needBlank = twoSided && p > 0 && ((rule === 'recto' && p % 2 === 1) || (rule === 'verso' && p % 2 === 0) || (isBodyStart && p % 2 === 1));
      if (!needBlank) this.blanks.get(id)?.remove();
      let cursor: Node | null = group.firstChild;
      if (needBlank) {
        const b = this.blankFor(id);
        place(b, group, cursor);
        cursor = b.nextSibling;
        const bp = b.firstElementChild as HTMLElement;
        setSide(bp, p % 2 === 0 ? 'recto' : 'verso');
        b.dataset.n = String(p);
        const bn = bodyStarted ? ++bodyNo : ++frontNo;
        refs.push({ page: bp, frame: b, sectionId: id, n: p, folio: bodyStarted ? String(bn) : toRoman(bn).toLowerCase(), blank: true });
        p++;
      }
      if (isBodyStart) bodyStarted = true;

      st.pages.forEach((page, i) => {
        const frame = this.frameFor(page);
        place(frame, group!, cursor);
        cursor = frame.nextSibling;
        frame.dataset.n = String(p);
        const side = !twoSided || p % 2 === 0 ? 'recto' : 'verso';
        setSide(page, side);
        const folioNum = bodyStarted ? ++bodyNo : ++frontNo;
        const folio = bodyStarted ? String(folioNum) : toRoman(folioNum).toLowerCase();
        for (const tid of (page.dataset.toc || '').split(' ').filter(Boolean)) if (!tocPages.has(tid)) tocPages.set(tid, folio);
        if (hasIndex) for (const m of Array.from(page.querySelectorAll<HTMLElement>('.idx[data-idx]'))) {
          const list = termPages.get(m.dataset.idx!) || [];
          if (list.at(-1) !== folio) list.push(folio);
          termPages.set(m.dataset.idx!, list);
        }

        // chapter / part labels
        for (const lbl of Array.from(page.querySelectorAll<HTMLElement>('[data-label]'))) {
          if (lbl.closest('.sw-cont')) continue;
          if (lbl.dataset.label === 'chapter') setText(lbl, formatLabel(s.chapter.label, ++chapterNo));
          else setText(lbl, formatLabel(s.chapter.partLabel, ++partNo));
        }
        for (const hn of Array.from(page.querySelectorAll<HTMLElement>('.h-num'))) setText(hn, sec.kind === 'chapter' ? `${chapterNo}.${hn.dataset.hnum}\u2002` : hn.dataset.hnum + '\u2002');

        const isOpener = page.dataset.opener === '1' || page.dataset.fixed === '1' || i === 0 && !!(st.pages![0].querySelector('.opener'));
        const front = !bodyStarted;
        const headEl = page.querySelector('.pg-head') as HTMLElement;
        const rhEl = page.querySelector('.pg-rh');
        const fhEl = page.querySelector('.pg-fh');
        const footEl = page.querySelector('.pg-folio');
        let rh = '';
        let fh = '';
        let foot = '';
        if (rhs.manuscript) {
          if (sec.kind !== 'title') rh = `${msSurname} / ${msTitle} / ${folio}`;
          headEl.classList.add('ms');
        } else {
          headEl.classList.remove('ms');
          const fixedKind = ['title', 'copyright', 'dedication', 'epigraph', 'part'].includes(sec.kind) || page.dataset.fixed === '1';
          const showHead = !isOpener && !fixedKind && !front;
          const showFolio = rhs.folio !== 'none' && !fixedKind && (!isOpener || rhs.folioOnOpeners) && (!front || sec.kind === 'toc' || sec.kind === 'section');
          if (showHead) {
            const what = side === 'verso' ? rhs.verso : rhs.recto;
            rh = what === 'title' ? bookTitle : what === 'author' ? meta.author : what === 'chapter' ? page.dataset.rh || '' : '';
          }
          if (showFolio) {
            if (rhs.folio === 'top-outside' && !isOpener && !front) fh = folio;
            else foot = folio;
          }
        }
        setText(rhEl, rh);
        setText(fhEl, fh);
        setText(footEl, foot);
        headEl.classList.toggle('empty', !rh && !fh);
        refs.push({ page, frame, sectionId: id, n: p, folio });
        p++;
      });
      // drop frames of pages that no longer belong
      while (cursor) {
        const next: Node | null = cursor.nextSibling;
        group.removeChild(cursor);
        cursor = next;
      }
    }
    // remove groups for sections that are hidden or gone
    while (anchor) {
      const next: Node | null = anchor.nextSibling;
      this.view.removeChild(anchor);
      anchor = next;
    }

    // contents page numbers and chapter numerals; index page numbers
    let tocChapter = 0;
    for (const id of ids) {
      if (this.byId.get(id)!.kind === 'index') for (const page of this.states.get(id)!.pages || []) for (const el of Array.from(page.querySelectorAll<HTMLElement>('.idx-pages[data-idx-ref]'))) { const pages = termPages.get(el.dataset.idxRef!); setText(el, pages ? `, ${pageList(pages)}` : ''); }
      if (this.byId.get(id)!.kind !== 'toc') continue;
      for (const page of this.states.get(id)!.pages || []) {
        for (const num of Array.from(page.querySelectorAll<HTMLElement>('.toc-num[data-toc-ref]'))) setText(num, tocPages.get(num.dataset.tocRef!) || '');
        for (const lbl of Array.from(page.querySelectorAll<HTMLElement>('.toc-label[data-toc-label]'))) setText(lbl, formatLabel(tocLabelPattern, ++tocChapter));
      }
    }
    this.pageRefs = refs;
    this.onChange(this.info());
    this.onAssembled();
  }

  /** Physical page index for a source line in a section (for scroll sync). */
  pageForLine(sectionId: string, line: number): PageRef | null {
    const pages = this.pageRefs.filter((r) => r.sectionId === sectionId && !r.blank);
    if (!pages.length) return null;
    let best = pages[0];
    for (const r of pages) {
      const first = r.page.querySelector<HTMLElement>('[data-line]');
      if (first && Number(first.dataset.line) <= line) best = r;
      else if (first) break;
    }
    return best;
  }

  sectionPageCount(id: string): number {
    return this.states.get(id)?.pages?.length ?? 0;
  }
}
