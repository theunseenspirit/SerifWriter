import type { Project, Section } from '../model/types.ts';
import { collectBook, xmlEscape as x, extFor, type FlowSection } from './common.ts';
import { FONTS } from '../typeset/fonts.ts';
import { pageSize, paragraphIndent, indentsParagraphs } from '../templates/index.ts';
import { roundedWords } from '../model/words.ts';

// DOCX (Office Open XML), written by hand: styles that follow the template,
// real Word footnotes, numbered/bulleted lists, tables, images, page size and
// mirrored margins, page numbers, and Word's own drop-cap frames.

const enc = new TextEncoder();
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

interface Fmt { abbr?: boolean; b?: boolean; i?: boolean; strike?: boolean; code?: boolean; sup?: boolean; sub?: boolean; caps?: boolean; u?: boolean }

class DocxWriter {
  body: string[] = [];
  footnotes: string[] = [];
  rels: string[] = [];
  media: { name: string; data: Uint8Array }[] = [];
  nums: string[] = [];
  private relId = 10;
  private fnId = 1;
  private numId = 1;
  private imgId = 1;
  textWidthEmu: number;
  constructor(textWidthIn: number) { this.textWidthEmu = Math.round(textWidthIn * 914400); }

  rel(type: string, target: string, external = false): string {
    const id = `rId${++this.relId}`;
    this.rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${x(target)}"${external ? ' TargetMode="External"' : ''}/>`);
    return id;
  }

  newList(ordered: boolean, start = 1): number {
    const id = ++this.numId;
    this.nums.push(`<w:num w:numId="${id}"><w:abstractNumId w:val="${ordered ? 1 : 0}"/>${ordered ? `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="${start}"/></w:lvlOverride>` : ''}</w:num>`);
    return id;
  }

  footnote(paragraphsXml: string): number {
    const id = this.fnId++;
    const ref = '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>';
    const xml = paragraphsXml.includes('</w:pPr>') ? paragraphsXml.replace('</w:pPr>', `</w:pPr>${ref}`) : `<w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>${ref}</w:p>`;
    this.footnotes.push(`<w:footnote w:id="${id}">${xml}</w:footnote>`);
    return id;
  }

  async image(blob: Blob, type: string, alt: string): Promise<string> {
    const n = this.imgId++;
    const name = `image${n}.${extFor(type)}`;
    this.media.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
    const rid = this.rel('image', `media/${name}`);
    let w = 600;
    let h = 400;
    try { const bmp = await createImageBitmap(blob); w = bmp.width; h = bmp.height; bmp.close(); } catch { /* keep default */ }
    let cx = w * 9525;
    let cy = h * 9525;
    if (cx > this.textWidthEmu) { cy = Math.round(cy * this.textWidthEmu / cx); cx = this.textWidthEmu; }
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Picture ${n}" descr="${x(alt)}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  }
}

const rPr = (f: Fmt) => {
  const p: string[] = [];
  if (f.b) p.push('<w:b/>');
  if (f.i) p.push('<w:i/>');
  if (f.caps) p.push('<w:smallCaps/>');
  if (f.strike) p.push('<w:strike/>');
  if (f.u) p.push('<w:u w:val="single"/>');
  if (f.code) p.push('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:sz w:val="18"/>');
  if (f.sup) p.push('<w:vertAlign w:val="superscript"/>');
  if (f.sub) p.push('<w:vertAlign w:val="subscript"/>');
  return p.length ? `<w:rPr>${p.join('')}</w:rPr>` : '';
};
const run = (text: string, f: Fmt) => text ? `<w:r>${rPr(f)}<w:t xml:space="preserve">${x(text)}</w:t></w:r>` : '';

interface Ctx { w: DocxWriter; book: Awaited<ReturnType<typeof collectBook>>; notes: Map<string, HTMLElement>; sceneGlyph: string }

async function inlineRuns(node: Node, f: Fmt, ctx: Ctx): Promise<string> {
  let out = '';
  for (const n of Array.from(node.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE) { const t = (n as Text).data.replace(/\s+/g, ' '); out += run(f.abbr ? t.toLowerCase() : t, f); continue; }
    if (n.nodeType !== Node.ELEMENT_NODE) continue;
    const el = n as HTMLElement;
    const tag = el.tagName;
    if (el.classList.contains('fn-ref')) {
      const note = ctx.notes.get(el.dataset.fn || '');
      if (note) {
        const clone = note.cloneNode(true) as HTMLElement;
        clone.querySelector('.fn-num')?.remove();
        const paras = await blockXml(clone, ctx, 'FootnoteText');
        const id = ctx.w.footnote(paras || '<w:p></w:p>');
        out += `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;
      }
      continue;
    }
    if (el.dataset.tex) { out += run(el.dataset.tex, { ...f, i: true }); continue; } // Word has no MathML; keep the TeX
    if (tag === 'BR') { out += '<w:r><w:br/></w:r>'; continue; }
    if (tag === 'IMG') {
      const src = el.getAttribute('src') || '';
      const a = src.startsWith('asset-export:') ? ctx.book.assets.get(src.slice(13)) : undefined;
      out += a ? await ctx.w.image(a.blob, a.type, el.getAttribute('alt') || '') : run(el.getAttribute('alt') || '', f);
      continue;
    }
    if (tag === 'INPUT') { out += run((el as HTMLInputElement).checked ? '☒ ' : '☐ ', f); continue; }
    if (tag === 'svg' || tag === 'SVG') continue;
    if (tag === 'A') {
      const href = el.getAttribute('href') || '';
      const inner = await inlineRuns(el, { ...f, u: true }, ctx);
      if (/^(https?:|mailto:)/.test(href)) out += `<w:hyperlink r:id="${ctx.w.rel('hyperlink', href, true)}">${inner.replace(/<w:rPr>/g, '<w:rPr><w:rStyle w:val="Hyperlink"/>').replace(/<w:r><w:t/g, '<w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t')}</w:hyperlink>`;
      else out += inner;
      continue;
    }
    const nf: Fmt = { ...f };
    if (tag === 'EM' || tag === 'I' || tag === 'CITE' || tag === 'DFN' || tag === 'VAR') nf.i = !f.i;
    if (tag === 'STRONG' || tag === 'B') nf.b = true;
    if (tag === 'DEL' || tag === 'S') nf.strike = true;
    if (tag === 'U' || tag === 'INS') nf.u = true;
    if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') nf.code = true;
    if (tag === 'SUP') nf.sup = true;
    if (tag === 'SUB') nf.sub = true;
    if (el.classList.contains('lead-in')) nf.caps = true;
    if (el.classList.contains('abbr')) nf.caps = nf.abbr = true; // Word's small caps act on lower case
    out += await inlineRuns(el, nf, ctx);
  }
  return out;
}

const para = (style: string, content: string, extra = '') => `<w:p><w:pPr><w:pStyle w:val="${style}"/>${extra}</w:pPr>${content}</w:p>`;

async function blockXml(root: HTMLElement, ctx: Ctx, defaultStyle = 'Normal', list?: { numId: number; level: number }): Promise<string> {
  let out = '';
  for (const n of Array.from(root.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE) {
      if ((n as Text).data.trim()) out += para(defaultStyle, run((n as Text).data.trim(), {}));
      continue;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) continue;
    const el = n as HTMLElement;
    const tag = el.tagName;
    const c = el.classList;
    if (tag === 'P' || tag === 'DT' || tag === 'DD' || tag === 'FIGCAPTION') {
      let style = defaultStyle;
      if (defaultStyle === 'Normal' && (c.contains('first') || c.contains('dropcap') || c.contains('after-break') || c.contains('noindent'))) style = 'FirstParagraph';
      if (c.contains('attrib')) style = 'Attribution';
      if (tag === 'FIGCAPTION') style = 'Caption';
      const numPr = list ? `<w:numPr><w:ilvl w:val="${list.level}"/><w:numId w:val="${list.numId}"/></w:numPr>` : '';
      if (c.contains('dropcap') && ctx.book.settings.dropCap.enabled) {
        // Word drop cap: the first letter in its own framed paragraph
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const t = walker.nextNode() as Text | null;
        const m = t ? /^(\s*[“"‘'(]*\S)/u.exec(t.data) : null;
        if (t && m) {
          t.data = t.data.slice(m[0].length);
          const st = ctx.book.settings;
          const lineTw = Math.round(st.dropCap.lines * st.type.size * 1.2 * st.type.leading * 20);
          out += `<w:p><w:pPr><w:pStyle w:val="FirstParagraph"/><w:keepNext/><w:framePr w:dropCap="drop" w:lines="${st.dropCap.lines}" w:wrap="around" w:vAnchor="text" w:hAnchor="text"/><w:spacing w:after="0" w:line="${lineTw}" w:lineRule="exact"/><w:ind w:firstLine="0"/><w:textAlignment w:val="baseline"/></w:pPr><w:r><w:rPr><w:rStyle w:val="DropCap"/><w:position w:val="-4"/><w:sz w:val="${Math.round(lineTw / 10)}"/></w:rPr><w:t>${x(m[0].trim())}</w:t></w:r></w:p>`;
        }
      }
      const lvl = /\bind(\d)\b/.exec(el.className)?.[1];
      out += para(style, await inlineRuns(el, {}, ctx), numPr + (lvl ? `<w:ind w:left="${+lvl * 480}" w:firstLine="0"/><w:jc w:val="left"/>` : ''));
      continue;
    }
    if (/^H[1-6]$/.test(tag)) {
      const style = c.contains('h-section') ? 'Heading2' : c.contains('h-subsection') ? 'Heading3' : 'Heading4';
      out += para(style, await inlineRuns(el, {}, ctx));
      continue;
    }
    if (tag === 'HEADER' && c.contains('opener')) {
      const label = el.querySelector('.op-label')?.textContent || '';
      if (label) out += para('ChapterLabel', run(label, {}), '<w:pageBreakBefore/>');
      out += para('Heading1', await inlineRuns(el.querySelector('.op-title') || el, {}, ctx), label ? '' : '<w:pageBreakBefore/>');
      continue;
    }
    if (c.contains('inflow-part')) {
      out += para('ChapterLabel', run(el.querySelector('.pt-label')?.textContent || '', {}), '<w:pageBreakBefore/>');
      out += para('PartTitle', await inlineRuns(el.querySelector('.pt-title') || el, {}, ctx));
      continue;
    }
    if (c.contains('scene-break')) { out += para('SceneBreak', run(ctx.sceneGlyph, {})); continue; }
    if (c.contains('force-break')) { out += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'; continue; }
    if (tag === 'BLOCKQUOTE') { out += await blockXml(el, ctx, defaultStyle === 'Normal' ? 'Quote' : defaultStyle); continue; }
    if (tag === 'UL' || tag === 'OL') {
      const numId = ctx.w.newList(tag === 'OL', Number(el.getAttribute('start') || 1));
      const level = list && list.numId !== numId ? Math.min(8, list.level + 1) : 0;
      for (const li of Array.from(el.children) as HTMLElement[]) {
        if (li.tagName !== 'LI') continue;
        const hasBlocks = Array.from(li.children).some((k) => /^(P|UL|OL|BLOCKQUOTE|PRE)$/.test(k.tagName));
        if (hasBlocks) out += await blockXml(li, ctx, 'ListParagraph', { numId, level });
        else out += para('ListParagraph', await inlineRuns(li, {}, ctx), `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`);
      }
      continue;
    }
    if (tag === 'PRE') {
      for (const line of (el.textContent || '').replace(/\n$/, '').split('\n')) out += para('Code', run(line, { code: true }));
      continue;
    }
    if (tag === 'TABLE') {
      const rows = Array.from(el.querySelectorAll('tr'));
      const cols = Math.max(1, ...rows.map((r) => r.children.length));
      const colW = Math.floor((ctx.w.textWidthEmu / 635) / cols);
      let t = `<w:tbl><w:tblPr><w:tblStyle w:val="BookTable"/><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid>${'<w:gridCol w:w="' + colW + '"/>'.repeat(cols)}</w:tblGrid>`;
      for (const r of rows) {
        const header = r.parentElement?.tagName === 'THEAD';
        t += `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}`;
        for (const cell of Array.from(r.children) as HTMLElement[]) {
          t += `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/>${header ? '<w:tcBorders><w:bottom w:val="single" w:sz="8" w:color="000000"/></w:tcBorders>' : ''}</w:tcPr>${para('TableText', await inlineRuns(cell, header ? { caps: true } : {}, ctx))}</w:tc>`;
        }
        t += '</w:tr>';
      }
      out += `${t}</w:tbl>${para('Normal', '')}`;
      continue;
    }
    if (tag === 'FIGURE') {
      const img = el.querySelector('img');
      if (img) { const only = document.createElement('span'); only.appendChild(img.cloneNode()); out += para('Figure', await inlineRuns(only, {}, ctx)); }
      const cap = el.querySelector('figcaption');
      if (cap) out += para('Caption', await inlineRuns(cap, {}, ctx));
      continue;
    }
    if (tag === 'HR') { out += para('SceneBreak', run(ctx.sceneGlyph, {})); continue; }
    out += await blockXml(el, ctx, defaultStyle, list);
  }
  return out;
}

function stylesXml(font: string, display: string, size: number, leading: number, indentTw: number, justify: boolean, accent: string, manuscript: boolean): string {
  const sz = Math.round(size * 2);
  const line = Math.round(240 * leading);
  const jc = justify ? 'both' : 'left';
  const acc = accent.replace('#', '');
  const st = (id: string, name: string, body: string, type = 'paragraph', based = 'Normal', next = '') =>
    `<w:style w:type="${type}" w:styleId="${id}"><w:name w:val="${name}"/>${based ? `<w:basedOn w:val="${based}"/>` : ''}${next ? `<w:next w:val="${next}"/>` : ''}<w:qFormat/>${body}</w:style>`;
  const caps = manuscript ? '' : '<w:caps/><w:spacing w:val="40"/>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W_NS}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${x(font)}" w:hAnsi="${x(font)}" w:eastAsia="${x(font)}" w:cs="${x(font)}"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="${line}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:firstLine="${indentTw}"/><w:jc w:val="${jc}"/><w:widowControl/></w:pPr></w:style>
${st('FirstParagraph', 'First Paragraph', '<w:pPr><w:ind w:firstLine="0"/></w:pPr>', 'paragraph', 'Normal', 'Normal')}
${st('Title', 'Title', `<w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:before="${manuscript ? 0 : 2400}" w:after="240"/></w:pPr><w:rPr><w:rFonts w:ascii="${x(display)}" w:hAnsi="${x(display)}"/>${caps}<w:sz w:val="${manuscript ? sz : sz * 2.6 | 0}"/></w:rPr>`)}
${st('Subtitle', 'Subtitle', `<w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:after="240"/></w:pPr><w:rPr><w:i/><w:sz w:val="${manuscript ? sz : sz * 1.2 | 0}"/></w:rPr>`)}
${st('Author', 'Author', `<w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:before="${manuscript ? 0 : 1200}"/></w:pPr><w:rPr>${caps}<w:sz w:val="${manuscript ? sz : sz * 1.25 | 0}"/></w:rPr>`)}
${st('Publisher', 'Publisher', `<w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:before="2400"/></w:pPr><w:rPr>${caps}<w:sz w:val="${sz * 0.85 | 0}"/></w:rPr>`)}
${st('ChapterLabel', 'Chapter Label', `<w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:before="${manuscript ? 2880 : 2400}" w:after="120"/><w:keepNext/></w:pPr><w:rPr>${caps}${manuscript ? '' : `<w:color w:val="${acc}"/>`}<w:sz w:val="${manuscript ? sz : sz * 0.9 | 0}"/></w:rPr>`)}
${st('Heading1', 'heading 1', `<w:pPr><w:keepNext/><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:after="${manuscript ? line : 720}"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:ascii="${x(display)}" w:hAnsi="${x(display)}"/>${caps}<w:sz w:val="${manuscript ? sz : sz * 1.9 | 0}"/></w:rPr>`, 'paragraph', 'Normal', 'FirstParagraph')}
${st('PartTitle', 'Part Title', `<w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:ascii="${x(display)}" w:hAnsi="${x(display)}"/>${caps}<w:sz w:val="${sz * 2}"/></w:rPr>`)}
${st('Heading2', 'heading 2', `<w:pPr><w:keepNext/><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:before="${line}" w:after="${line / 2 | 0}"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr>${caps}<w:sz w:val="${manuscript ? sz : sz * 0.9 | 0}"/></w:rPr>`, 'paragraph', 'Normal', 'FirstParagraph')}
${st('Heading3', 'heading 3', `<w:pPr><w:keepNext/><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:before="${line}" w:after="${line / 2 | 0}"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:i/></w:rPr>`, 'paragraph', 'Normal', 'FirstParagraph')}
${st('Heading4', 'heading 4', `<w:pPr><w:keepNext/><w:ind w:firstLine="0"/><w:spacing w:before="${line / 2 | 0}"/><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:smallCaps/></w:rPr>`, 'paragraph', 'Normal', 'FirstParagraph')}
${st('Quote', 'Quote', '<w:pPr><w:ind w:left="720" w:right="720" w:firstLine="0"/><w:spacing w:before="120" w:after="120"/></w:pPr>')}
${st('Attribution', 'Attribution', '<w:pPr><w:jc w:val="right"/><w:ind w:firstLine="0"/></w:pPr>')}
${st('SceneBreak', 'Scene Break', `<w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:before="120" w:after="120"/><w:keepNext/></w:pPr>${manuscript ? '' : `<w:rPr><w:color w:val="${acc}"/></w:rPr>`}`, 'paragraph', 'Normal', 'FirstParagraph')}
${st('Code', 'Code', '<w:pPr><w:ind w:left="360" w:firstLine="0"/><w:jc w:val="left"/><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:sz w:val="18"/></w:rPr>')}
${st('ListParagraph', 'List Paragraph', '<w:pPr><w:ind w:left="720" w:hanging="360"/><w:jc w:val="left"/></w:pPr>')}
${st('Figure', 'Figure', '<w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:before="120" w:after="60"/></w:pPr>')}
${st('Caption', 'caption', `<w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:after="120"/></w:pPr><w:rPr><w:i/><w:sz w:val="${sz * 0.85 | 0}"/></w:rPr>`)}
${st('TableText', 'Table Text', `<w:pPr><w:ind w:firstLine="0"/><w:jc w:val="left"/><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="${sz * 0.9 | 0}"/></w:rPr>`)}
${st('Copyright', 'Copyright', `<w:pPr><w:ind w:firstLine="0"/><w:jc w:val="left"/><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="${sz * 0.78 | 0}"/></w:rPr>`)}
${st('Dedication', 'Dedication', '<w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:i/></w:rPr>')}
${st('Epigraph', 'Epigraph', '<w:pPr><w:ind w:left="720" w:right="720" w:firstLine="0"/><w:jc w:val="left"/></w:pPr><w:rPr><w:i/></w:rPr>')}
${st('FootnoteText', 'footnote text', `<w:pPr><w:ind w:firstLine="0"/><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="${Math.max(16, sz * 0.8 | 0)}"/></w:rPr>`)}
${st('FootnoteReference', 'footnote reference', '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>', 'character', '')}
${st('Hyperlink', 'Hyperlink', '<w:rPr><w:u w:val="none"/></w:rPr>', 'character', '')}
${st('DropCap', 'Drop Cap', `<w:rPr><w:rFonts w:ascii="${x(display)}" w:hAnsi="${x(display)}"/><w:color w:val="${acc}"/></w:rPr>`, 'character', '')}
${st('Header', 'header', '<w:pPr><w:ind w:firstLine="0"/><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="' + (manuscript ? sz : (sz * 0.82) | 0) + '"/></w:rPr>')}
<w:style w:type="table" w:styleId="BookTable"><w:name w:val="Book Table"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="8" w:color="000000"/><w:bottom w:val="single" w:sz="8" w:color="000000"/><w:insideH w:val="single" w:sz="2" w:color="999999"/></w:tblBorders><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;
}

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W_NS}>
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${[0, 1, 2, 3, 4, 5, 6, 7, 8].map((l) => `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${['•', '◦', '▪'][l % 3]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + l * 360}" w:hanging="360"/></w:pPr></w:lvl>`).join('')}</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${[0, 1, 2, 3, 4, 5, 6, 7, 8].map((l) => `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${['decimal', 'lowerLetter', 'lowerRoman'][l % 3]}"/><w:lvlText w:val="%${l + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + l * 360}" w:hanging="360"/></w:pPr></w:lvl>`).join('')}</w:abstractNum>
__NUMS__
</w:numbering>`;

export async function exportDocx(project: Project, sections: Section[]): Promise<Blob> {
  const { zipSync } = await import('fflate');
  const book = await collectBook(project, sections);
  const s = book.settings;
  const manuscript = s.titlePage.layout === 'manuscript' || s.runningHeads.manuscript;
  const ps = pageSize(s);
  const m = s.page.margins;
  const textW = ps.w - m.inside - m.outside;
  const w = new DocxWriter(textW);
  const font = manuscript ? 'Times New Roman' : FONTS[s.type.body].name;
  const display = manuscript ? font : FONTS[s.type.display].name;
  const indentTw = Math.round(paragraphIndent(s) * s.type.size * 20);
  const sceneGlyph = s.sceneBreak === 'hash' ? '#' : s.sceneBreak === 'stars' ? '* * *' : s.sceneBreak === 'space' ? '' : '⁂';
  const meta = project.meta;
  const words = sections.reduce((n, x) => n + (x.kind === 'title' || x.kind === 'toc' ? 0 : x.words), 0);

  // title page
  if (manuscript) {
    const contact = [meta.extra.legal_name || meta.author, meta.extra.address || meta.extra.contact || '', meta.extra.email || '', meta.extra.phone || ''].filter(Boolean).join('\n');
    w.body.push(`<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top w:val="nil"/><w:bottom w:val="nil"/><w:insideH w:val="nil"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid><w:tr><w:tc>${contact.split('\n').map((l) => para('TableText', run(l, {}))).join('')}</w:tc><w:tc>${para('TableText', run(`about ${roundedWords(words)} words`, {}), '<w:jc w:val="right"/>')}</w:tc></w:tr></w:tbl>`);
    w.body.push(para('Title', run(meta.title.replace(/\s*\n\s*/g, ' ').toUpperCase(), {}), '<w:spacing w:before="4320"/>'));
    if (meta.subtitle) w.body.push(para('Subtitle', run(meta.subtitle, {})));
    w.body.push(para('Author', run(`by ${meta.extra.pen_name || meta.author}`, {})));
  } else {
    meta.title.split('\n').forEach((line, i) => w.body.push(para('Title', run(line.trim(), {}), i ? '<w:spacing w:before="0"/>' : '')));
    if (meta.subtitle) w.body.push(para('Subtitle', run(meta.subtitle, {})));
    if (meta.author) w.body.push(para('Author', run(meta.author, {})));
    if (meta.publisher || meta.year) w.body.push(para('Publisher', run([meta.publisher, meta.year].filter(Boolean).join(' · '), {})));
  }

  for (const f of book.sections) {
    if (f.kind === 'title') continue;
    const ctx: Ctx = { w, book, notes: new Map(f.notes.map((n) => [n.id, n.el])), sceneGlyph };
    const breakBefore = '<w:pageBreakBefore/>';
    if (f.kind === 'copyright') { w.body.push(para('Copyright', '', breakBefore + '<w:spacing w:before="4000"/>')); w.body.push(await blockXml(f.body, ctx, 'Copyright')); continue; }
    if (f.kind === 'dedication') { w.body.push(para('Dedication', '', breakBefore + '<w:spacing w:before="2400"/>')); w.body.push(await blockXml(f.body, ctx, 'Dedication')); continue; }
    if (f.kind === 'epigraph') { w.body.push(para('Epigraph', '', breakBefore + '<w:spacing w:before="2400"/>')); w.body.push(await blockXml(f.body, ctx, 'Epigraph')); continue; }
    if (f.kind === 'part') {
      w.body.push(para('ChapterLabel', run(f.label, {}), breakBefore));
      w.body.push(para('PartTitle', await inlineRuns(htmlEl(f.titleHtml), {}, ctx)));
      w.body.push(await blockXml(f.body, ctx, 'Dedication'));
      continue;
    }
    w.body.push(f.label ? para('ChapterLabel', run(f.label, {}), breakBefore) : '');
    w.body.push(para('Heading1', await inlineRuns(htmlEl(f.titleHtml), {}, ctx), f.label ? '' : `${breakBefore}<w:spacing w:before="2400"/>`));
    if (f.subtitleHtml) w.body.push(para('Subtitle', await inlineRuns(htmlEl(f.subtitleHtml), {}, ctx)));
    w.body.push(await blockXml(f.body, ctx));
  }

  // header/footer
  const surname = meta.extra.surname || (meta.author || 'Author').trim().split(/\s+/).pop() || 'Author';
  const pageField = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>';
  const headerXml = manuscript
    ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${W_NS}><w:p><w:pPr><w:pStyle w:val="Header"/><w:jc w:val="right"/></w:pPr>${run(`${surname} / ${(meta.extra.short_title || meta.title.replace(/\s*\n\s*/g, ' ')).toUpperCase()} / `, {})}${pageField}</w:p></w:hdr>`
    : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${W_NS}><w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr>${run(meta.title.replace(/\s*\n\s*/g, ' ').toUpperCase(), {})}</w:p></w:hdr>`;
  const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${W_NS}><w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr>${manuscript ? '' : pageField}</w:p></w:ftr>`;
  const hdrId = w.rel('header', 'header1.xml');
  const ftrId = w.rel('footer', 'footer1.xml');
  const tw = (inches: number) => Math.round(inches * 1440);
  const sectPr = `<w:sectPr><w:headerReference w:type="default" r:id="${hdrId}"/><w:footerReference w:type="default" r:id="${ftrId}"/><w:pgSz w:w="${tw(ps.w)}" w:h="${tw(ps.h)}"/><w:pgMar w:top="${tw(m.top)}" w:right="${tw(m.outside)}" w:bottom="${tw(m.bottom)}" w:left="${tw(m.inside)}" w:header="${tw(Math.max(0.3, m.top - s.page.headSep - 0.15))}" w:footer="${tw(Math.max(0.3, m.bottom - s.page.footSkip))}" w:gutter="0"/><w:titlePg/></w:sectPr>`;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W_NS}><w:body>${w.body.join('')}${sectPr}</w:body></w:document>`;
  const footnotesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes ${W_NS}><w:footnote w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>${w.footnotes.join('')}</w:footnotes>`;
  const settingsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings ${W_NS}>${s.page.twoSided ? '<w:mirrorMargins/>' : ''}<w:defaultTabStop w:val="720"/><w:autoHyphenation w:val="${s.type.hyphenate ? 'true' : 'false'}"/><w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
${w.rels.join('\n')}
</Relationships>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const exts = [...new Set(w.media.map((m2) => m2.name.split('.').pop()!))];
  const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bin: 'application/octet-stream' };
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${exts.map((e) => `<Default Extension="${e}" ContentType="${mime[e] || 'application/octet-stream'}"/>`).join('\n')}
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`),
    '_rels/.rels': enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`),
    'docProps/core.xml': enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(book.title)}</dc:title><dc:creator>${x(meta.author)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`),
    'docProps/app.xml': enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>SerifWriter</Application><Words>${words}</Words></Properties>`),
    'word/document.xml': enc.encode(documentXml),
    'word/styles.xml': enc.encode(stylesXml(font, display, manuscript ? 12 : s.type.size, manuscript ? 2 : s.type.leading, manuscript ? (indentsParagraphs(s) ? 720 : 0) : indentTw, manuscript ? false : s.type.justify, s.color.accent, manuscript)),
    'word/settings.xml': enc.encode(settingsXml),
    'word/numbering.xml': enc.encode(NUMBERING.replace('__NUMS__', w.nums.join('\n'))),
    'word/footnotes.xml': enc.encode(footnotesXml),
    'word/header1.xml': enc.encode(headerXml),
    'word/footer1.xml': enc.encode(footerXml),
    'word/_rels/document.xml.rels': enc.encode(docRels),
  };
  for (const md of w.media) files[`word/media/${md.name}`] = md.data;
  const data = zipSync(files, { level: 6 });
  return new Blob([data as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

function htmlEl(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}
export type { FlowSection };
