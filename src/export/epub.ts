import type { Project, Section } from '../model/types.ts';
import { collectBook, reflowCss, xmlEscape, extFor, fetchBytes, type FlowSection } from './common.ts';
import { FONTS, fontUrl } from '../typeset/fonts.ts';
import { escapeHtml } from '../util.ts';

// EPUB 3: one XHTML file per section, a navigation document, the template's
// fonts embedded (SIL OFL allows it), images included, popup footnotes.

const enc = new TextEncoder();
const serializer = () => new XMLSerializer();

function xhtml(title: string, lang: string, body: string, bodyType = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}">
<head><meta charset="UTF-8"/><title>${xmlEscape(title)}</title><link rel="stylesheet" type="text/css" href="css/book.css"/></head>
<body${bodyType ? ` epub:type="${bodyType}"` : ''}>
${body}
</body>
</html>`;
}

/** Serialises an HTML element's children as well-formed XHTML. */
function inner(el: Element): string {
  const s = serializer();
  return Array.from(el.childNodes).map((n) => s.serializeToString(n)).join('').replace(/ xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/g, '');
}

function sectionBody(f: FlowSection, n: number, assetPath: (id: string) => string): string {
  // footnote references → noteref links; notes → asides
  for (const ref of Array.from(f.body.querySelectorAll<HTMLElement>('sup.fn-ref'))) {
    const a = document.createElement('a');
    a.setAttribute('class', 'noteref');
    a.setAttribute('href', `#n${n}-${ref.dataset.fn}`);
    a.setAttribute('epub:type', 'noteref');
    a.setAttribute('id', `r${n}-${ref.dataset.fn}`);
    a.textContent = ref.textContent;
    ref.replaceWith(a);
  }
  for (const img of Array.from(f.body.querySelectorAll('img'))) {
    const src = img.getAttribute('src') || '';
    if (src.startsWith('asset-export:')) img.setAttribute('src', assetPath(src.slice(13)));
    else if (/^(https?:|blob:)/.test(src)) img.replaceWith(document.createTextNode(img.getAttribute('alt') || ''));
    if (!img.getAttribute('alt')) img.setAttribute('alt', '');
  }
  for (const el of Array.from(f.body.querySelectorAll('input'))) el.remove();
  let notes = '';
  if (f.notes.length) {
    notes = `<section class="footnotes" epub:type="footnotes">${f.notes.map(({ id, el }) => {
      const num = el.querySelector('.fn-num');
      num?.remove();
      return `<aside class="fn" epub:type="footnote" id="n${n}-${id}"><p><a href="#r${n}-${id}" class="fn-num">${Number(id) + 1}</a> ${inner(el).replace(/^<p[^>]*>|<\/p>$/g, '')}</p></aside>`;
    }).join('\n')}</section>`;
  }
  return inner(f.body) + notes;
}

export async function exportEpub(project: Project, sections: Section[], opts: { embedFonts: boolean }): Promise<Blob> {
  const { zipSync } = await import('fflate');
  const book = await collectBook(project, sections);
  const s = book.settings;
  const lang = project.meta.language || 'en';
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
  const manifest: string[] = [];
  const spine: string[] = [];
  const navItems: string[] = [];
  const add = (path: string, data: string | Uint8Array, type: string, id: string, props = '') => {
    files[`OEBPS/${path}`] = typeof data === 'string' ? enc.encode(data) : data;
    manifest.push(`<item id="${id}" href="${path}" media-type="${type}"${props ? ` properties="${props}"` : ''}/>`);
  };

  // fonts
  const fam = { body: 'serif', display: 'serif' };
  let fontCss = '';
  if (opts.embedFonts) {
    const used = [...new Set([s.type.body, s.type.display])];
    for (const id of used) {
      const f = FONTS[id];
      for (const face of f.faces) {
        const bytes = await fetchBytes(fontUrl(face.file));
        add(`fonts/${face.file}`, bytes, 'font/woff2', `font-${face.file.replace(/\W/g, '-')}`);
        fontCss += `@font-face { font-family: "${f.name}"; src: url("../fonts/${face.file}") format("woff2"); font-weight: ${face.weight}; font-style: ${face.style}; }\n`;
      }
    }
    fam.body = `"${FONTS[s.type.body].name}", serif`;
    fam.display = `"${FONTS[s.type.display].name}", serif`;
  }
  add('css/book.css', fontCss + reflowCss(s, fam), 'text/css', 'css');

  // images
  const assetPath = (id: string) => `images/${id}.${extFor(book.assets.get(id)?.type || '')}`;
  for (const [id, a] of book.assets) add(assetPath(id), new Uint8Array(await a.blob.arrayBuffer()), a.type, `img-${id}`);

  // title page
  const meta = project.meta;
  const tp = `<section class="title-page" epub:type="titlepage"><p class="tp-title">${escapeHtml(meta.title)}</p>${meta.subtitle ? `<p class="tp-subtitle">${escapeHtml(meta.subtitle)}</p>` : ''}${meta.author ? `<p class="tp-author">${escapeHtml(meta.author)}</p>` : ''}${meta.publisher || meta.year ? `<p class="tp-publisher">${escapeHtml([meta.publisher, meta.year].filter(Boolean).join(' · '))}</p>` : ''}</section>`;
  add('title.xhtml', xhtml(book.title, lang, tp, 'frontmatter'), 'application/xhtml+xml', 'title');
  spine.push('<itemref idref="title"/>');

  book.sections.forEach((f, i) => {
    if (f.kind === 'title') return;
    const n = i + 1;
    const file = `s${String(n).padStart(3, '0')}.xhtml`;
    const id = `s${n}`;
    let body: string;
    let type = 'bodymatter';
    const content = sectionBody(f, n, assetPath);
    switch (f.kind) {
      case 'copyright': body = `<section class="front copyright" epub:type="copyright-page">${content}</section>`; type = 'frontmatter'; break;
      case 'dedication': body = `<section class="front dedication" epub:type="dedication">${content}</section>`; type = 'frontmatter'; break;
      case 'epigraph': body = `<section class="front epigraph" epub:type="epigraph">${content}</section>`; type = 'frontmatter'; break;
      case 'part': body = `<section class="part" epub:type="part"><p class="op-label">${escapeHtml(f.label)}</p><h1>${f.titleHtml}</h1>${content ? `<div class="part-body">${content}</div>` : ''}</section>`; break;
      case 'about': body = `<section class="chapter" epub:type="appendix"><header class="opener"><h1>${f.titleHtml}</h1></header>${content}</section>`; type = 'backmatter'; break;
      default: body = `<section class="chapter" epub:type="chapter"><header class="opener">${f.label ? `<p class="op-label">${escapeHtml(f.label)}</p>` : ''}<h1>${f.titleHtml}</h1>${f.subtitleHtml ? `<p class="op-sub">${f.subtitleHtml}</p>` : ''}</header>${content}</section>`;
    }
    // re-parse through the DOM so the output is guaranteed well-formed XHTML
    const tmp = document.createElement('div');
    tmp.innerHTML = body;
    const xml = inner(tmp).replace(/ focusable="false"/g, "");
    const props = [xml.includes('<svg') ? 'svg' : '', xml.includes('<math') ? 'mathml' : ''].filter(Boolean).join(' ');
    add(file, xhtml(f.titleText || f.kind, lang, xml, type), 'application/xhtml+xml', id, props);
    spine.push(`<itemref idref="${id}"/>`);
    if (['chapter', 'section', 'part', 'about'].includes(f.kind)) {
      const label = f.label && f.kind === 'chapter' ? `${f.label}: ` : f.kind === 'part' && f.label ? `${f.label}: ` : '';
      navItems.push(`<li><a href="${file}">${xmlEscape(label + (f.titleText || 'Untitled'))}</a></li>`);
    }
  });

  const nav = `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${navItems.join('\n')}</ol></nav>
<nav epub:type="landmarks" hidden=""><ol><li><a epub:type="titlepage" href="title.xhtml">Title Page</a></li>${navItems.length ? `<li><a epub:type="bodymatter" href="${(navItems[0].match(/href="([^"]+)"/) || [])[1]}">Start</a></li>` : ''}</ol></nav>`;
  add('nav.xhtml', xhtml('Contents', lang, nav), 'application/xhtml+xml', 'nav', 'nav');

  const uid = `urn:uuid:${project.id.replace(/^p/, '').padEnd(32, '0').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5')}`;
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${uid}</dc:identifier>
<dc:title>${xmlEscape(book.title)}</dc:title>
${meta.subtitle ? `<meta property="title-type" refines="#t">subtitle</meta>` : ''}
${meta.author ? `<dc:creator>${xmlEscape(meta.author)}</dc:creator>` : ''}
${meta.publisher ? `<dc:publisher>${xmlEscape(meta.publisher)}</dc:publisher>` : ''}
<dc:language>${xmlEscape(lang)}</dc:language>
<meta property="dcterms:modified">${modified}</meta>
</metadata>
<manifest>
${manifest.join('\n')}
</manifest>
<spine>
${spine.join('\n')}
</spine>
</package>`.replace(/<meta property="title-type" refines="#t">subtitle<\/meta>\n/, '');

  files['mimetype'] = [enc.encode('application/epub+zip'), { level: 0 }];
  files['META-INF/container.xml'] = enc.encode(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  files['OEBPS/content.opf'] = enc.encode(opf);
  // mimetype must be the first entry, stored uncompressed
  const ordered: typeof files = { mimetype: files['mimetype'] };
  for (const [k, v] of Object.entries(files)) if (k !== 'mimetype') ordered[k] = v;
  const data = zipSync(ordered as any, { level: 6 });
  return new Blob([data as BlobPart], { type: 'application/epub+zip' });
}
