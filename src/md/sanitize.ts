// Allow-list HTML sanitiser. Markdown may contain raw HTML (CommonMark allows
// it); imported files must never be able to run script in the app's origin.

const TAGS = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark',
  'sub', 'sup', 'small', 'code', 'pre', 'kbd', 'samp', 'var', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col', 'a', 'img', 'figure',
  'figcaption', 'span', 'div', 'section', 'abbr', 'cite', 'q', 'dfn', 'time', 'center', 'input', 'wbr', 'details', 'summary',
]);
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'svg', 'math', 'link', 'meta', 'base', 'form', 'textarea', 'select', 'button', 'frame', 'frameset', 'audio', 'video', 'canvas']);
const ATTRS = new Set(['href', 'src', 'alt', 'title', 'class', 'id', 'colspan', 'rowspan', 'align', 'start', 'reversed', 'type', 'checked', 'disabled', 'lang', 'dir', 'width', 'height', 'cite', 'datetime', 'data-line', 'data-fn', 'data-tex', 'data-idx', 'style']);
const URL_OK = /^(https?:|mailto:|tel:|#|asset:|blob:|data:image\/(png|jpe?g|gif|webp|avif);)/i;

function clean(node: Node): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.COMMENT_NODE) {
      const text = (child as Comment).data.trim().toLowerCase();
      // <!-- pagebreak --> / <!-- newpage --> become forced page breaks.
      if (text === 'pagebreak' || text === 'newpage' || text === 'page break') {
        const div = document.createElement('div');
        div.className = 'force-break page-break-marker';
        child.replaceWith(div);
      } else child.remove();
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) { el.remove(); continue; }
    if (!TAGS.has(tag)) {
      clean(el);
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (!ATTRS.has(name)) { el.removeAttribute(attr.name); continue; }
      if (name === 'href' || name === 'src' || name === 'cite') {
        const v = attr.value.trim();
        if (v && !URL_OK.test(v) && /^[a-z][a-z0-9+.-]*:/i.test(v)) el.removeAttribute(attr.name);
      } else if (name === 'style') {
        if (/url\s*\(|expression\s*\(|@import|position\s*:\s*fixed/i.test(attr.value)) el.removeAttribute(attr.name);
      }
    }
    if (tag === 'input') {
      if ((el.getAttribute('type') || '').toLowerCase() !== 'checkbox') { el.remove(); continue; }
      el.setAttribute('disabled', '');
    }
    if (tag === 'a' && el.getAttribute('href')?.match(/^https?:/)) el.setAttribute('rel', 'noopener');
    clean(el);
  }
}

export function sanitizeInto(html: string): DocumentFragment {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  clean(tpl.content);
  return tpl.content;
}
