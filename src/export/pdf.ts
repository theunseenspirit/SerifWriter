import type { BookLayout } from '../typeset/book.ts';
import { pageSize } from '../templates/index.ts';

// Print-ready PDF through the browser's own print engine: the exact pages of
// the preview, one per sheet, at the trim size (plus bleed), with the fonts
// embedded by the browser. In Chrome choose "Save as PDF".

export interface PdfOptions { bleed: boolean; whitePaper: boolean; blanks: boolean; title: string }

export async function printBook(book: BookLayout, opts: PdfOptions): Promise<void> {
  await book.idle();
  await document.fonts.ready;
  const s = book.currentSettings;
  const ps = pageSize(s);
  const bleed = opts.bleed ? 0.125 : 0;
  const w = ps.w + bleed;
  const h = ps.h + 2 * bleed;
  const view = book.view;
  const style = document.createElement('style');
  style.id = 'print-style';
  style.textContent = `@page { size: ${w}in ${h}in; margin: 0; }`;
  document.head.appendChild(style);
  view.style.setProperty('--bleed', `${bleed}in`);
  view.classList.toggle('print-white', opts.whitePaper);
  view.classList.toggle('no-blanks', !opts.blanks);
  // content-visibility: make sure every page is rendered before printing
  for (const f of Array.from(view.querySelectorAll<HTMLElement>('.pv-frame'))) f.style.contentVisibility = 'visible';
  const oldTitle = document.title;
  document.title = opts.title;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const restore = () => {
    style.remove();
    view.style.setProperty('--bleed', '0in');
    view.classList.remove('print-white', 'no-blanks');
    for (const f of Array.from(view.querySelectorAll<HTMLElement>('.pv-frame'))) f.style.contentVisibility = '';
    document.title = oldTitle;
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  window.print();
  // Safari may not fire afterprint reliably
  setTimeout(() => { if (document.getElementById('print-style')) restore(); }, 60_000);
}
