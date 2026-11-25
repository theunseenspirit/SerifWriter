import type { Project, Section } from '../model/types.ts';
import { collectBook, reflowCss, fetchBytes, toBase64 } from './common.ts';
import { FONTS, fontUrl } from '../typeset/fonts.ts';
import { escapeHtml } from '../util.ts';

// A single, self-contained HTML file: fonts and images are embedded, so it
// opens anywhere, offline, forever.

export async function exportHtml(project: Project, sections: Section[]): Promise<Blob> {
  const book = await collectBook(project, sections);
  const s = book.settings;
  let fontCss = '';
  for (const id of new Set([s.type.body, s.type.display])) {
    const f = FONTS[id];
    for (const face of f.faces) {
      const b64 = toBase64(await fetchBytes(fontUrl(face.file)));
      fontCss += `@font-face{font-family:"${f.name}";src:url(data:font/woff2;base64,${b64}) format("woff2");font-weight:${face.weight};font-style:${face.style};}\n`;
    }
  }
  const css = fontCss + reflowCss(s, { body: `"${FONTS[s.type.body].name}", Georgia, serif`, display: `"${FONTS[s.type.display].name}", Georgia, serif` }, { screen: true });
  const dataUrls = new Map<string, string>();
  for (const [id, a] of book.assets) dataUrls.set(id, `data:${a.type};base64,${toBase64(new Uint8Array(await a.blob.arrayBuffer()))}`);
  const meta = project.meta;
  const parts: string[] = [];
  parts.push(`<section class="title-page"><p class="tp-title">${escapeHtml(meta.title)}</p>${meta.subtitle ? `<p class="tp-subtitle">${escapeHtml(meta.subtitle)}</p>` : ''}${meta.author ? `<p class="tp-author">${escapeHtml(meta.author)}</p>` : ''}${meta.publisher || meta.year ? `<p class="tp-publisher">${escapeHtml([meta.publisher, meta.year].filter(Boolean).join(' · '))}</p>` : ''}</section>`);
  const toc: string[] = [];
  book.sections.forEach((f, i) => {
    if (f.kind === 'title') return;
    for (const img of Array.from(f.body.querySelectorAll('img'))) {
      const src = img.getAttribute('src') || '';
      if (src.startsWith('asset-export:')) img.setAttribute('src', dataUrls.get(src.slice(13)) || '');
    }
    for (const ref of Array.from(f.body.querySelectorAll<HTMLElement>('sup.fn-ref'))) {
      ref.innerHTML = `<a href="#n${i}-${ref.dataset.fn}" id="r${i}-${ref.dataset.fn}">${ref.textContent}</a>`;
    }
    const notes = f.notes.length ? `<div class="footnotes">${f.notes.map(({ id, el }) => { el.querySelector('.fn-num')?.remove(); return `<div id="n${i}-${id}"><p><a class="fn-num" href="#r${i}-${id}">${Number(id) + 1}</a> ${el.innerHTML.replace(/^<p[^>]*>|<\/p>$/g, '')}</p></div>`; }).join('')}</div>` : '';
    const id = `s${i}`;
    const body = f.body.innerHTML + notes;
    switch (f.kind) {
      case 'copyright': parts.push(`<section class="front copyright" id="${id}">${body}</section>`); break;
      case 'dedication': parts.push(`<section class="front dedication" id="${id}">${body}</section>`); break;
      case 'epigraph': parts.push(`<section class="front epigraph" id="${id}">${body}</section>`); break;
      case 'part': parts.push(`<section class="part" id="${id}"><p class="op-label">${escapeHtml(f.label)}</p><h1>${f.titleHtml}</h1>${body ? `<div class="part-body">${body}</div>` : ''}</section>`); toc.push(`<li class="toc-part"><a href="#${id}">${escapeHtml(f.titleText)}</a></li>`); break;
      default:
        parts.push(`<section class="chapter" id="${id}"><header class="opener">${f.label ? `<p class="op-label">${escapeHtml(f.label)}</p>` : ''}<h1>${f.titleHtml}</h1>${f.subtitleHtml ? `<p class="op-sub">${f.subtitleHtml}</p>` : ''}</header>${body}</section>`);
        toc.push(`<li><a href="#${id}">${escapeHtml((f.label ? f.label + ': ' : '') + f.titleText)}</a></li>`);
    }
  });
  const tocHtml = toc.length > 1 ? `<nav class="front" aria-label="Contents"><h2 class="h-section">Contents</h2><ol style="list-style:none;padding:0;text-align:center;line-height:2">${toc.join('')}</ol></nav>` : '';
  parts.splice(1, 0, tocHtml);
  const html = `<!doctype html>
<html lang="${escapeHtml(meta.language || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="SerifWriter">
<title>${escapeHtml(book.title)}</title>
<style>
${css}
nav ol a { text-decoration: none; }
@media (prefers-color-scheme: dark) { body { background: #1d1b19; color: #e9e2d6; } th { border-color: #e9e2d6; } }
@media print { header.opener, section.part { break-before: page; } main { max-width: none; padding: 0; } }
</style>
</head>
<body>
<main>
${parts.join('\n')}
</main>
</body>
</html>`;
  return new Blob([html], { type: 'text/html' });
}
