import { h, iconButton } from './dom.ts';
import type { BookLayout, PageRef } from '../typeset/book.ts';

// The live page preview. Pages are real-size DOM scaled with a transform (no
// relayout), and offscreen pages use content-visibility so only the visible
// few are ever painted.

export interface PreviewOptions {
  onJump: (sectionId: string, line: number) => void;
  onZoom: (zoom: number, spread: boolean) => void;
}

export class Preview {
  readonly el: HTMLElement;
  readonly scroller: HTMLElement;
  readonly view: HTMLElement;
  private status: HTMLElement;
  private zoomLabel: HTMLElement;
  private book: BookLayout | null = null;
  zoom = 0; // 0 = fit
  spread = false;
  private pageWpx = 576;
  private lastUserScroll = 0;
  private programmatic = false;
  private ro: ResizeObserver;
  private opts: PreviewOptions;

  constructor(opts: PreviewOptions) {
    this.opts = opts;
    this.view = h('div', { class: 'sw-book pv-root' });
    this.scroller = h('div', { class: 'pv-scroll' }, h('div', { class: 'pv-pad' }, this.view));
    this.status = h('span', { class: 'pv-status' });
    this.zoomLabel = h('button', { class: 'btn pv-zoom-label', type: 'button', title: 'Fit to width' }, 'Fit');
    this.zoomLabel.addEventListener('click', () => this.setZoom(0));
    const spreadBtn = iconButton('spread', 'Two-page spreads', () => { this.spread = !this.spread; spreadBtn.classList.toggle('on', this.spread); this.apply(); this.opts.onZoom(this.zoom, this.spread); });
    this.el = h('section', { class: 'preview', 'aria-label': 'Page preview' },
      h('div', { class: 'pv-bar' },
        this.status,
        h('div', { class: 'pv-tools' },
          iconButton('zoomout', 'Zoom out', () => this.step(-1)),
          this.zoomLabel,
          iconButton('zoomin', 'Zoom in', () => this.step(1)),
          spreadBtn)),
      this.scroller);
    (this as any).spreadBtn = spreadBtn;
    this.scroller.addEventListener('scroll', () => {
      if (!this.programmatic) this.lastUserScroll = performance.now();
      this.updateStatus();
    }, { passive: true });
    this.view.addEventListener('click', (e) => this.onClick(e));
    this.ro = new ResizeObserver(() => { if (this.zoom === 0) this.apply(); });
    this.ro.observe(this.scroller);
  }

  attach(book: BookLayout): void {
    this.book = book;
  }

  destroy(): void { this.ro.disconnect(); }

  setPageSize(wIn: number, _hIn: number): void {
    this.pageWpx = wIn * 96;
    this.apply();
  }

  setView(zoom: number, spread: boolean): void {
    this.zoom = zoom;
    this.spread = spread;
    ((this as any).spreadBtn as HTMLElement).classList.toggle('on', spread);
    this.apply();
  }

  private scale(): number {
    if (this.zoom > 0) return this.zoom;
    const avail = this.scroller.clientWidth - 48;
    const need = this.spread ? this.pageWpx * 2 + 4 : this.pageWpx;
    return Math.max(0.2, Math.min(1.6, avail / need));
  }

  private step(dir: number): void {
    const stops = [0.35, 0.5, 0.65, 0.8, 1, 1.25, 1.5, 2];
    const cur = this.scale();
    const next = dir > 0 ? stops.find((s) => s > cur + 0.01) : [...stops].reverse().find((s) => s < cur - 0.01);
    if (next) this.setZoom(next);
  }

  setZoom(z: number): void {
    this.zoom = z;
    this.apply();
    this.opts.onZoom(this.zoom, this.spread);
  }

  apply(): void {
    const s = this.scale();
    // keep the same page in view across zoom changes
    const anchor = this.visiblePage();
    this.view.style.setProperty('--pv-scale', s.toFixed(4));
    this.view.classList.toggle('spread', this.spread);
    this.zoomLabel.textContent = this.zoom === 0 ? 'Fit' : `${Math.round(s * 100)}%`;
    if (anchor) this.scrollToFrame(anchor.frame, 'start', false);
  }

  visiblePage(): PageRef | null {
    if (!this.book) return null;
    const refs = this.book.pageRefs;
    if (!refs.length) return null;
    const top = this.scroller.getBoundingClientRect().top + 40;
    // Pages are in vertical order: binary search for the first whose bottom is below the top edge.
    let lo = 0;
    let hi = refs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (refs[mid].frame.getBoundingClientRect().bottom > top) hi = mid;
      else lo = mid + 1;
    }
    return refs[lo];
  }

  updateStatus(): void {
    if (!this.book) return;
    const total = this.book.pageRefs.length;
    const v = this.visiblePage();
    const info = this.book.info();
    const busy = info.busy && info.done < info.total ? ` · typesetting ${info.done}/${info.total}` : '';
    this.status.textContent = total ? `Page ${v ? v.n + 1 : 1} of ${total}${v ? ` (${v.folio})` : ''}${busy}` : info.busy ? 'Typesetting…' : '';
  }

  scrollToFrame(frame: HTMLElement, block: 'start' | 'nearest' = 'nearest', respectUser = true): void {
    if (respectUser && performance.now() - this.lastUserScroll < 2500) return;
    const sr = this.scroller.getBoundingClientRect();
    const fr = frame.getBoundingClientRect();
    let target = this.scroller.scrollTop;
    if (block === 'start') target += fr.top - sr.top - 16;
    else if (fr.top < sr.top + 8) target += fr.top - sr.top - 16;
    else if (fr.bottom > sr.bottom - 8) target += Math.min(fr.top - sr.top - 16, fr.bottom - sr.bottom + 16);
    else return;
    this.programmatic = true;
    this.scroller.scrollTop = target;
    requestAnimationFrame(() => { this.programmatic = false; });
  }

  /** Brings the page holding a source line into view. */
  follow(sectionId: string, line: number): void {
    const ref = this.book?.pageForLine(sectionId, line);
    if (ref) this.scrollToFrame(ref.frame);
  }

  showSection(sectionId: string): void {
    const ref = this.book?.pageRefs.find((r) => r.sectionId === sectionId && !r.blank);
    if (ref) this.scrollToFrame(ref.frame, 'start', false);
  }

  private onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const page = target.closest('.page') as HTMLElement | null;
    if (!page?.dataset.section) return;
    const lineEl = target.closest('[data-line]') as HTMLElement | null;
    const line = lineEl ? Number(lineEl.dataset.line) : Number(page.querySelector<HTMLElement>('[data-line]')?.dataset.line || 0);
    this.opts.onJump(page.dataset.section, line);
  }
}
