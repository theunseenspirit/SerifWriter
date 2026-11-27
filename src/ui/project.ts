import type { Project, Section, SectionKind } from '../model/types.ts';
import * as repo from '../db/repo.ts';
import { h, icon, iconButton, button } from './dom.ts';
import { confirmDialog, modal, promptDialog, toast, showMenu } from './dialogs.ts';
import { ProjectSession, type SaveState } from '../storage/session.ts';
import { SnapshotScheduler, createSnapshot } from '../storage/snapshots.ts';
import { mirror } from '../storage/mirror.ts';
import { BookLayout } from '../typeset/book.ts';
import { Editor } from './editor.ts';
import { Sidebar } from './sidebar.ts';
import { Preview } from './preview.ts';
import { KINDS, defaultContent, makeSection, plainTitle, sectionTitle } from '../model/defaults.ts';
import { effectiveSettings, pageSize, indentsParagraphs, keepsLineBreaks, setBookSetting } from '../templates/index.ts';
import { debounce, uid, formatRelative } from '../util.ts';
import { splitFrontMatter, withFrontMatter } from '../md/frontmatter.ts';
import { isPhone, onPhoneChange } from './viewport.ts';

// The writing room: sidebar | editor | live preview. On a phone: one pane at a
// time (Write or Pages), the contents in a drawer, and a row of writing keys
// above the keyboard for what a phone keyboard lacks (Tab, symbols, ⌘B…).

export interface ProjectCtx {
  session: ProjectSession;
  book: BookLayout;
  preview: Preview;
  editor: Editor;
  currentId: () => string | null;
  select: (id: string) => void;
  reload: () => Promise<void>;
  relayout: () => Promise<void>;
  flush: () => Promise<void>;
  snapshot: (label: string) => Promise<void>;
  /** Phone layout: show the editor or the pages. */
  pane: (which: 'write' | 'pages') => void;
}

let active: { close: () => Promise<void> } | null = null;
let currentCtx: ProjectCtx | null = null;
export const getProjectCtx = () => currentCtx;

export async function closeProjectView(): Promise<void> {
  if (active) {
    const a = active;
    active = null;
    currentCtx = null;
    await a.close();
  }
}

export async function openProjectView(root: HTMLElement, project: Project): Promise<void> {
  if (active) await closeProjectView();
  const sections = await repo.getSections(project);
  project.openedAt = Date.now();
  const session = new ProjectSession(project, sections);
  const snapshots = new SnapshotScheduler(() => ({ project: session.project, sections: session.sections }));
  await snapshots.init(project.id);
  // A version at the start of every writing session (skipped if nothing changed).
  void snapshots.maybe(true, 'Opened');

  // images → object URLs
  const assetUrls = new Map<string, string>();
  for (const a of await repo.listAssets(project.id)) assetUrls.set(a.id, URL.createObjectURL(a.blob));

  let currentId: string | null = project.lastSectionId && session.byId.has(project.lastSectionId) ? project.lastSectionId
    : sections.find((s) => s.kind === 'chapter')?.id ?? sections[0]?.id ?? null;
  let previewDelay = (await repo.kvGet<number>('previewDelay')) || 700;

  // ───────── components ─────────
  const preview = new Preview({
    onJump: (sid, line) => {
      if (isPhone()) {
        if (document.querySelector('.drawer')) return; // Design is open over the pages: a tap there is for looking
        // A tap on a page opens that paragraph for writing, without throwing the keyboard up.
        select(sid, false);
        showPane('write');
        requestAnimationFrame(() => editor.goToLine(line, false));
        return;
      }
      select(sid, false); requestAnimationFrame(() => editor.goToLine(line));
    },
    onZoom: (zoom, spread) => { session.project.ui.previewZoom = zoom; session.project.ui.spread = spread; session.markProjectDirty(); },
  });
  const book = new BookLayout(preview.view);
  book.setAssets(assetUrls);
  preview.attach(book);

  const editor = new Editor({
    onInput: () => { markTyping(); contentSync(); previewSync(); followSync(); },
    onCursor: () => { cursorSync(); },
    onImage: (f) => addImage(f),
    onShortcut: (key, e) => shortcut(key, e),
  });

  const sidebar = new Sidebar({
    onStats: () => void openStats(),
    onSelect: (id) => { select(id); closeDrawer(); },
    onJump: (id, line) => {
      select(id, false);
      closeDrawer();
      if (isPhone() && view.classList.contains('pane-pages')) { requestAnimationFrame(() => preview.reveal(id, line)); return; }
      requestAnimationFrame(() => { editor.goToLine(line, !isPhone()); preview.follow(id, line); });
    },
    onReorder: (ids) => { session.reorder(ids); renderSidebar(); book.updateSections(session.project, session.sections, [], currentId || undefined); },
    onAdd: (kind, after) => { if (isPhone()) { closeDrawer(); showPane('write'); } void addSection(kind, after); },
    onRename: (id) => void renameSection(id),
    onDuplicate: (id) => void duplicateSection(id),
    onDelete: (id) => void deleteSection(id),
    onKind: (id, kind) => void changeKind(id, kind),
  });

  // ───────── top bar ─────────
  const saveState = h('span', { class: 'save-state', role: 'status', 'aria-live': 'polite' });
  const paintSave = (st: SaveState) => {
    const text = { saved: 'Saved', pending: 'Editing…', saving: 'Saving…', error: 'Not saved — retrying' }[st];
    saveState.className = `save-state ${st}`;
    saveState.replaceChildren(st === 'saved' ? icon('check', 14) : h('span', { class: 'dot' }), h('span', null, text));
    const mir = mirror.status === 'ok' ? ` · mirrored to “${mirror.folderName}”${mirror.lastWrite ? ` ${formatRelative(mirror.lastWrite)}` : ''}` : '';
    saveState.title = st === 'error' ? `Saving to this browser failed: ${session.lastError}. Your text is kept in a local journal and will be retried.` : `Saved in this browser${mir}`;
  };
  const offSave = session.onState(paintSave);
  const offMirror = mirror.onChange(() => paintSave(session.state));
  paintSave('saved');

  const titleBtn = h('button', { class: 'pj-title', type: 'button', title: 'Book details' }, plainTitle(project.meta));
  titleBtn.addEventListener('click', () => void bookDetails());
  const mirrorWarn = h('button', { class: 'chip warn', type: 'button', hidden: true }, icon('folder', 14), h('span', null, 'Reconnect backup folder'));
  mirrorWarn.addEventListener('click', async () => { if (await mirror.reconnect()) mirror.schedule(session.project, session.sections, 100); paintMirror(); });
  const paintMirror = () => { mirrorWarn.hidden = mirror.status !== 'needs-permission'; };
  const offMirror2 = mirror.onChange(paintMirror);
  paintMirror();

  const toggleSidebar = iconButton('sidebar', 'Show or hide the sidebar (⌘\\)', () => setPane('sidebar'), 'pj-contents');
  const togglePreview = iconButton('preview', 'Show or hide the page preview', () => setPane('preview'), 'pj-preview');
  const openDesign = async () => (await import('./design.ts')).openDesign(ctx);
  const openHistory = async () => (await import('./history.ts')).openHistory(ctx);
  const openExport = async () => (await import('./exportDialog.ts')).openExport(ctx, exportBtn);
  const openRead = async () => (await import('./reader.ts')).openReader(ctx);
  const openSymbols = async () => (await import('./symbolPicker.ts')).openSymbolPicker(ctx);
  const openCite = async () => (await import('./citePicker.ts')).openCitePicker(ctx);
  const designBtn = button('Design', { icon: 'design', class: 'pj-design', onClick: () => void openDesign() });
  const historyBtn = button('History', { icon: 'history', class: 'pj-history', onClick: () => void openHistory() });
  const exportBtn = button('Export', { icon: 'export', class: 'pj-export', onClick: () => void openExport() });
  const readBtn = button('Read', { icon: 'read', class: 'pj-read', onClick: () => void openRead(), title: 'Read the typeset book full-screen' });
  const findBtn = iconButton('search', 'Find & replace in the whole book (⌘F)', () => void openFind(), 'pj-find');
  const openFind = async () => (await import('./find.ts')).openFind(ctx);
  const openStats = async () => { await flush(); (await import('./stats.ts')).openStats(ctx); };
  const statsBtn = iconButton('chart', 'Writing stats: your habits and your prose', () => void openStats(), 'pj-stats');
  const focusBtn = iconButton('focus', 'Focus mode (⌘⇧F)', () => toggleFocus(), 'pj-focus');
  const back = h('a', { class: 'btn icon pj-back', href: '#/', title: 'Library', 'aria-label': 'Back to library' }, icon('back'));

  // Phone: Write | Pages as an icon switch, and everything else in one menu.
  const writeTab = h('button', { class: 'pj-seg-btn', type: 'button', 'aria-pressed': 'true', 'aria-label': 'Write', title: 'Write' }, icon('pen', 20));
  const pagesTab = h('button', { class: 'pj-seg-btn', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Pages', title: 'Pages' }, icon('pages', 20));
  writeTab.addEventListener('click', () => showPane('write'));
  pagesTab.addEventListener('click', () => showPane('pages'));
  const seg = h('div', { class: 'pj-seg', role: 'group', 'aria-label': 'Show' }, writeTab, pagesTab);
  // The paragraph settings as one-tap toggles (also in Design ▸ Paragraphs & line breaks).
  const paragraphSetting = (path: 'type.autoIndent' | 'type.lineBreaks', on: boolean) => {
    setBookSetting(session.project, path, on);
    session.markProjectDirty();
    void ctx.relayout();
    toast(path === 'type.autoIndent' ? (on ? 'New paragraphs are indented.' : 'New paragraphs start flush left, not indented.')
      : (on ? 'Each Return now starts a new line.' : 'A single Return runs on; a blank line starts a new paragraph.'), { timeout: 2400 });
  };
  const moreBtn: HTMLButtonElement = iconButton('more', 'More', () => {
    const s = effectiveSettings(session.project);
    showMenu(moreBtn, [
      { label: 'Find & replace', icon: 'search', onClick: () => void openFind() },
      { label: 'Insert a symbol', icon: 'keyboard', onClick: () => void openSymbols() },
      { label: 'Insert a citation', icon: 'book', onClick: () => void openCite() },
      { label: 'Writing stats', icon: 'chart', onClick: () => void openStats() },
      { separator: true, label: '' },
      { label: 'Indent new paragraphs', checked: indentsParagraphs(s), disabled: s.type.paragraphStyle === 'block', onClick: () => paragraphSetting('type.autoIndent', !indentsParagraphs(s)) },
      { label: 'Return starts a new line', checked: keepsLineBreaks(s), onClick: () => paragraphSetting('type.lineBreaks', !keepsLineBreaks(s)) },
      { separator: true, label: '' },
      { label: 'Design', icon: 'design', onClick: () => void openDesign() },
      { label: 'History', icon: 'history', onClick: () => void openHistory() },
      { label: 'Export', icon: 'export', onClick: () => void openExport() },
      { label: 'Read', icon: 'read', onClick: () => void openRead() },
      { separator: true, label: '' },
      { label: 'Book details…', icon: 'edit', onClick: () => void bookDetails() },
    ]);
  }, 'pj-more');

  const topbar = h('header', { class: 'pj-bar' },
    back, toggleSidebar, titleBtn, saveState, mirrorWarn,
    h('div', { class: 'pj-spacer' }),
    findBtn, statsBtn, h('span', { class: 'pj-sep' }), designBtn, historyBtn, exportBtn, readBtn, h('span', { class: 'pj-sep' }), focusBtn, togglePreview, seg, moreBtn);

  const resizer = h('div', { class: 'pj-resizer', role: 'separator', 'aria-orientation': 'vertical', title: 'Drag to resize' });
  const statusbar = h('button', { class: 'pj-status', type: 'button', title: 'Writing stats' });
  statusbar.addEventListener('click', () => void openStats());
  // Writing keys (phone): pressing one never takes the caret out of the text, so the keyboard stays up.
  const key = (label: string, title: string, run: () => void, cls = '') => {
    const b = h('button', { class: `pj-key ${cls}`, type: 'button', title, 'aria-label': title }, label);
    for (const ev of ['pointerdown', 'mousedown']) b.addEventListener(ev, (e) => e.preventDefault());
    b.addEventListener('click', () => run());
    return b;
  };
  const sym = (c: string, name: string) => key(c, name, () => editor.insert(c), 'sym');
  const sep = () => h('span', { class: 'pj-keys-sep' });
  // First the line and format keys; the symbols are one level down, behind "Symbols ›".
  const mainKeys = h('div', { class: 'pj-keys-scroll', role: 'group', 'aria-label': 'Writing keys' },
    key('⇥', 'Indent the line (Tab)', () => editor.command('indent')),
    key('⇤', 'Outdent the line (⇧Tab)', () => editor.command('outdent')),
    sep(),
    key('B', 'Bold', () => editor.command('bold'), 'b'),
    key('I', 'Italic', () => editor.command('italic'), 'i'),
    sep(),
    key('Note', 'Footnote here', () => editor.command('note'), 'ui'),
    key('Cite', 'Insert a citation', () => void openCite(), 'ui'),
    sep(),
    key('Symbols ›', 'Symbols', () => showKeys('symbols'), 'ui sub'));
  const symbolKeys = h('div', { class: 'pj-keys-scroll', role: 'group', 'aria-label': 'Symbols', hidden: true },
    key('‹', 'Back to the writing keys', () => showKeys('main'), 'back'),
    sep(),
    sym('∴', 'Therefore'), sym('∵', 'Because'), sym('¬', 'Not'), sym('∧', 'And'), sym('∨', 'Or'), sym('→', 'If… then'), sym('↔', 'If and only if'),
    sym('∀', 'For all'), sym('∃', 'There exists'), sym('□', 'Necessarily'), sym('◇', 'Possibly'), sym('⊢', 'Proves'), sym('⊨', 'Entails'), sym('⊥', 'Contradiction'),
    sep(),
    key('All…', 'All symbols', () => void openSymbols(), 'ui'));
  const showKeys = (which: 'main' | 'symbols') => {
    mainKeys.hidden = which !== 'main';
    symbolKeys.hidden = which === 'main';
    (which === 'main' ? mainKeys : symbolKeys).scrollLeft = 0;
  };
  const keys = h('div', { class: 'pj-keys', role: 'toolbar', 'aria-label': 'Writing keys' },
    mainKeys, symbolKeys,
    key('⌄', 'Hide the keyboard', () => { showKeys('main'); editor.ta.blur(); }, 'done'));
  const editorCol = h('div', { class: 'pj-editor' }, editor.el, keys, statusbar);
  const layout = h('div', { class: 'pj-main' }, sidebar.el, editorCol, resizer, preview.el);
  const sbBackdrop = h('div', { class: 'sb-backdrop', 'aria-hidden': 'true' });
  sbBackdrop.addEventListener('click', () => closeDrawer());
  const view = h('div', { class: 'project' }, topbar, layout, sbBackdrop);
  root.replaceChildren(view);
  document.body.className = 'route-project';
  document.title = `${plainTitle(project.meta)} — SerifWriter`;

  const ui = project.ui;
  if (ui.sidebar === false) view.classList.add('no-sidebar');
  if (ui.preview === false) view.classList.add('no-preview');
  if (ui.previewWidth) layout.style.setProperty('--pv-w', `${ui.previewWidth}px`);
  preview.setView(ui.previewZoom ?? 0, ui.spread ?? false);

  // ───────── layout ─────────
  const applyPageSize = () => {
    const s = effectiveSettings(session.project);
    const ps = pageSize(s);
    preview.setPageSize(ps.w, ps.h);
    sidebar.setHidden(s.hiddenKinds);
    sidebar.setHeadings(s.headings, s.numberHeadings);
  };
  applyPageSize();
  let firstLayout = true;
  book.onChange = () => { preview.updateStatus(); };
  book.onAssembled = () => {
    preview.updateStatus();
    sidebar.updateWords(session.byId.get(currentId!) || session.sections[0], totals());
    paintStatus();
    if (firstLayout && currentId && book.sectionPageCount(currentId)) {
      firstLayout = false;
      const s = session.byId.get(currentId)!;
      const line = s.cursor ? editor.caretLine() : 0;
      if (line > 0) preview.follow(currentId, line); else preview.showSection(currentId);
    }
  };
  void book.load(session.project, session.sections, currentId || undefined);

  const totals = () => ({ words: session.totalWords, today: session.wordsToday, pages: book.pageRefs.length });
  const renderSidebar = () => sidebar.render(session.sections, currentId, totals());
  const paintStatus = () => {
    const s = currentId ? session.byId.get(currentId) : null;
    if (!s) { statusbar.textContent = ''; return; }
    const pages = book.sectionPageCount(s.id);
    statusbar.replaceChildren(...[
      h('span', null, `${KINDS[s.kind].label}`),
      s.kind !== 'title' && s.kind !== 'toc' ? h('span', null, `${s.words.toLocaleString()} words`) : null,
      pages ? h('span', null, `${pages} page${pages > 1 ? 's' : ''}`) : null,
      h('span', { class: 'pj-status-right' }, `Book: ${session.totalWords.toLocaleString()} words`),
    ].filter((x): x is HTMLSpanElement => !!x));
  };

  // ───────── editing ─────────
  let typingUntil = 0;
  const markTyping = () => { typingUntil = performance.now() + 1200; };
  const contentSync = debounce(() => {
    if (!currentId || editor.sectionId !== currentId) return;
    const changed = session.setContent(currentId, editor.value, editor.cursor);
    if (changed) {
      const s = session.byId.get(currentId)!;
      sidebar.updateWords(s, totals());
      paintStatus();
      if (s.kind === 'title') { titleBtn.textContent = plainTitle(session.project.meta); document.title = `${plainTitle(session.project.meta)} — SerifWriter`; }
    }
  }, 350, 2000);
  const previewSync = debounce(() => {
    contentSync.flush();
    if (!currentId) return;
    const s = session.byId.get(currentId);
    if (!s) return;
    if (s.kind === 'title') book.metaChanged(session.project);
    book.updateSections(session.project, session.sections, [currentId], currentId);
  }, previewDelay);
  const followSync = debounce(() => { if (currentId) preview.follow(currentId, editor.caretLine()); }, previewDelay + 450);
  const cursorSync = debounce(() => {
    if (!currentId || editor.sectionId !== currentId) return;
    session.setCursor(currentId, editor.cursor);
    if (performance.now() > typingUntil) followSync();
  }, 600);

  const flushEditor = () => {
    contentSync.flush();
    if (currentId && editor.sectionId === currentId) session.setCursor(currentId, editor.cursor);
  };

  const flush = async () => { flushEditor(); previewSync.flush(); await session.flush(); };

  function select(id: string, scrollPreview = true): void {
    if (!session.byId.has(id)) return;
    if (id !== currentId) {
      flushEditor();
      previewSync.flush();
      currentId = id;
      session.project.lastSectionId = id;
      session.markProjectDirty();
      editor.load(session.byId.get(id)!);
      renderSidebar();
      paintStatus();
    }
    if (scrollPreview) preview.showSection(id);
    if (!isPhone()) editor.focus(); // on a phone that would throw the keyboard over the page
  }

  // Saves trigger snapshots and the folder mirror.
  session.afterSave.push((changed, projectChanged) => {
    if (changed.length) void snapshots.maybe();
    if (changed.length || projectChanged) mirror.schedule(session.project, session.sections);
  });

  // ───────── section commands ─────────
  async function addSection(kind: SectionKind, afterId: string | null): Promise<void> {
    if ((kind === 'title' || kind === 'toc' || kind === 'index') && session.sections.some((s) => s.kind === kind)) {
      select(session.sections.find((s) => s.kind === kind)!.id);
      toast(`This book already has a ${KINDS[kind].label.toLowerCase()} page.`);
      return;
    }
    let title = KINDS[kind].defaultTitle;
    if (kind === 'chapter') title = 'Untitled Chapter';
    if (kind === 'part') title = 'Untitled Part';
    const s = makeSection(session.project.id, kind, title, defaultContent(kind, session.project.meta));
    // sensible positions: front matter near the front, about at the end
    if (kind === 'bibliography' || kind === 'index') afterId = null;
    let index = afterId ? session.sections.findIndex((x) => x.id === afterId) + 1 : session.sections.length;
    if (!afterId) {
      if (kind === 'title') index = 0;
      else if (KINDS[kind].front) {
        const firstBody = session.sections.findIndex((x) => !KINDS[x.kind].front);
        index = firstBody < 0 ? session.sections.length : firstBody;
      } else if (kind !== 'about') {
        const about = session.sections.findIndex((x) => x.kind === 'about');
        if (about >= 0) index = about;
      }
    }
    session.addSection(s, index);
    renderSidebar();
    book.updateSections(session.project, session.sections, [s.id], s.id);
    select(s.id);
    if (kind === 'chapter' || kind === 'part' || kind === 'section') void renameSection(s.id, true);
  }

  async function renameSection(id: string, fresh = false): Promise<void> {
    const s = session.byId.get(id);
    if (!s || s.kind === 'title') return;
    const v = await promptDialog(fresh ? `Name this ${KINDS[s.kind].label.toLowerCase()}` : 'Rename', 'Title', sectionTitle(s), { ok: fresh ? 'OK' : 'Rename' });
    if (v === null) { if (fresh) editor.focus(); return; }
    const title = v.trim() || KINDS[s.kind].defaultTitle;
    flushEditor();
    const fm = splitFrontMatter(s.content);
    let content = s.content;
    if (fm.data.title) content = withFrontMatter({ ...fm.data, title }, fm.body);
    else {
      // keep a leading "# Heading" in step with the name
      const lines = fm.body.split('\n');
      const i = lines.findIndex((l) => l.trim());
      if (i >= 0 && /^#\s+/.test(lines[i])) {
        lines[i] = `# ${title}`;
        content = fm.present ? withFrontMatter(fm.data, lines.join('\n')) : lines.join('\n');
      }
    }
    s.title = title;
    if (content !== s.content) session.setContent(id, content);
    else session.markSectionDirty(id);
    if (id === currentId) editor.load(s);
    renderSidebar();
    book.updateSections(session.project, session.sections, [id], id);
    if (fresh || !isPhone()) editor.focus(); // a new chapter is for writing; a rename on a phone keeps the keyboard down
  }

  async function duplicateSection(id: string): Promise<void> {
    const s = session.byId.get(id);
    if (!s) return;
    if (s.kind === 'title' || s.kind === 'toc' || s.kind === 'index') { toast('A book has only one of those.'); return; }
    flushEditor();
    const copy: Section = { ...structuredClone(s), id: uid('s'), title: `${s.title} (copy)`, createdAt: Date.now(), updatedAt: Date.now() };
    session.addSection(copy, session.sections.indexOf(s) + 1);
    renderSidebar();
    book.updateSections(session.project, session.sections, [copy.id]);
    select(copy.id);
  }

  async function deleteSection(id: string): Promise<void> {
    const s = session.byId.get(id);
    if (!s) return;
    const words = s.words ? ` (${s.words.toLocaleString()} words)` : '';
    const ok = await confirmDialog(`Delete “${sectionTitle(s)}”?`, `This removes the ${KINDS[s.kind].label.toLowerCase()}${words} from the book. A version is saved first, so you can bring it back from History.`, { ok: 'Delete', danger: true });
    if (!ok) return;
    flushEditor();
    await session.flush();
    await createSnapshot(session.project, session.sections, { auto: false, label: `Before deleting “${sectionTitle(s)}”`, reason: 'Before deleting a section' });
    const idx = session.sections.indexOf(s);
    await session.removeSection(id);
    if (currentId === id) {
      currentId = session.sections[Math.min(idx, session.sections.length - 1)]?.id ?? null;
      if (currentId) editor.load(session.byId.get(currentId)!);
    }
    renderSidebar();
    book.updateSections(session.project, session.sections, [], currentId || undefined);
    toast('Section deleted. You can restore it from History.', { action: 'History', onAction: async () => (await import('./history.ts')).openHistory(ctx) });
  }

  async function changeKind(id: string, kind: SectionKind): Promise<void> {
    const s = session.byId.get(id);
    if (!s) return;
    flushEditor();
    s.kind = kind;
    session.markSectionDirty(id);
    if (id === currentId) editor.load(s);
    renderSidebar();
    book.updateSections(session.project, session.sections, [id], id);
  }

  async function addImage(file: File): Promise<string | null> {
    if (file.size > 25 * 1024 * 1024) { toast('That image is over 25 MB — please use a smaller one.', { kind: 'error' }); return null; }
    const id = uid('img');
    await repo.saveAsset({ id, projectId: session.project.id, name: file.name || 'image', type: file.type, blob: file, createdAt: Date.now() });
    assetUrls.set(id, URL.createObjectURL(file));
    const alt = (file.name || 'image').replace(/\.[^.]+$/, '').replace(/[[\]]/g, '');
    return `\n\n![${alt}](asset:${id})\n\n`;
  }

  // ───────── book details ─────────
  async function bookDetails(): Promise<void> {
    flushEditor();
    const m = modal('Book details', { wide: true });
    const meta = structuredClone(session.project.meta);
    const field = (label: string, value: string, onInput: (v: string) => void, opts: { multiline?: boolean; placeholder?: string } = {}) => {
      const input = (opts.multiline ? h('textarea', { class: 'input', rows: 2 }) : h('input', { class: 'input', type: 'text' })) as HTMLInputElement;
      input.value = value;
      if (opts.placeholder) input.placeholder = opts.placeholder;
      input.addEventListener('input', () => onInput(input.value));
      return h('label', { class: 'field' }, h('span', null, label), input);
    };
    m.body.append(
      h('p', { class: 'dlg-note' }, 'These details live in the Title Page as YAML front matter — edit them here or there.'),
      field('Title', meta.title, (v) => (meta.title = v), { multiline: true, placeholder: 'Put a line break where the title should break on the title page' }),
      field('Subtitle', meta.subtitle, (v) => (meta.subtitle = v)),
      h('div', { class: 'row2' }, field('Author', meta.author, (v) => (meta.author = v)), field('Publisher / imprint', meta.publisher, (v) => (meta.publisher = v))),
      h('div', { class: 'row2' }, field('Year', meta.year, (v) => (meta.year = v), { placeholder: 'e.g. 2026 or MMXXVI' }), field('Language', meta.language, (v) => (meta.language = v || 'en'), { placeholder: 'en, fr, de…' })),
      h('details', { class: 'dlg-more' }, h('summary', null, 'Manuscript cover page details'),
        h('p', { class: 'dlg-note' }, 'Used by the Manuscript template: contact block, pen name and the header surname.'),
        field('Legal name', meta.extra.legal_name || '', (v) => (meta.extra.legal_name = v)),
        field('Address', meta.extra.address || '', (v) => (meta.extra.address = v), { multiline: true }),
        h('div', { class: 'row2' }, field('Email', meta.extra.email || '', (v) => (meta.extra.email = v)), field('Phone', meta.extra.phone || '', (v) => (meta.extra.phone = v))),
        h('div', { class: 'row2' }, field('Pen name', meta.extra.pen_name || '', (v) => (meta.extra.pen_name = v)), field('Header surname', meta.extra.surname || '', (v) => (meta.extra.surname = v))),
        field('Short title (header)', meta.extra.short_title || '', (v) => (meta.extra.short_title = v))),
    );
    const save = button('Save', { class: 'primary', onClick: () => m.close(true) });
    m.footer.append(button('Cancel', { onClick: () => m.close(false) }), save);
    if (!(await m.result)) return;
    for (const k of Object.keys(meta.extra)) if (!meta.extra[k]) delete meta.extra[k];
    meta.title = meta.title.trim() || 'Untitled Book';
    session.setMeta(meta);
    editor.ta.lang = meta.language || 'en';
    titleBtn.textContent = plainTitle(meta);
    document.title = `${plainTitle(meta)} — SerifWriter`;
    const t = session.sections.find((s) => s.kind === 'title');
    if (t && t.id === currentId) editor.load(t);
    book.metaChanged(session.project);
    book.updateSections(session.project, session.sections, session.sections.filter((s) => s.kind === 'title' || s.kind === 'copyright').map((s) => s.id));
  }

  // ───────── panes & modes ─────────
  function setPane(which: 'sidebar' | 'preview'): void {
    if (isPhone()) {
      if (which === 'sidebar') toggleDrawer();
      else showPane(view.classList.contains('pane-pages') ? 'write' : 'pages');
      return;
    }
    const cls = which === 'sidebar' ? 'no-sidebar' : 'no-preview';
    const hidden = view.classList.toggle(cls);
    session.project.ui[which] = !hidden;
    session.markProjectDirty();
    if (which === 'preview' && !hidden) preview.apply();
  }

  // Phone: the contents slide in over the page; picking a section closes them.
  function toggleDrawer(open = !view.classList.contains('sb-open')): void {
    view.classList.toggle('sb-open', open);
    toggleSidebar.classList.toggle('on', open);
    toggleSidebar.setAttribute('aria-expanded', String(open));
    // While the drawer is open the rest is out of reach, for VoiceOver too.
    for (const el of [topbar, editorCol, preview.el]) el.inert = open;
    if (open) {
      editor.ta.blur();
      const on = sidebar.el.querySelector('.sb-item.on') as HTMLElement | null;
      on?.scrollIntoView({ block: 'nearest' });
      on?.focus({ preventScroll: true });
    } else sidebar.el.style.transform = '';
  }
  function closeDrawer(): void { if (view.classList.contains('sb-open')) toggleDrawer(false); }

  // Phone: drag the drawer back to the left to close it.
  let drag: { x: number; y: number; dx: number; on: boolean } | null = null;
  sidebar.el.addEventListener('pointerdown', (e) => {
    if (!isPhone() || !view.classList.contains('sb-open') || e.pointerType === 'mouse') return;
    drag = { x: e.clientX, y: e.clientY, dx: 0, on: false };
  });
  sidebar.el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = Math.min(0, e.clientX - drag.x);
    if (!drag.on) {
      if (Math.abs(e.clientY - drag.y) > 12) { drag = null; return; } // scrolling the list
      if (dx > -12) return;
      drag.on = true;
      sidebar.el.classList.add('dragging');
    }
    drag.dx = dx;
    sidebar.el.style.transform = `translateX(${dx}px)`;
  });
  const endDrag = () => {
    if (!drag) return;
    const close = drag.on && drag.dx < -70;
    sidebar.el.classList.remove('dragging');
    sidebar.el.style.transform = '';
    drag = null;
    if (close) closeDrawer();
  };
  sidebar.el.addEventListener('pointerup', endDrag);
  sidebar.el.addEventListener('pointercancel', endDrag);

  // Phone: one pane at a time.
  function showPane(which: 'write' | 'pages'): void {
    const pages = which === 'pages';
    view.classList.toggle('pane-pages', pages);
    writeTab.setAttribute('aria-pressed', String(!pages));
    pagesTab.setAttribute('aria-pressed', String(pages));
    if (!pages) return;
    editor.ta.blur();
    flushEditor();
    previewSync.flush(); // typeset what was just written
    preview.apply();
    // Open the pages where you are writing, and stay there once what was just written is typeset
    // (a chapter that grew or shrank moves every page after it).
    const at = currentId;
    if (!at) return;
    const line = editor.caretLine();
    const shownAt = performance.now();
    requestAnimationFrame(() => preview.reveal(at, line));
    void book.idle().then(() => {
      if (view.classList.contains('pane-pages') && currentId === at && preview.touchedAt < shownAt) preview.reveal(at, line);
    });
  }

  function toggleFocus(force?: boolean): void {
    const on = view.classList.toggle('focus', force);
    if (on) toast('Focus mode — press Esc or ⌘⇧F to leave.', { timeout: 2200 });
    editor.focus();
  }

  function shortcut(key: string, e: KeyboardEvent): boolean {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && key.toLowerCase() === 's') { e.preventDefault(); void flush().then(() => toast('Saved.', { kind: 'success', timeout: 1200 })); return true; }
    if (mod && e.shiftKey && key.toLowerCase() === 'f') { e.preventDefault(); toggleFocus(); return true; }
    if (mod && !e.shiftKey && key.toLowerCase() === 'f') { e.preventDefault(); void openFind(); return true; }
    if (mod && e.shiftKey && key.toLowerCase() === 'l') { e.preventDefault(); void import('./symbolPicker.ts').then((m) => m.openSymbolPicker(ctx)); return true; }
    if (mod && e.shiftKey && key.toLowerCase() === 'k') { e.preventDefault(); void import('./citePicker.ts').then((m) => m.openCitePicker(ctx)); return true; }
    if (mod && key === '\\') { e.preventDefault(); setPane('sidebar'); return true; }
    if (key === 'Escape' && view.classList.contains('focus')) { toggleFocus(false); return true; }
    return false;
  }
  const onDocKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && view.classList.contains('sb-open') && !document.querySelector('dialog[open]')) { closeDrawer(); return; }
    if (e.target === editor.ta) return;
    if (document.querySelector('dialog[open]')) return;
    shortcut(e.key, e);
  };
  document.addEventListener('keydown', onDocKey);

  // Resizable preview column.
  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = preview.el.getBoundingClientRect().width;
    const move = (ev: PointerEvent) => {
      const w = Math.max(280, Math.min(window.innerWidth * 0.7, startW - (ev.clientX - startX)));
      layout.style.setProperty('--pv-w', `${w}px`);
    };
    const up = () => {
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', up);
      session.project.ui.previewWidth = Math.round(preview.el.getBoundingClientRect().width);
      session.markProjectDirty();
      preview.apply();
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up);
  });

  // Never lose words: journal synchronously when the page is hidden or closed.
  const onHide = () => {
    flushEditor();
    session.journal();
    void session.flush();
    void mirror.flush(session.project.id);
  };
  const onVis = () => { if (document.visibilityState === 'hidden') onHide(); };
  window.addEventListener('pagehide', onHide);
  document.addEventListener('visibilitychange', onVis);

  // ───────── context for panels ─────────
  const ctx: ProjectCtx = {
    session, book, preview, editor,
    currentId: () => currentId,
    select: (id) => select(id),
    flush,
    reload: async () => { await flush(); const p = await repo.getProject(session.project.id); if (p) await openProjectView(root, p); },
    relayout: async () => {
      applyPageSize();
      await book.refreshSettings(session.project, currentId || undefined);
      renderSidebar();
    },
    snapshot: async (label) => { await flush(); await createSnapshot(session.project, session.sections, { auto: false, label }); },
    pane: (which) => showPane(which),
  };
  currentCtx = ctx;

  // Turning a phone sideways or resizing a window can switch layouts mid-session.
  const applyPhone = (phone: boolean) => {
    sidebar.foldOnReselect = !phone;
    if (!phone) { closeDrawer(); preview.apply(); }
  };
  applyPhone(isPhone());
  const offPhone = onPhoneChange(applyPhone);

  // ───────── start ─────────
  editor.ta.lang = project.meta.language || 'en'; // spellcheck in the book's language
  renderSidebar();
  if (currentId) editor.load(session.byId.get(currentId)!);
  paintStatus();
  if (!isPhone()) editor.focus();

  repo.kvGet<number>('previewDelay').then((d) => { if (d) previewDelay = d; });

  active = {
    close: async () => {
      flushEditor();
      previewSync.cancel();
      followSync.cancel();
      cursorSync.cancel();
      await session.flush();
      await snapshots.maybe();
      await mirror.flush(session.project.id);
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('keydown', onDocKey);
      offSave(); offMirror(); offMirror2(); offPhone();
      preview.destroy();
      book.destroy();
      for (const u of assetUrls.values()) URL.revokeObjectURL(u);
      document.querySelector('.reader')?.remove();
    },
  };
}
