import type { ProjectCtx } from './project.ts';
import { h, iconButton } from './dom.ts';
import { effectiveSettings, pageSize } from '../templates/index.ts';
import { plainTitle } from '../model/defaults.ts';

// Full-screen reading mode: the typeset book as two-page spreads.
// ← → / Space / PageUp / PageDown turn pages; Esc leaves.

export async function openReader(ctx: ProjectCtx): Promise<void> {
  await ctx.flush();
  const { book, preview, session } = ctx;
  if (book.busy) await book.idle();
  const refs = book.pageRefs;
  if (!refs.length) return;
  const s = effectiveSettings(session.project);
  const ps = pageSize(s);
  const twoSided = s.page.twoSided;

  const stage = h('div', { class: 'reader-stage' });
  const spread = h('div', { class: 'reader-spread' });
  // carry the book's template classes and variables so pages style identically
  const bookRoot = h('div', { class: book.view.className.replace('pv-root', '').replace('spread', ''), style: { display: 'contents' } });
  bookRoot.setAttribute('style', `${book.view.getAttribute('style') || ''};display:contents`);
  bookRoot.lang = book.view.lang;
  bookRoot.appendChild(spread);
  const label = h('span', { class: 'rd-label' });
  const slider = h('input', { type: 'range', min: 0, max: refs.length - 1, step: 1, 'aria-label': 'Page' }) as HTMLInputElement;
  const prevZone = h('div', { class: 'reader-nav prev', title: 'Previous page' });
  const nextZone = h('div', { class: 'reader-nav next', title: 'Next page' });
  stage.append(bookRoot, prevZone, nextZone);
  const close = () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', paint);
    el.remove();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    // land the preview where the reader stopped
    const r = refs[index];
    if (r) preview.scrollToFrame(r.frame, 'start', false);
  };
  const el = h('div', { class: 'reader', role: 'dialog', 'aria-label': `Reading ${plainTitle(session.project.meta)}` },
    stage,
    h('div', { class: 'reader-bar' },
      iconButton('close', 'Close (Esc)', close),
      h('span', { class: 'rd-title' }, plainTitle(session.project.meta)),
      slider, label,
      iconButton('back', 'Previous', () => go(-1)),
      h('span', { style: { display: 'inline-block', transform: 'scaleX(-1)' } }, iconButton('back', 'Next', () => go(1)))));
  document.body.appendChild(el);
  document.documentElement.requestFullscreen?.().catch(() => undefined);

  // index = first page of the current view
  // (On a phone writing, the pages are out of sight: start from the page being written.)
  const at = ctx.currentId();
  const start = (preview.visible ? preview.visiblePage()?.n : at ? book.pageForLine(at, ctx.editor.caretLine())?.n : 0) ?? 0;
  let index = 0;
  const spreadStart = (i: number) => (!twoSided ? i : i === 0 ? 0 : i % 2 === 1 ? i : i - 1);
  index = spreadStart(start);

  function pagesAt(i: number): (number | null)[] {
    if (!twoSided || window.innerWidth < 900) return [i];
    if (i === 0) return [null, 0];
    return [i, i + 1 < refs.length ? i + 1 : null];
  }

  function paint(): void {
    const ids = pagesAt(index);
    const wPx = ps.w * 96;
    const hPx = ps.h * 96;
    const narrow = window.innerWidth < 600;
    const availH = window.innerHeight - 52 - (narrow ? 24 : 48);
    const availW = window.innerWidth - (narrow ? 16 : 80);
    const scale = Math.min(availH / hPx, availW / (wPx * ids.length));
    spread.replaceChildren(...ids.map((n, k) => {
      const box = h('div', { class: `rd-page ${ids.length === 2 ? (k === 0 ? 'left' : 'right') : ''} ${n === null ? 'empty' : ''}`, style: { width: `${wPx * scale}px`, height: `${hPx * scale}px` } });
      if (n !== null) {
        const clone = refs[n].page.cloneNode(true) as HTMLElement;
        clone.style.transform = `scale(${scale})`;
        box.appendChild(clone);
      }
      return box;
    }));
    const shown = ids.filter((x): x is number => x !== null);
    label.textContent = shown.map((n) => refs[n].folio).join(' – ') + `  ·  ${shown[shown.length - 1] + 1} / ${refs.length}`;
    slider.value = String(index);
  }

  function go(dir: number): void {
    const step = !twoSided || window.innerWidth < 900 ? 1 : index === 0 ? 1 : 2;
    const backStep = !twoSided || window.innerWidth < 900 ? 1 : index <= 1 ? 1 : 2;
    const next = dir > 0 ? index + step : index - backStep;
    if (next < 0 || next >= refs.length) return;
    index = Math.max(0, next);
    paint();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); go(1); }
    else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); go(-1); }
    else if (e.key === 'Home') { index = 0; paint(); }
    else if (e.key === 'End') { index = spreadStart(refs.length - 1); paint(); }
  }

  // Swipe to turn pages on a touch screen.
  let swipe: { x: number; y: number } | null = null;
  stage.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') swipe = { x: e.clientX, y: e.clientY }; });
  stage.addEventListener('pointerup', (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  });
  stage.addEventListener('pointercancel', () => { swipe = null; });
  prevZone.addEventListener('click', () => go(-1));
  nextZone.addEventListener('click', () => go(1));
  slider.addEventListener('input', () => { index = spreadStart(Number(slider.value)); paint(); });
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', paint);
  paint();
}
