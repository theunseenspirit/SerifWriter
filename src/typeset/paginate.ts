import type { Rendered } from './sections.ts';
import { yieldToMain } from '../util.ts';

// A small, line-accurate paginator for one section at a time.
//
// Blocks are appended to a fixed-size page box. When one overflows, a binary
// search over Range.getClientRects() finds the first line that does not fit,
// and Range.extractContents() splits the DOM there, so nested lists, quotes
// and inline formatting split cleanly. Widows/orphans, keep-with-next,
// hyphenated breaks, list numbering, table headers and page-bottom footnotes
// are handled. Work is sliced so typing is never blocked.

export interface PaginateOptions {
  widows: number;
  orphans: number;
  isCancelled: () => boolean;
  budgetMs?: number;
}

interface Pos { node: Node; offset: number }

const TEXT = 3;
const ELEMENT = 1;
const ATOMIC_TAGS = new Set(['IMG', 'SVG', 'HR', 'VIDEO', 'FIGURE', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'INPUT', 'CANVAS', 'THEAD']);
const BLOCKISH = 'p, li, dd, dt, pre, td, th, figcaption, .fn, blockquote, div';
const KEEP_WITH_NEXT = (el: Element) =>
  /^H[1-6]$/.test(el.tagName) || el.classList.contains('scene-break') || el.classList.contains('keep-next') || el.classList.contains('toc-part');

const range = document.createRange();

function isAtomic(el: Element): boolean {
  if (ATOMIC_TAGS.has(el.tagName.toUpperCase())) return true;
  const c = el.classList;
  return c.contains('scene-break') || c.contains('opener') || c.contains('toc-entry') || c.contains('sw-atomic') || c.contains('fn-ref') || c.contains('op-head');
}

const isBlank = (n: Node) => n.nodeType === TEXT && !/\S/.test((n as Text).data);
const indexOf = (n: Node) => Array.prototype.indexOf.call(n.parentNode!.childNodes, n) as number;

function charRect(t: Text, i: number): DOMRect | null {
  range.setStart(t, i);
  range.setEnd(t, i + 1);
  const rects = range.getClientRects();
  for (let k = rects.length - 1; k >= 0; k--) {
    const r = rects[k];
    if (r.width > 0 || r.height > 0) return r;
  }
  return null;
}

/** Bottom of the line box character i sits on (skipping collapsed whitespace). */
function charBottom(t: Text, i: number): number {
  for (let j = i; j < t.length; j++) { const r = charRect(t, j); if (r) return r.bottom; }
  for (let j = i - 1; j >= 0; j--) { const r = charRect(t, j); if (r) return r.bottom; }
  return -Infinity;
}

/** Finds the first position whose line does not fit above `limit`, or null if everything fits. */
function findBreak(root: Node, limit: number): Pos | null {
  const kids = root.childNodes;
  for (let idx = 0; idx < kids.length; idx++) {
    const child = kids[idx];
    if (child.nodeType === TEXT) {
      const t = child as Text;
      if (!t.length || isBlank(t)) continue;
      let last = t.length - 1;
      while (last > 0 && /\s/.test(t.data[last])) last--;
      if (charBottom(t, last) <= limit) continue;
      let lo = 0;
      let hi = last;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (charBottom(t, mid) > limit) hi = mid;
        else lo = mid + 1;
      }
      return { node: t, offset: lo };
    }
    if (child.nodeType !== ELEMENT) continue;
    const el = child as Element;
    if (el.tagName === 'BR' || el.tagName === 'WBR') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0 && !el.firstChild) continue;
    if (r.bottom <= limit + 0.5) continue;
    if (isAtomic(el) || r.top >= limit) return { node: root, offset: idx };
    const inner = findBreak(el, limit);
    if (inner) return inner;
  }
  return null;
}

/** Moves a position out of element/text edges so splits never leave empty shells. */
function normalize(pos: Pos, root: Node): Pos {
  let { node, offset } = pos;
  for (;;) {
    if (node.nodeType === TEXT) {
      const t = node as Text;
      if (!/\S/.test(t.data.slice(0, offset))) { offset = indexOf(t); node = t.parentNode!; continue; }
      if (!/\S/.test(t.data.slice(offset))) { offset = indexOf(t) + 1; node = t.parentNode!; continue; }
      return { node, offset };
    }
    if (node === root) return { node, offset };
    const kids = node.childNodes;
    let atStart = true;
    for (let i = 0; i < offset; i++) if (!isBlank(kids[i])) { atStart = false; break; }
    if (atStart) { offset = indexOf(node); node = node.parentNode!; continue; }
    let atEnd = true;
    for (let i = offset; i < kids.length; i++) if (!isBlank(kids[i])) { atEnd = false; break; }
    if (atEnd) { offset = indexOf(node) + 1; node = node.parentNode!; continue; }
    return { node, offset };
  }
}

function rootState(pos: Pos, root: Node): 'start' | 'end' | 'mid' {
  if (pos.node !== root) return 'mid';
  const kids = root.childNodes;
  let start = true;
  for (let i = 0; i < pos.offset; i++) if (!isBlank(kids[i])) { start = false; break; }
  if (start) return 'start';
  for (let i = pos.offset; i < kids.length; i++) if (!isBlank(kids[i])) return 'mid';
  return 'end';
}

function lineHeightPx(el: Element): number {
  const cs = getComputedStyle(el);
  const lh = parseFloat(cs.lineHeight);
  return Number.isFinite(lh) ? lh : parseFloat(cs.fontSize) * 1.2;
}

/** Applies orphan/widow rules to a break inside a paragraph-like block. */
function applyWidowsOrphans(root: HTMLElement, pos: Pos, limit: number, opts: PaginateOptions, allowMoveWhole: boolean): Pos {
  if (pos.node.nodeType !== TEXT) return pos;
  const t = pos.node as Text;
  const block = (t.parentElement?.closest(BLOCKISH) as HTMLElement | null) ?? root;
  if (!root.contains(block)) return pos;
  const r = charRect(t, pos.offset) ?? charRect(t, Math.max(0, pos.offset - 1));
  if (!r) return pos;
  const lh = lineHeightPx(block);
  const br = block.getBoundingClientRect();
  const cs = getComputedStyle(block);
  const top = br.top + parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth);
  const contentH = br.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth);
  const before = Math.max(0, Math.round((r.bottom - top) / lh) - 1);
  const total = Math.max(before + 1, Math.round(contentH / lh));
  const after = total - before;
  const beforeBlock = (): Pos => ({ node: block.parentNode!, offset: indexOf(block) });
  if (before < opts.orphans) return allowMoveWhole && block !== root ? beforeBlock() : allowMoveWhole ? { node: root, offset: 0 } : pos;
  if (after < opts.widows) {
    const keep = before - (opts.widows - after);
    if (keep >= opts.orphans || (!allowMoveWhole && keep >= 1)) {
      const p = findBreak(block, top + (keep + 0.5) * lh);
      if (p) return p;
    }
    if (allowMoveWhole) return block !== root ? beforeBlock() : { node: root, offset: 0 };
  }
  return pos;
}

let markSeq = 0;

/** Splits `el` at `pos`: `el` keeps the content before, the returned clone gets the rest. */
function extractRest(el: HTMLElement, pos: Pos): HTMLElement {
  const marks: Element[] = [];
  let n: Node | null = pos.node.nodeType === TEXT ? pos.node.parentNode : pos.node;
  while (n && n !== el) {
    if (n.nodeType === ELEMENT) { (n as Element).setAttribute('data-sw-mark', String(++markSeq)); marks.push(n as Element); }
    n = n.parentNode;
  }
  // Mid-word break from automatic hyphenation: keep the hyphen visible.
  let hyphenate = false;
  if (pos.node.nodeType === TEXT && pos.offset > 0) {
    const t = pos.node as Text;
    const prev = t.data[pos.offset - 1];
    const next = t.data[pos.offset];
    if (prev === '­') hyphenate = true;
    else if (/\p{L}/u.test(prev) && next && /\p{L}/u.test(next) && !t.parentElement?.closest('pre, code')) hyphenate = true;
  }
  range.setStart(pos.node, pos.offset);
  range.setEnd(el, el.childNodes.length);
  const frag = range.extractContents();
  if (hyphenate) {
    const t = pos.node as Text;
    t.data = t.data.replace(/­$/, '') + '‐';
  }
  const rest = el.cloneNode(false) as HTMLElement;
  rest.appendChild(frag);
  el.classList.add('sw-split');
  rest.classList.add('sw-cont');
  rest.classList.remove('sw-split', 'dropcap', 'first', 'force-break', 'after-break', 'leadin-line');
  rest.removeAttribute('id');
  for (const m of marks) {
    const id = m.getAttribute('data-sw-mark')!;
    m.removeAttribute('data-sw-mark');
    m.classList.add('sw-split');
    const twin = rest.querySelector(`[data-sw-mark="${id}"]`);
    if (!twin) continue;
    twin.removeAttribute('data-sw-mark');
    twin.classList.add('sw-cont');
    twin.classList.remove('sw-split', 'dropcap', 'first', 'leadin-line');
    if (m.tagName === 'OL') {
      const kept = Array.from(m.children).filter((c) => c.tagName === 'LI');
      const split = kept.length && kept[kept.length - 1].classList.contains('sw-split');
      const start = Number(m.getAttribute('start') || 1);
      twin.setAttribute('start', String(start + kept.length - (split ? 1 : 0)));
    }
    if (m.tagName === 'TABLE') {
      const thead = m.querySelector(':scope > thead');
      if (thead && !twin.querySelector(':scope > thead')) twin.prepend(thead.cloneNode(true));
    }
  }
  if (el.tagName === 'OL') {
    const kept = Array.from(el.children).filter((c) => c.tagName === 'LI');
    const split = kept.length && kept[kept.length - 1].classList.contains('sw-split');
    rest.setAttribute('start', String(Number(el.getAttribute('start') || 1) + kept.length - (split ? 1 : 0)));
  }
  if (el.tagName === 'TABLE') {
    const thead = el.querySelector(':scope > thead');
    if (thead && !rest.querySelector(':scope > thead')) rest.prepend(thead.cloneNode(true));
  }
  rest.querySelectorAll('[id]').forEach((x) => x.removeAttribute('id'));
  return rest;
}

export interface PageParts { page: HTMLElement; body: HTMLElement; content: HTMLElement; notes: HTMLElement }

export function makePage(pageClass: string): PageParts {
  const page = document.createElement('div');
  page.className = `page ${pageClass}`;
  const head = document.createElement('div');
  head.className = 'pg-head';
  head.innerHTML = '<span class="pg-rh"></span><span class="pg-fh"></span>';
  const body = document.createElement('div');
  body.className = 'pg-body';
  const content = document.createElement('div');
  content.className = 'pg-content';
  const notes = document.createElement('div');
  notes.className = 'pg-notes';
  body.append(content, notes);
  const foot = document.createElement('div');
  foot.className = 'pg-foot';
  foot.innerHTML = '<span class="pg-folio"></span>';
  page.append(head, body, foot);
  return { page, body, content, notes };
}

async function loadImages(els: HTMLElement[]): Promise<void> {
  const imgs = els.flatMap((e) => Array.from(e.querySelectorAll('img')));
  await Promise.all(
    imgs.map((img) => (img.complete && img.naturalWidth ? Promise.resolve() : Promise.race([img.decode().catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]))),
  );
}

/** Lays one rendered section out into pages. Returns null if cancelled. */
export async function paginate(r: Rendered, host: HTMLElement, opts: PaginateOptions): Promise<HTMLElement[] | null> {
  const budget = opts.budgetMs ?? 8;
  const pages: HTMLElement[] = [];
  let sliceStart = performance.now();
  const cleanup = () => { for (const p of pages) p.remove(); };

  const tick = async () => {
    if (performance.now() - sliceStart > budget) {
      await yieldToMain();
      sliceStart = performance.now();
    }
    return !opts.isCancelled();
  };

  let blocks = r.blocks.slice();

  // ── Fixed single pages (title, dedication, part…) ──
  if (r.fixed) {
    const parts = makePage(`${r.pageClass} fixed`);
    host.appendChild(parts.page);
    parts.content.appendChild(r.fixed);
    for (const d of r.decor) parts.page.insertBefore(d, parts.page.firstChild);
    await loadImages([r.fixed]);
    if (r.fixed.scrollHeight <= parts.body.clientHeight + 1) {
      parts.page.remove();
      parts.page.dataset.fixed = '1';
      if (r.toc.length) parts.page.dataset.toc = r.toc.map((t) => t.id).join(' ');
      if (r.rh) parts.page.dataset.rh = r.rh;
      return [parts.page];
    }
    // Too long for one page: flow it instead.
    parts.page.remove();
    r.fixed.classList.add('overflowing');
    blocks = [r.fixed, ...blocks];
  }

  const queue: HTMLElement[] = r.opener ? [r.opener, ...blocks] : blocks;
  await loadImages(queue);
  let rh = r.rh;
  let cur = null as PageParts | null;
  let limit = 0;
  let bodyBottom = 0;
  const notesShown = new Set<string>();

  const recomputeLimit = () => {
    const nh = cur!.notes.childNodes.length ? cur!.notes.getBoundingClientRect().height : 0;
    limit = bodyBottom - nh;
  };
  const openPage = () => {
    cur = makePage(r.pageClass);
    host.appendChild(cur.page);
    pages.push(cur.page);
    const b = cur.body.getBoundingClientRect();
    bodyBottom = b.bottom;
    notesShown.clear();
    limit = bodyBottom;
    cur.page.dataset.rh = rh;
  };
  const addNotesFor = (el: Element): boolean => {
    if (!r.notes.size) return false;
    let added = false;
    for (const ref of Array.from(el.querySelectorAll<HTMLElement>('.fn-ref'))) {
      const id = ref.dataset.fn!;
      if (notesShown.has(id)) continue;
      const note = r.notes.get(id);
      if (!note) continue;
      cur!.notes.appendChild(note.cloneNode(true));
      notesShown.add(id);
      added = true;
    }
    if (added) recomputeLimit();
    return added;
  };
  const syncNotes = () => {
    if (!r.notes.size) return;
    const present = new Set(Array.from(cur!.content.querySelectorAll<HTMLElement>('.fn-ref')).map((x) => x.dataset.fn!));
    for (const n of Array.from(cur!.notes.children) as HTMLElement[]) {
      if (!present.has(n.dataset.fn!)) { n.remove(); notesShown.delete(n.dataset.fn!); }
    }
    recomputeLimit();
  };
  const lastBottom = () => {
    const last = cur!.content.lastElementChild;
    return last ? last.getBoundingClientRect().bottom : -Infinity;
  };
  const hasContent = () => cur!.content.childElementCount > 0;
  const closePage = () => {
    const page = cur!.page;
    const tocIds = Array.from(page.querySelectorAll<HTMLElement>('[data-toc-id]')).map((e) => e.dataset.tocId!);
    if (tocIds.length) page.dataset.toc = tocIds.join(' ');
    const first = cur!.content.firstElementChild as HTMLElement | null;
    if (first && (first.classList.contains('opener') || first.classList.contains('full-page'))) page.dataset.opener = '1';
    if (first?.classList.contains('full-page')) page.classList.add('fixed');
    const lastOpener = Array.from(page.querySelectorAll<HTMLElement>('.opener[data-rh], .full-page[data-rh]')).pop();
    if (lastOpener) rh = lastOpener.dataset.rh || rh;
  };

  openPage();

  while (queue.length) {
    if (!(await tick())) { cleanup(); return null; }
    const el = queue.shift()!;

    if ((el.classList.contains('force-break') || el.classList.contains('full-page')) && hasContent()) {
      closePage();
      openPage();
    }
    if (el.classList.contains('page-break-marker')) continue;

    cur!.content.appendChild(el);
    addNotesFor(el);

    if (el.classList.contains('full-page')) {
      closePage();
      if (queue.length) openPage(); else cur = null;
      if (!cur) break;
      continue;
    }

    if (lastBottom() <= limit + 0.5) continue;

    // ── Overflow: split the block, or move it to the next page ──
    const pageHadOther = cur!.content.childElementCount > 1;
    let rest: HTMLElement | null = null;
    let moved = false;
    let tryLimit = limit;
    for (let attempt = 0; attempt < 4; attempt++) {
      let pos = findBreak(el, tryLimit);
      if (!pos) break; // padding-only overflow: treat as fitting
      pos = applyWidowsOrphans(el, pos, tryLimit, opts, pageHadOther);
      pos = normalize(pos, el);
      const state = rootState(pos, el);
      if (state === 'end') break;
      if (state === 'start') {
        if (pageHadOther) { el.remove(); moved = true; }
        break; // nothing fits even on an empty page: leave it (clipped) rather than loop forever
      }
      const backup = el.cloneNode(true) as HTMLElement;
      rest = extractRest(el, pos);
      if (el.getBoundingClientRect().bottom <= tryLimit + 0.5 || attempt === 3) break;
      // Re-flowing the shorter paragraph changed its lines; undo and try one line higher.
      el.replaceChildren(...Array.from(backup.childNodes));
      el.className = backup.className;
      rest = null;
      tryLimit -= lineHeightPx(el);
    }

    const carry: HTMLElement[] = moved ? [el] : rest ? [rest] : [];
    // Keep headings and scene breaks with what follows them (at least one block stays).
    if (moved) {
      while (cur!.content.childElementCount > 1) {
        const last = cur!.content.lastElementChild as HTMLElement;
        if (!KEEP_WITH_NEXT(last)) break;
        last.remove();
        carry.unshift(last);
      }
    }
    syncNotes();
    queue.unshift(...carry);
    closePage();
    if (queue.length) openPage();
    else cur = null;
    if (!cur) break;
  }
  if (cur) {
    if (!hasContent() && pages.length > 1) { cur.page.remove(); pages.pop(); }
    else closePage();
  }

  for (const p of pages) p.remove();
  return pages;
}
