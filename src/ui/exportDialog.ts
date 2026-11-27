import type { ProjectCtx } from './project.ts';
import { h, button } from './dom.ts';
import { modal, toast } from './dialogs.ts';
import { plainTitle } from '../model/defaults.ts';
import { downloadBlob, safeFilename } from '../util.ts';
import { isIOS } from './viewport.ts';

// Export: print-ready PDF, EPUB, DOCX, HTML, Markdown, and a backup of this book.

export function openExport(ctx: ProjectCtx, _anchor?: HTMLElement): void {
  const m = modal('Export', { wide: true, className: 'exp-dlg' });
  const dl = matchMedia('(pointer: coarse)').matches ? 'Save…' : 'Download'; // a phone saves through the share sheet
  const project = ctx.session.project;
  const name = safeFilename(plainTitle(project.meta), 'Book');
  const isChrome = /Chrome\//.test(navigator.userAgent) && !/Edg\//.test(navigator.userAgent) || /Edg\//.test(navigator.userAgent);

  const run = async (label: string, fn: () => Promise<void>) => {
    const done = toast(`Preparing ${label}…`, { timeout: 0 });
    try { await ctx.flush(); await fn(); done(); }
    catch (e: any) { done(); console.error(e); toast(`${label} export failed: ${e.message || e}`, { kind: 'error', timeout: 7000 }); }
  };

  const check = (label: string, checked: boolean, title = '') => {
    const c = h('input', { type: 'checkbox' }) as HTMLInputElement;
    c.checked = checked;
    return { el: h('label', { title }, c, label), get value() { return c.checked; } };
  };
  const bleed = check('Add ⅛″ bleed', false, 'For printers that trim the page: adds 0.125 in to the outside, top and bottom edges (KDP / IngramSpark interiors with bleed).');
  const white = check('White paper', true, 'Print on white. Turn off to keep the cream page tint in the PDF.');
  const blanks = check('Keep blank pages', true, 'Blank left-hand pages keep chapters on right-hand pages in print. Turn off for an on-screen PDF.');
  const fonts = check('Embed fonts', true, 'Include the template’s fonts in the EPUB (free SIL Open Font License fonts).');

  const item = (badge: string, color: string, title: string, desc: string, action: HTMLElement, extra?: HTMLElement) =>
    h('div', { class: 'exp-item' }, h('div', { class: 'exp-badge', style: { background: color } }, badge),
      h('div', null, h('h4', null, title), h('p', null, desc), extra || null), action);

  const pdfBtn = button('Save PDF…', { class: 'primary', onClick: () => void run('PDF', async () => {
    const { printBook } = await import('../export/pdf.ts');
    m.close();
    await printBook(ctx.book, { bleed: bleed.value, whitePaper: white.value, blanks: blanks.value, title: name });
  }) });

  m.body.append(
    h('div', { class: 'exp-list' },
      item('PDF', '#7A1E1E', 'Print-ready PDF',
        isIOS() ? 'Exactly the pages you see, at the trim size, with the fonts embedded. In the print sheet, tap the Share button, then Save to Files (or AirDrop it).'
          : `Exactly the pages you see, at the trim size, with the fonts embedded. In the print dialog choose “Save as PDF”${isChrome ? '' : ' (Chrome gives the most faithful result)'}, and leave margins at “Default” and scale at 100%.`,
        pdfBtn, h('div', { class: 'exp-opts' }, bleed.el, white.el, blanks.el)),
      item('EPUB', '#2E4A33', 'EPUB e-book', 'Reflowable EPUB 3 for Apple Books, Kobo and other readers, with your chapters, contents, footnotes and template styling.',
        button(dl, { onClick: () => void run('EPUB', async () => { const { exportEpub } = await import('../export/epub.ts'); downloadBlob(await exportEpub(project, ctx.session.sections, { embedFonts: fonts.value }), `${name}.epub`); }) }),
        h('div', { class: 'exp-opts' }, fonts.el)),
      item('DOCX', '#1F3557', 'Word document', 'For editors and agents: real Word styles, footnotes, drop caps, page size and margins. Word uses the template’s fonts if they’re installed on your computer (all are free on Google Fonts); otherwise it substitutes. The Manuscript template produces a standard submission file (Times New Roman, 12 pt, double-spaced).',
        button(dl, { onClick: () => void run('DOCX', async () => { const { exportDocx } = await import('../export/docx.ts'); downloadBlob(await exportDocx(project, ctx.session.sections), `${name}.docx`); }) })),
      item('HTML', '#5A4A2A', 'Web page', 'One self-contained .html file with fonts and images inside. Opens in any browser, offline.',
        button(dl, { onClick: () => void run('HTML', async () => { const { exportHtml } = await import('../export/html.ts'); downloadBlob(await exportHtml(project, ctx.session.sections), `${name}.html`); }) })),
      item('MD', '#4A4F57', 'Markdown', 'The whole manuscript as one Markdown file with YAML front matter (a .zip if it has images).',
        button(dl, { onClick: () => void run('Markdown', async () => { const { exportMarkdown } = await import('../export/markdown.ts'); const r = await exportMarkdown(project, ctx.session.sections); downloadBlob(r.blob, `${name}.${r.ext}`); }) })),
      item('ZIP', '#6B6259', 'Backup of this book', 'Every chapter as a Markdown file plus the design settings. Restore it from the library with Import.',
        button(dl, { onClick: () => void run('Backup', async () => { const { exportBackup } = await import('../storage/backup.ts'); downloadBlob(await exportBackup({ includeHistory: false, projectIds: [project.id] }), `${name} (SerifWriter).zip`); }) })),
    ),
  );
  m.footer.append(button('Close', { onClick: () => m.close() }));
}
