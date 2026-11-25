import type { Project, Section, SectionKind } from '../model/types.ts';
import * as repo from '../db/repo.ts';
import { h, icon, iconButton, button } from './dom.ts';
import { confirmDialog, modal, promptDialog, toast } from './dialogs.ts';
import { ProjectSession, type SaveState } from '../storage/session.ts';
import { SnapshotScheduler, createSnapshot } from '../storage/snapshots.ts';
import { mirror } from '../storage/mirror.ts';
import { BookLayout } from '../typeset/book.ts';
import { Editor } from './editor.ts';
import { Sidebar } from './sidebar.ts';
import { Preview } from './preview.ts';
import { KINDS, defaultContent, makeSection, plainTitle, sectionTitle } from '../model/defaults.ts';
import { effectiveSettings, pageSize } from '../templates/index.ts';
import { debounce, uid, formatRelative } from '../util.ts';
import { splitFrontMatter, withFrontMatter } from '../md/frontmatter.ts';

// The writing room: sidebar | editor | live preview.

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
    onJump: (sid, line) => { select(sid, false); requestAnimationFrame(() => editor.goToLine(line)); },
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
    onSelect: (id) => select(id),
    onReorder: (ids) => { session.reorder(ids); renderSidebar(); book.updateSections(session.project, session.sections, [], currentId || undefined); },
    onAdd: (kind, after) => void addSection(kind, after),
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

  const toggleSidebar = iconButton('sidebar', 'Show or hide the sidebar (⌘\\)', () => setPane('sidebar'));
  const togglePreview = iconButton('preview', 'Show or hide the page preview', () => setPane('preview'));
  const designBtn = button('Design', { icon: 'design', onClick: async () => (await import('./design.ts')).openDesign(ctx) });
  const historyBtn = button('History', { icon: 'history', onClick: async () => (await import('./history.ts')).openHistory(ctx) });
  const exportBtn = button('Export', { icon: 'export', onClick: async () => (await import('./exportDialog.ts')).openExport(ctx, exportBtn) });
  const readBtn = button('Read', { icon: 'read', onClick: async () => (await import('./reader.ts')).openReader(ctx), title: 'Read the typeset book full-screen' });
  const findBtn = iconButton('search', 'Find & replace in the whole book (⌘F)', () => void openFind());
  const openFind = async () => (await import('./find.ts')).openFind(ctx);
  const openStats = async () => { await flush(); (await import('./stats.ts')).openStats(ctx); };
  const statsBtn = iconButton('chart', 'Writing stats: your habits and your prose', () => void openStats());
  const focusBtn = iconButton('focus', 'Focus mode (⌘⇧F)', () => toggleFocus());
  const back = h('a', { class: 'btn icon pj-back', href: '#/', title: 'Library', 'aria-label': 'Back to library' }, icon('back'));

  const topbar = h('header', { class: 'pj-bar' },
    back, toggleSidebar, titleBtn, saveState, mirrorWarn,
    h('div', { class: 'pj-spacer' }),
    findBtn, statsBtn, designBtn, historyBtn, exportBtn, readBtn, focusBtn, togglePreview);

  const resizer = h('div', { class: 'pj-resizer', role: 'separator', 'aria-orientation': 'vertical', title: 'Drag to resize' });
  const statusbar = h('div', { class: 'pj-status' });
  const editorCol = h('div', { class: 'pj-editor' }, editor.el, statusbar);
  const layout = h('div', { class: 'pj-main' }, sidebar.el, editorCol, resizer, preview.el);
  const view = h('div', { class: 'project' }, topbar, layout);
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
    editor.focus();
  }

  // Saves trigger snapshots and the folder mirror.
  session.afterSave.push((changed, projectChanged) => {
    if (changed.length) void snapshots.maybe();
    if (changed.length || projectChanged) mirror.schedule(session.project, session.sections);
  });

  // ───────── section commands ─────────
  async function addSection(kind: SectionKind, afterId: string | null): Promise<void> {
    if ((kind === 'title' || kind === 'toc') && session.sections.some((s) => s.kind === kind)) {
      select(session.sections.find((s) => s.kind === kind)!.id);
      toast(`This book already has a ${KINDS[kind].label.toLowerCase()} page.`);
      return;
    }
    let title = KINDS[kind].defaultTitle;
    if (kind === 'chapter') title = 'Untitled Chapter';
    if (kind === 'part') title = 'Untitled Part';
    const s = makeSection(session.project.id, kind, title, defaultContent(kind, session.project.meta));
    // sensible positions: front matter near the front, about at the end
    if (kind === 'bibliography') afterId = null;
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
    editor.focus();
  }

  async function duplicateSection(id: string): Promise<void> {
    const s = session.byId.get(id);
    if (!s) return;
    if (s.kind === 'title' || s.kind === 'toc') { toast('A book has only one of those.'); return; }
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
    titleBtn.textContent = plainTitle(meta);
    document.title = `${plainTitle(meta)} — SerifWriter`;
    const t = session.sections.find((s) => s.kind === 'title');
    if (t && t.id === currentId) editor.load(t);
    book.metaChanged(session.project);
    book.updateSections(session.project, session.sections, session.sections.filter((s) => s.kind === 'title' || s.kind === 'copyright').map((s) => s.id));
  }

  // ───────── panes & modes ─────────
  function setPane(which: 'sidebar' | 'preview'): void {
    const cls = which === 'sidebar' ? 'no-sidebar' : 'no-preview';
    const hidden = view.classList.toggle(cls);
    session.project.ui[which] = !hidden;
    session.markProjectDirty();
    if (which === 'preview' && !hidden) preview.apply();
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
    if (mod && e.shiftKey && key.toLowerCase() === 'k') { e.preventDefault(); void import('./citePicker.ts').then((m) => m.openCitePicker(ctx)); return true; }
    if (mod && key === '\\') { e.preventDefault(); setPane('sidebar'); return true; }
    if (key === 'Escape' && view.classList.contains('focus')) { toggleFocus(false); return true; }
    return false;
  }
  const onDocKey = (e: KeyboardEvent) => {
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
  };
  currentCtx = ctx;

  // ───────── start ─────────
  renderSidebar();
  if (currentId) editor.load(session.byId.get(currentId)!);
  paintStatus();
  editor.focus();

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
      offSave(); offMirror(); offMirror2();
      preview.destroy();
      book.destroy();
      for (const u of assetUrls.values()) URL.revokeObjectURL(u);
      document.querySelector('.reader')?.remove();
    },
  };
}
