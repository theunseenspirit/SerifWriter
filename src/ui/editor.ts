import type { Section } from '../model/types.ts';
import { h } from './dom.ts';
import { KINDS } from '../model/defaults.ts';

// The writing surface: a native <textarea>. It is the fastest and most robust
// editor a browser has — native undo, spellcheck, dictation and IME — and it
// keeps typing latency at zero on old hardware. Markdown helpers below use
// execCommand('insertText') so every change stays on the undo stack.

export interface EditorOptions {
  onInput: () => void;
  onCursor: () => void;
  onImage: (file: File) => Promise<string | null>;
  onShortcut: (key: string, e: KeyboardEvent) => boolean;
}

export class Editor {
  readonly el: HTMLElement;
  readonly ta: HTMLTextAreaElement;
  private hint: HTMLElement;
  sectionId: string | null = null;
  private opts: EditorOptions;

  constructor(opts: EditorOptions) {
    this.opts = opts;
    this.ta = h('textarea', {
      class: 'editor-ta', spellcheck: 'true', autocapitalize: 'sentences', 'aria-label': 'Manuscript',
      placeholder: 'Begin writing…',
    }) as HTMLTextAreaElement;
    this.hint = h('div', { class: 'editor-hint' });
    this.el = h('div', { class: 'editor' }, this.hint, h('div', { class: 'editor-scroll' }, this.ta));
    this.ta.addEventListener('input', () => opts.onInput());
    this.ta.addEventListener('keydown', (e) => this.onKey(e));
    for (const ev of ['keyup', 'pointerup', 'select']) this.ta.addEventListener(ev, () => opts.onCursor());
    this.ta.addEventListener('scroll', () => opts.onCursor(), { passive: true });
    this.ta.addEventListener('paste', (e) => this.onPaste(e));
    this.ta.addEventListener('drop', (e) => this.onDrop(e));
  }

  load(s: Section): void {
    this.sectionId = s.id;
    this.ta.value = s.content;
    const info = KINDS[s.kind];
    this.hint.textContent = info.hint;
    this.hint.hidden = !info.hint;
    this.el.dataset.kind = s.kind;
    this.ta.spellcheck = s.kind !== 'bibliography';
    this.ta.placeholder = s.kind === 'toc' ? 'Nothing to write here — the contents are generated for you. (Add front matter with “title:” to rename the page.)'
      : s.kind === 'chapter' || s.kind === 'section' ? 'Begin writing…\n\nMarkdown works: *italic*, **bold**, > quotes, - lists, [^1] footnotes, and --- for a scene break.'
      : 'Write here…';
    const c = s.cursor;
    requestAnimationFrame(() => {
      if (c) {
        const len = this.ta.value.length;
        this.ta.setSelectionRange(Math.min(c.start, len), Math.min(c.end, len));
        this.ta.scrollTop = c.scroll;
      } else {
        this.ta.setSelectionRange(0, 0);
        this.ta.scrollTop = 0;
      }
    });
  }

  get value(): string { return this.ta.value; }
  get cursor() { return { start: this.ta.selectionStart, end: this.ta.selectionEnd, scroll: this.ta.scrollTop }; }

  /** Line number (0-based) of the caret. */
  caretLine(): number {
    const v = this.ta.value;
    const end = this.ta.selectionStart;
    let n = 0;
    for (let i = v.indexOf('\n'); i !== -1 && i < end; i = v.indexOf('\n', i + 1)) n++;
    return n;
  }

  goToLine(line: number): void {
    const v = this.ta.value;
    let pos = 0;
    for (let i = 0; i < line; i++) {
      const nl = v.indexOf('\n', pos);
      if (nl === -1) break;
      pos = nl + 1;
    }
    this.ta.focus({ preventScroll: true });
    this.ta.setSelectionRange(pos, pos);
    // Scroll so the line is about a third from the top.
    const before = v.slice(0, pos);
    const mirror = h('div', { class: 'editor-measure' });
    const cs = getComputedStyle(this.ta);
    Object.assign(mirror.style, { width: `${this.ta.clientWidth}px`, font: cs.font, lineHeight: cs.lineHeight, padding: cs.padding, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', letterSpacing: cs.letterSpacing });
    mirror.textContent = before;
    document.body.appendChild(mirror);
    const y = mirror.offsetHeight;
    mirror.remove();
    this.ta.scrollTop = Math.max(0, y - this.ta.clientHeight / 3);
  }

  focus(): void { this.ta.focus({ preventScroll: true }); }

  insert(text: string): void {
    this.ta.focus();
    if (!document.execCommand('insertText', false, text)) {
      this.ta.setRangeText(text, this.ta.selectionStart, this.ta.selectionEnd, 'end');
      this.opts.onInput();
    }
  }

  private wrap(before: string, after = before, placeholder = ''): void {
    const { selectionStart: a, selectionEnd: b, value } = this.ta;
    const sel = value.slice(a, b);
    if (sel.startsWith(before) && sel.endsWith(after) && sel.length >= before.length + after.length) {
      this.insert(sel.slice(before.length, sel.length - after.length));
      return;
    }
    if (value.slice(a - before.length, a) === before && value.slice(b, b + after.length) === after) {
      this.ta.setSelectionRange(a - before.length, b + after.length);
      this.insert(sel);
      this.ta.setSelectionRange(a - before.length, b - before.length);
      return;
    }
    const inner = sel || placeholder;
    this.insert(before + inner + after);
    this.ta.setSelectionRange(a + before.length, a + before.length + inner.length);
  }

  private onKey(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'b' && !e.shiftKey) { e.preventDefault(); this.wrap('**', '**', 'bold'); return; }
      if (k === 'i' && !e.shiftKey) { e.preventDefault(); this.wrap('*', '*', 'italic'); return; }
      if (k === 'n' && e.shiftKey) { e.preventDefault(); this.wrap('^[', ']', 'Note.'); return; } // inline footnote
      if (k === 'k' && !e.shiftKey) {
        e.preventDefault();
        const { selectionStart: a, selectionEnd: b, value } = this.ta;
        const text = value.slice(a, b) || 'link text';
        this.insert(`[${text}](https://)`);
        const urlStart = a + text.length + 3;
        this.ta.setSelectionRange(urlStart, urlStart + 8);
        return;
      }
    }
    if (this.opts.onShortcut(e.key, e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !mod && !e.isComposing) this.continueList(e);
    else if (e.key === 'Tab' && !mod) this.indentList(e);
  }

  private currentLine(): { start: number; text: string } {
    const v = this.ta.value;
    const pos = this.ta.selectionStart;
    const start = v.lastIndexOf('\n', pos - 1) + 1;
    return { start, text: v.slice(start, pos) };
  }

  private continueList(e: KeyboardEvent): void {
    if (this.ta.selectionStart !== this.ta.selectionEnd) return;
    const { start, text } = this.currentLine();
    const m = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?(.*)$/.exec(text) || /^(\s*)(>)(\s?)(.*)$/.exec(text);
    if (!m) return;
    e.preventDefault();
    if (m[2] === '>') {
      if (!m[4]?.trim()) { this.ta.setSelectionRange(start, this.ta.selectionStart); this.insert(''); return; }
      this.insert(`\n${m[1]}> `);
      return;
    }
    const [, indent, bullet, num, delim, space, task, rest] = m;
    if (!rest.trim() && !task) {
      // An empty item ends the list.
      this.ta.setSelectionRange(start, this.ta.selectionStart);
      this.insert('');
      return;
    }
    const marker = bullet ? bullet : `${Number(num) + 1}${delim}`;
    this.insert(`\n${indent}${marker}${space}${task ? '[ ] ' : ''}`);
  }

  private indentList(e: KeyboardEvent): void {
    const { start, text } = this.currentLine();
    if (!/^\s*([-*+]|\d+[.)])\s/.test(text + this.ta.value.slice(this.ta.selectionStart, this.ta.selectionStart + 3))) return;
    e.preventDefault();
    const pos = this.ta.selectionStart;
    if (e.shiftKey) {
      const lead = /^( {1,2}|\t)/.exec(this.ta.value.slice(start));
      if (!lead) return;
      this.ta.setSelectionRange(start, start + lead[0].length);
      this.insert('');
      this.ta.setSelectionRange(pos - lead[0].length, pos - lead[0].length);
    } else {
      this.ta.setSelectionRange(start, start);
      this.insert('  ');
      this.ta.setSelectionRange(pos + 2, pos + 2);
    }
  }

  private async onPaste(e: ClipboardEvent): Promise<void> {
    const file = Array.from(e.clipboardData?.files || []).find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    const md = await this.opts.onImage(file);
    if (md) this.insert(md);
  }

  private async onDrop(e: DragEvent): Promise<void> {
    const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/') || /\.(bib|md|markdown|txt|tex)$/i.test(f.name));
    if (!files.length) return;
    e.preventDefault();
    // A dropped .bib, .md or .txt file is inserted as text; images become figures.
    for (const f of files) {
      const md = f.type.startsWith('image/') ? await this.opts.onImage(f) : await f.text();
      if (md) this.insert(md);
    }
  }
}
