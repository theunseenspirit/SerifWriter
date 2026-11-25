import type { Project } from '../model/types.ts';
import * as repo from '../db/repo.ts';
import { h, icon, button } from './dom.ts';
import { confirmDialog, modal, promptDialog, showMenu, toast, choiceDialog } from './dialogs.ts';
import { newProject, plainTitle, titleContentFromMeta } from '../model/defaults.ts';
import { allTemplates, getTemplate, effectiveSettings, setCustomTemplates } from '../templates/index.ts';
import { fontStack } from '../typeset/fonts.ts';
import { fmtNum, formatRelative, downloadBlob } from '../util.ts';
import { mirror, mirrorSupported, readProjectFolder } from '../storage/mirror.ts';
import { createSnapshot } from '../storage/snapshots.ts';
import { projectFromSingleMarkdown } from '../storage/serialize.ts';
import { countWords } from '../model/words.ts';

// The library: every book as a cover. Create, rename, duplicate, delete
// (to a trash you can restore from), import and back up.

let root: HTMLElement;

export function bookCover(p: Project, size: 'card' | 'small' = 'card'): HTMLElement {
  const t = getTemplate(p.templateId);
  const s = effectiveSettings(p);
  const style = t.cover.style || 'leather';
  const lines = p.meta.title.trim() || 'Untitled Book';
  return h('div', {
    class: `cover cover-${style} cover-${size}`,
    style: { '--leather': t.cover.leather, '--foil': t.cover.foil, '--cover-font': fontStack(s.type.display) } as any,
  },
  h('div', { class: 'cover-frame' },
    h('div', { class: 'cover-title' }, lines),
    p.meta.subtitle ? h('div', { class: 'cover-sub' }, p.meta.subtitle) : null,
    h('div', { class: 'cover-orn' }, '❦'),
    h('div', { class: 'cover-author' }, p.meta.author || '')));
}

async function storageLine(): Promise<HTMLElement> {
  const el = h('div', { class: 'storage-line' });
  try {
    const persisted = await navigator.storage?.persisted?.();
    const est = await navigator.storage?.estimate?.();
    const used = est?.usage ? `${(est.usage / 1048576).toFixed(1)} MB used` : '';
    el.append(icon(persisted ? 'check' : 'info', 14), h('span', null,
      persisted ? 'Stored on this computer. The browser has agreed to keep it.' : 'Stored on this computer. Add a backup folder or download a backup to be safe.',
      used ? ` · ${used}` : ''));
  } catch { el.textContent = 'Stored on this computer.'; }
  return el;
}

function mirrorChip(): HTMLElement {
  const chip = h('button', { class: 'chip', type: 'button' });
  const paint = () => {
    chip.replaceChildren(icon('folder', 15));
    const st = mirror.status;
    if (st === 'unsupported') { chip.append(h('span', null, 'Folder backup needs Chrome')); chip.title = 'Saving to a folder uses the File System Access API, available in Chrome and Edge. Use “Download backup” in this browser.'; chip.classList.add('muted'); }
    else if (st === 'off') { chip.append(h('span', null, 'Back up to a folder…')); chip.title = 'Mirror every book as .md files in a folder on your Mac.'; }
    else if (st === 'needs-permission') { chip.append(h('span', null, `Reconnect “${mirror.folderName}”`)); chip.classList.add('warn'); chip.title = 'The browser needs your permission again to write to the backup folder.'; }
    else if (st === 'ok') { chip.append(h('span', null, `Mirroring to “${mirror.folderName}”`)); chip.classList.remove('warn'); chip.classList.add('ok'); chip.title = mirror.lastWrite ? `Last written ${formatRelative(mirror.lastWrite)}` : 'Connected'; }
    else { chip.append(h('span', null, 'Folder backup error')); chip.classList.add('warn'); chip.title = mirror.lastError; }
  };
  paint();
  const off = mirror.onChange(() => { if (!chip.isConnected) off(); else paint(); });
  chip.addEventListener('click', async () => {
    if (mirror.status === 'unsupported') return void toast('Folder backup works in Chrome or Edge. In this browser, use Backup ▸ Download backup.', { timeout: 6000 });
    if (mirror.status === 'needs-permission') { if (await mirror.reconnect()) { toast('Backup folder reconnected.', { kind: 'success' }); void mirror.writeAll(); } return; }
    if (mirror.status === 'ok') {
      showMenu(chip, [
        { label: 'Write all books now', icon: 'save', onClick: async () => { await mirror.writeAll(); toast('All books written to the folder.', { kind: 'success' }); } },
        { label: 'Choose a different folder…', icon: 'folder', onClick: async () => { if (await mirror.choose()) await mirror.writeAll(); } },
        { separator: true, label: '' },
        { label: 'Stop mirroring', icon: 'close', onClick: () => mirror.disconnect() },
      ]);
      return;
    }
    if (await mirror.choose()) {
      toast('Writing your books to the folder…');
      await mirror.writeAll();
      toast(`Every book is now mirrored to “${mirror.folderName}” as Markdown files.`, { kind: 'success', timeout: 5000 });
    }
  });
  return chip;
}

async function newBookDialog(): Promise<void> {
  const m = modal('New book', { wide: true });
  const title = h('input', { class: 'input', type: 'text', placeholder: 'The title of your book' }) as HTMLInputElement;
  const author = h('input', { class: 'input', type: 'text', placeholder: 'Your name' }) as HTMLInputElement;
  author.value = (await repo.kvGet<string>('lastAuthor')) || '';
  let chosen = 'classic';
  const grid = h('div', { class: 'tpl-pick' });
  const paint = () => {
    grid.replaceChildren(...allTemplates().map((t) => {
      const card = h('button', { class: `tpl-card ${t.id === chosen ? 'on' : ''}`, type: 'button' },
        bookCover({ meta: { title: t.name, subtitle: '', author: '', publisher: '', year: '', language: 'en', extra: {} }, templateId: t.id, overrides: {} } as any, 'small'),
        h('div', { class: 'tpl-card-name' }, t.name),
        h('div', { class: 'tpl-card-desc' }, t.description));
      card.addEventListener('click', () => { chosen = t.id; paint(); });
      return card;
    }));
  };
  paint();
  const form = h('form', { class: 'dlg-form' },
    h('div', { class: 'row2' }, h('label', { class: 'field' }, h('span', null, 'Title'), title), h('label', { class: 'field' }, h('span', null, 'Author'), author)),
    h('div', { class: 'field' }, h('span', null, 'Design'), grid));
  m.body.appendChild(form);
  const create = async () => {
    const t = title.value.trim() || 'Untitled Book';
    await repo.kvSet('lastAuthor', author.value.trim());
    const { project, sections } = newProject({ title: t, author: author.value.trim(), templateId: chosen });
    for (const s of sections) if (s.kind === 'title') { s.content = titleContentFromMeta(project.meta); s.words = countWords(s.content); }
    await repo.createProject(project, sections);
    m.close();
    location.hash = `#/book/${project.id}`;
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); void create(); });
  const cancel = button('Cancel', { onClick: () => m.close() });
  const ok = button('Create book', { class: 'primary', onClick: () => void create() });
  m.footer.append(cancel, ok);
  setTimeout(() => title.focus(), 0);
}

async function renameProject(p: Project): Promise<void> {
  const v = await promptDialog('Rename book', 'Title', p.meta.title.replace(/\n/g, ' '), { ok: 'Rename' });
  if (v === null || !v.trim()) return;
  p.meta.title = v.trim();
  const sections = await repo.getSections(p);
  const t = sections.find((s) => s.kind === 'title');
  if (t) { t.content = titleContentFromMeta(p.meta, t.content); t.updatedAt = Date.now(); }
  p.updatedAt = Date.now();
  await repo.saveSections(p, t ? [t] : []);
  mirror.schedule(p, sections, 200);
  await renderHome(root);
}

async function duplicate(p: Project): Promise<void> {
  const copy = await repo.duplicateProject(p, `${plainTitle(p.meta)} (copy)`);
  toast(`Duplicated as “${plainTitle(copy.meta)}”.`, { kind: 'success' });
  await renderHome(root);
}

async function trash(p: Project): Promise<void> {
  const ok = await confirmDialog('Move to Recently Deleted?', `“${plainTitle(p.meta)}” will move to Recently Deleted at the bottom of your library, where you can restore it.`, { ok: 'Move to Recently Deleted', danger: true });
  if (!ok) return;
  const sections = await repo.getSections(p);
  await createSnapshot(p, sections, { auto: false, label: 'Before deleting', reason: 'Before deleting' }).catch(() => undefined);
  p.deletedAt = Date.now();
  await repo.saveProject(p);
  toast(`Moved “${plainTitle(p.meta)}” to Recently Deleted.`, {
    action: 'Undo', onAction: async () => { p.deletedAt = null; await repo.saveProject(p); await renderHome(root); },
  });
  await renderHome(root);
}

async function purge(p: Project): Promise<void> {
  const mirrored = mirror.status === 'ok' && p.mirror?.folder;
  const ok = await confirmDialog('Delete forever?', `“${plainTitle(p.meta)}” and its version history will be permanently deleted from this browser${mirrored ? `, along with its folder “${p.mirror!.folder}” in your backup folder` : ''}. This cannot be undone.`, { ok: 'Delete forever', danger: true });
  if (!ok) return;
  if (mirrored) await mirror.removeFolder(p.mirror!.folder, p.id);
  await repo.purgeProject(p.id);
  await renderHome(root);
}

async function exportOne(p: Project): Promise<void> {
  const { exportBackup } = await import('../storage/backup.ts');
  const blob = await exportBackup({ includeHistory: false, projectIds: [p.id] });
  downloadBlob(blob, `${plainTitle(p.meta)}.zip`);
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } }) as HTMLInputElement;
    input.addEventListener('change', () => { resolve(input.files?.[0] || null); input.remove(); });
    document.body.appendChild(input);
    input.click();
  });
}

export async function importBackupFile(file: File): Promise<void> {
  const { readBackup, applyImport } = await import('../storage/backup.ts');
  const plan = await readBackup(file);
  if (!plan.books.length) { toast('No books were found in that file.', { kind: 'error' }); return; }
  const clash = plan.books.filter((b) => b.exists).length;
  let mode: 'replace' | 'copy' = 'copy';
  if (clash) {
    const choice = await choiceDialog('Restore backup', `This backup has ${plan.books.length} book${plan.books.length > 1 ? 's' : ''}. ${clash} already ${clash > 1 ? 'exist' : 'exists'} in your library. Replace ${clash > 1 ? 'them' : 'it'} with the backup, or keep both?`, [
      { value: 'copy', label: 'Keep both' },
      { value: 'replace', label: 'Replace with backup', danger: true },
    ]);
    if (!choice) return;
    mode = choice;
    if (mode === 'replace') {
      for (const b of plan.books.filter((x) => x.exists)) {
        const cur = await repo.getProject(b.project.id);
        if (cur) await createSnapshot(cur, await repo.getSections(cur), { auto: false, label: 'Before restoring a backup', reason: 'Before restoring a backup' }).catch(() => undefined);
      }
    }
  }
  const n = await applyImport(plan, mode);
  setCustomTemplates(await repo.listCustomTemplates());
  toast(`Imported ${n} book${n > 1 ? 's' : ''}.`, { kind: 'success' });
  await renderHome(root);
}

async function importMenu(anchor: HTMLElement): Promise<void> {
  showMenu(anchor, [
    { label: 'Backup (.zip)…', icon: 'import', hint: 'restore', onClick: async () => { const f = await pickFile('.zip,application/zip'); if (f) await importBackupFile(f).catch((e) => toast(`Import failed: ${e.message}`, { kind: 'error' })); } },
    { label: 'Markdown file (.md)…', icon: 'book', onClick: async () => {
      const f = await pickFile('.md,.markdown,.txt,text/markdown,text/plain');
      if (!f) return;
      const { project, sections } = projectFromSingleMarkdown(await f.text(), f.name);
      await repo.createProject(project, sections);
      toast(`Imported “${plainTitle(project.meta)}” with ${sections.filter((s) => s.kind === 'chapter').length} chapters.`, { kind: 'success' });
      location.hash = `#/book/${project.id}`;
    } },
    { label: 'Folder of Markdown files…', icon: 'folder', disabled: !mirrorSupported, hint: mirrorSupported ? '' : 'Chrome', onClick: async () => {
      try {
        const r = await readProjectFolder();
        if (!r) return;
        const exists = await repo.getProject(r.project.id);
        if (exists) {
          const choice = await choiceDialog('Import folder', `“${plainTitle(r.project.meta)}” is already in your library. Replace it with the folder’s version, or keep both?`, [
            { value: 'copy', label: 'Keep both' }, { value: 'replace', label: 'Replace', danger: true }]);
          if (!choice) return;
          const { applyImport } = await import('../storage/backup.ts');
          await createSnapshot(exists, await repo.getSections(exists), { auto: false, label: 'Before importing folder' }).catch(() => undefined);
          await applyImport({ manifest: null, templates: [], books: [{ ...r, assets: [], history: [], exists: true, deleted: false }] }, choice);
        } else {
          await repo.createProject(r.project, r.sections);
        }
        for (const [name, file] of r.images) {
          await repo.saveAsset({ id: name.replace(/\.[^.]+$/, ''), projectId: r.project.id, name, type: file.type, blob: file, createdAt: Date.now() });
        }
        toast(`Imported “${plainTitle(r.project.meta)}”.`, { kind: 'success' });
        await renderHome(root);
      } catch (e: any) { toast(e.message, { kind: 'error' }); }
    } },
  ]);
}

function backupMenu(anchor: HTMLElement): void {
  const run = async (includeHistory: boolean) => {
    const { exportBackup, backupFilename } = await import('../storage/backup.ts');
    const done = toast('Preparing backup…', { timeout: 0 });
    try {
      const blob = await exportBackup({ includeHistory, includeDeleted: true });
      downloadBlob(blob, backupFilename());
      await repo.kvSet('lastBackup', Date.now());
      done();
      toast('Backup downloaded.', { kind: 'success' });
    } catch (e: any) { done(); toast(`Backup failed: ${e.message}`, { kind: 'error' }); }
  };
  showMenu(anchor, [
    { label: 'Download backup (.zip)', icon: 'export', hint: 'all books', onClick: () => void run(false) },
    { label: 'Download backup with version history', icon: 'history', onClick: () => void run(true) },
  ]);
}

function card(p: Project, sections: number): HTMLElement {
  const more = h('button', { class: 'btn icon card-more', type: 'button', 'aria-label': 'Book options' }, icon('more'));
  const el = h('div', { class: 'book-card', tabindex: '0', role: 'button', 'aria-label': `Open ${plainTitle(p.meta)}` },
    h('div', { class: 'book-3d' }, bookCover(p)),
    h('div', { class: 'card-info' },
      h('div', { class: 'card-title' }, plainTitle(p.meta)),
      h('div', { class: 'card-meta' }, `${fmtNum(p.words)} words · ${sections} ${sections === 1 ? 'section' : 'sections'}`),
      h('div', { class: 'card-meta' }, `Edited ${formatRelative(p.updatedAt)}`)),
    more);
  const open = () => { location.hash = `#/book/${p.id}`; };
  el.addEventListener('click', (e) => { if (!more.contains(e.target as Node)) open(); });
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    showMenu(more, [
      { label: 'Open', icon: 'book', onClick: open },
      { label: 'Rename…', icon: 'edit', onClick: () => void renameProject(p) },
      { label: 'Duplicate', icon: 'copy', onClick: () => void duplicate(p) },
      { label: 'Download this book (.zip)', icon: 'export', onClick: () => void exportOne(p) },
      { separator: true, label: '' },
      { label: 'Delete…', icon: 'trash', danger: true, onClick: () => void trash(p) },
    ]);
  });
  return el;
}

export async function renderHome(container: HTMLElement): Promise<void> {
  root = container;
  document.title = 'SerifWriter';
  document.body.className = 'route-home';
  const projects = await repo.listProjects();
  const live = projects.filter((p) => !p.deletedAt).sort((a, b) => b.updatedAt - a.updatedAt);
  const deleted = projects.filter((p) => p.deletedAt).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
  const counts = new Map(projects.map((p) => [p.id, p.order.length]));

  const importBtn = button('Import', { icon: 'import' });
  importBtn.addEventListener('click', () => void importMenu(importBtn));
  const backupBtn = button('Backup', { icon: 'save' });
  backupBtn.addEventListener('click', () => backupMenu(backupBtn));

  const newCard = h('button', { class: 'book-card new-card', type: 'button' },
    h('div', { class: 'new-cover' }, icon('plus', 28), h('span', null, 'New book')));
  newCard.addEventListener('click', () => void newBookDialog());

  const main = h('main', { class: 'home' },
    h('header', { class: 'home-head' },
      h('div', { class: 'brand' }, h('div', { class: 'brand-name' }, 'SerifWriter'), h('div', { class: 'brand-sub' }, 'Your library')),
      h('div', { class: 'home-actions' }, mirrorChip(), importBtn, backupBtn,
        button('New book', { icon: 'plus', class: 'primary', onClick: () => void newBookDialog() }))),
    h('section', { class: 'shelf' }, ...live.map((p) => card(p, counts.get(p.id) || 0)), newCard),
    deleted.length ? h('details', { class: 'trash' },
      h('summary', null, `Recently deleted (${deleted.length})`),
      h('div', { class: 'trash-list' }, ...deleted.map((p) => h('div', { class: 'trash-row' },
        h('span', { class: 'trash-title' }, plainTitle(p.meta)),
        h('span', { class: 'card-meta' }, `deleted ${formatRelative(p.deletedAt!)}`),
        button('Restore', { icon: 'restore', class: 'small', onClick: async () => { p.deletedAt = null; await repo.saveProject(p); await renderHome(root); } }),
        button('Delete forever', { class: 'small danger', onClick: () => void purge(p) }))))) : null,
    h('footer', { class: 'home-foot' }, await storageLine(),
      h('div', null, 'Private by design: no accounts, no servers. Your writing never leaves this device unless you export it.')));
  container.replaceChildren(main);
}
