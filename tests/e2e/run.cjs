// End-to-end checks in a real Chromium. Run against a production build:
//   npm run build && npm run preview      (in another terminal)
//   npm run e2e                            (or: node tests/e2e/run.cjs http://localhost:4173/)
const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const URL = process.argv[2] || 'http://localhost:4173/';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

async function textOf(page) { return page.locator('.editor-ta').inputValue(); }
const ctxInfo = (page) => page.evaluate(() => { const c = window.serifwriter.project(); return c ? { id: c.session.project.id, pages: c.book.pageRefs.length, busy: c.book.busy } : null; });
const idle = (page) => page.waitForFunction(() => { const c = window.serifwriter.project(); return c && !c.book.busy && c.book.pageRefs.length > 0; }, null, { timeout: 60000 });

(async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-e2e-'));
  const context = await chromium.launchPersistentContext(userDir, { viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  let page = context.pages()[0] || await context.newPage();
  const errors = [];
  const watch = (p) => p.on('pageerror', (e) => errors.push(e.message));
  watch(page);

  // ── first launch: sample book opens ──
  await page.goto(URL);
  await page.waitForFunction(() => window.serifwriter && window.serifwriter.project());
  await idle(page);
  const first = await ctxInfo(page);
  check('first launch opens the sample book, typeset', first && first.pages >= 12, `${first?.pages} pages`);
  const bookId = first.id;

  // ── autosave survives a reload ──
  await page.locator('.sb-item', { hasText: 'The First Light' }).click();
  await page.locator('.editor-ta').press('Control+End');
  await page.keyboard.type('\n\nAutosave sentence one.');
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForFunction(() => window.serifwriter && window.serifwriter.project());
  check('reopens the same book and chapter after reload', (await textOf(page)).includes('Autosave sentence one.'));

  // ── crash journal: close the tab mid-typing, before the debounce fires ──
  await page.locator('.editor-ta').press('Control+End');
  await page.keyboard.type(' Typed just before the tab closed.');
  await page.close({ runBeforeUnload: true });
  page = await context.newPage();
  watch(page);
  await page.goto(URL);
  await page.waitForFunction(() => window.serifwriter && window.serifwriter.project());
  check('text typed right before closing the tab is not lost', (await textOf(page)).includes('Typed just before the tab closed.'));

  // ── live preview updates only after a pause, and only re-paginates this chapter ──
  await idle(page);
  await page.locator('.editor-ta').press('Control+End');
  await page.keyboard.type('\n\n---\n\nA scene after a break, with a note.[^9]\n\n[^9]: The note.');
  await page.waitForTimeout(1600);
  await idle(page);
  const sb = await page.locator('.pv-root .scene-break').count();
  const fn = await page.locator('.pv-root .pg-notes .fn').count();
  check('scene break and page-bottom footnote appear in the preview', sb >= 2 && fn >= 2, `${sb} breaks, ${fn} notes`);

  // ── scholarship: bibliography, citations, math, find & replace, exports ──
  await page.getByRole('button', { name: 'Add' }).click();
  await page.locator('.menu-item', { hasText: 'Bibliography' }).click();
  await page.locator('.editor-ta').fill('@book{arendt58, author = {Arendt, Hannah}, title = {The Human Condition}, publisher = {University of Chicago Press}, address = {Chicago}, year = 1958}\n');
  await page.locator('.sb-item', { hasText: 'The First Light' }).click();
  await page.locator('.editor-ta').press('Control+End');
  await page.keyboard.type('\n\nAs Arendt argues [@arendt58, 7-9], we act; @arendt58 says so. Euler: $e^{i\\pi}+1=0$, at $5 or $10.');
  await page.waitForTimeout(1800);
  await idle(page);
  const sch = await page.evaluate(() => ({
    cites: Array.from(document.querySelectorAll('.pv-root .cite')).map((e) => e.textContent),
    bib: document.querySelector('.pv-root .bib-entry')?.textContent || '',
    math: document.querySelectorAll('.pv-root math').length,
  }));
  check('author–date citations are set from the BibTeX', sch.cites.includes('(Arendt 1958, 7–9)') && sch.cites.includes('Arendt (1958)'), sch.cites.join(' | '));
  check('the bibliography lists the cited work', sch.bib.startsWith('Arendt, Hannah. 1958. The Human Condition.'), sch.bib);
  check('TeX math is set as MathML (and prices are left alone)', sch.math === 1, `${sch.math} formulas`);
  await page.locator('.editor-ta').evaluate((ta) => { ta.setRangeText('\n\nAs @tbl:kept shows.\n\n| Rule | Kept |\n|---|---|\n| Date first | 212 |\n\nTable: Rules kept {#tbl:kept}\n', ta.value.length, ta.value.length); ta.dispatchEvent(new Event('input')); });
  await page.waitForTimeout(1800);
  await idle(page);
  const xref = await page.evaluate(() => [document.querySelector('.pv-root .tbl-cap')?.textContent, Array.from(document.querySelectorAll('.pv-root p')).some((p) => p.textContent === 'As Table 1 shows.')]);
  check('cross-references number a table and refer to it', xref[0] === 'Table 1. Rules kept' && xref[1], String(xref[0]));
  await page.evaluate(() => { const c = window.serifwriter.project(); c.session.project.overrides = { citations: 'note' }; return c.relayout(); });
  await idle(page);
  const noteCite = await page.evaluate(() => Array.from(document.querySelectorAll('.pv-root .pg-notes .fn')).some((n) => n.textContent.includes('Hannah Arendt, The Human Condition (Chicago: University of Chicago Press, 1958), 7–9.')));
  check('notes style turns citations into Chicago footnotes', noteCite);
  await page.locator('.pj-bar').getByRole('button', { name: 'Export' }).click();
  const [docx] = await Promise.all([page.waitForEvent('download'), page.locator('.exp-list > *', { hasText: 'Word document' }).getByRole('button', { name: 'Download' }).click()]);
  const { unzipSync, strFromU8 } = require('fflate');
  const docxFiles = unzipSync(fs.readFileSync(await docx.path()));
  check('DOCX carries the citation as a real Word footnote', strFromU8(docxFiles['word/footnotes.xml']).includes('Hannah Arendt'));
  const [epub] = await Promise.all([page.waitForEvent('download'), page.locator('.exp-list > *', { hasText: 'EPUB e-book' }).getByRole('button', { name: 'Download' }).click()]);
  const epubFiles = unzipSync(fs.readFileSync(await epub.path()));
  check('EPUB carries MathML and declares it', Object.values(epubFiles).some((f) => strFromU8(f).includes('<math')) && strFromU8(epubFiles['OEBPS/content.opf'] || Object.entries(epubFiles).find(([n]) => n.endsWith('.opf'))[1]).includes('mathml'));
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const c = window.serifwriter.project(); c.session.project.overrides = {}; return c.relayout(); });
  await page.locator('.editor-ta').press('Control+f');
  await page.locator('.find-dlg input').first().fill('we act');
  await page.locator('.find-dlg input').nth(1).fill('we begin');
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Replace all' }).click();
  await page.waitForTimeout(500);
  check('find & replace changes the book', (await textOf(page)).includes('we begin;'));
  await page.locator('.editor-ta').press('Control+End');
  await page.keyboard.press('Control+Shift+K');
  await page.locator('.find-dlg input').fill('arendt 1958');
  await page.keyboard.press('Enter');
  check('⌘⇧K searches the bibliography and inserts a citation', (await textOf(page)).trimEnd().endsWith('[@arendt58]'));
  await page.keyboard.type(' \\forall x \\to y');
  check('\\forall and \\to become logic symbols as you type', (await textOf(page)).endsWith('∀x → y'));
  await page.waitForTimeout(800);
  await page.locator('.sb-totals').click();
  await page.waitForSelector('.stats-dlg .st-chart svg');
  const stats = await page.evaluate(() => ({ tiles: document.querySelectorAll('.stats-dlg .st-tile').length, today: document.querySelector('.stats-dlg .st-num')?.textContent, charts: document.querySelectorAll('.stats-dlg .st-chart svg').length }));
  check('writing stats show today’s words and the habit charts', stats.tiles >= 9 && /^\+\d/.test(stats.today) && stats.charts >= 3, JSON.stringify(stats));
  await page.keyboard.press('Escape');

  // ── paragraphs: indenting off, and Return starting a new line ──
  await page.locator('.editor-ta').press('Control+End');
  await page.keyboard.type('\n\nP1. All men are mortal.\nP2. Socrates is a man.\n\nC. So Socrates is mortal.');
  await page.waitForTimeout(1600);
  await idle(page);
  const indentOf = () => page.evaluate(() => { const p = Array.from(document.querySelectorAll('.pv-root .pg-content p')).find((x) => x.textContent.startsWith('C. So Socrates')); return p ? getComputedStyle(p).textIndent : null; });
  const runOn = () => page.evaluate(() => Array.from(document.querySelectorAll('.pv-root .pg-content p')).some((p) => p.innerHTML.includes('P1. All men are mortal.<br>')));
  const indentBefore = await indentOf();
  const brBefore = await runOn();
  await page.getByRole('button', { name: 'Design' }).click();
  await page.locator('.ds-toggle', { hasText: 'Indent new paragraphs' }).locator('input').uncheck();
  await page.locator('.ds-toggle', { hasText: 'Return starts a new line' }).locator('input').uncheck();
  await page.waitForTimeout(900);
  await idle(page);
  const indentAfter = await indentOf();
  check('“Indent new paragraphs” off sets every paragraph flush left', indentBefore && indentBefore !== '0px' && indentAfter === '0px', `${indentBefore} → ${indentAfter}`);
  check('a single Return starts a new line on the page, by default', brBefore);
  check('turning “Return starts a new line” off runs the lines together, as in Markdown', !(await runOn()));
  check('and the settings are kept with the book', JSON.stringify(await page.evaluate(() => window.serifwriter.project().session.project.overrides.type)) === '{"autoIndent":false,"lineBreaks":false}');
  await page.locator('.ds-toggle', { hasText: 'Space between paragraphs' }).locator('input').check();
  check('space between paragraphs greys out the indent toggle', await page.locator('.ds-toggle', { hasText: 'Indent new paragraphs' }).locator('input').isDisabled());
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const c = window.serifwriter.project(); c.session.project.overrides = {}; return c.relayout(); });

  // ── service worker: works offline ──
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.serifwriter && window.serifwriter.project(), null, { timeout: 15000 });
  await idle(page);
  const offlineFonts = await page.evaluate(() => document.fonts.check('11pt "SW Cardo"'));
  check('opens with no network (service worker), fonts available offline', offlineFonts);
  await context.setOffline(false);

  // ── folder mirror (Origin Private File System stands in for a real folder) ──
  const mirrored = await page.evaluate(async () => {
    const { mirror } = window.serifwriter;
    mirror.root = await navigator.storage.getDirectory();
    mirror.status = 'ok';
    await mirror.writeAll();
    const out = [];
    for await (const [name, h] of mirror.root.entries()) {
      if (h.kind !== 'directory') continue;
      for await (const [f] of h.entries()) out.push(`${name}/${f}`);
    }
    const dir = await mirror.root.getDirectoryHandle('The Road Behind Us');
    const md = await (await (await dir.getFileHandle('06 The First Light.md')).getFile()).text();
    return { files: out, md: md.slice(0, 80) };
  });
  check('mirrors the book as .md files + project.json', mirrored.files.includes('The Road Behind Us/project.json') && mirrored.files.some((f) => f.endsWith('06 The First Light.md')), `${mirrored.files.length} files`);
  check('mirrored chapter file has YAML front matter', /^---\ntype: chapter\ntitle: The First Light/.test(mirrored.md));
  await page.evaluate(() => window.serifwriter.mirror.disconnect());

  // ── image paste ──
  await page.locator('.editor-ta').press('Control+End');
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 300; c.height = 160;
    const g = c.getContext('2d');
    g.fillStyle = '#7A1E1E'; g.fillRect(0, 0, 300, 160);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'plate.png', { type: 'image/png' }));
    document.querySelector('.editor-ta').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(1800);
  await idle(page);
  const img = await page.evaluate(() => { const i = document.querySelector('.pv-root figure img'); return i ? i.naturalWidth : 0; });
  check('pasted image is stored and set as a figure', img === 300);

  // ── sections: add, rename via prompt, reorder, delete (with a version) ──
  await page.getByRole('button', { name: 'Add' }).click();
  await page.locator('.menu-item', { hasText: /^Chapter$/ }).click();
  await page.locator('dialog input').fill('A Third Chapter');
  await page.keyboard.press('Enter');
  await page.locator('.editor-ta').type('Fresh words in a fresh chapter.');
  await page.waitForTimeout(1500);
  const titles = await page.locator('.sb-item .sb-title').allTextContents();
  check('adds and names a chapter right after the current one', titles.indexOf('A Third Chapter') === titles.indexOf('The First Light') + 1, titles.join(' | '));
  await page.locator('.sb-item', { hasText: 'A Third Chapter' }).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await page.waitForTimeout(300);
  const titles2 = await page.locator('.sb-item .sb-title').allTextContents();
  check('Alt+↑ moves a chapter up', titles2.indexOf('A Third Chapter') === titles.indexOf('A Third Chapter') - 1);
  // ── sidebar outline: the selected chapter's headings, indented, opening and closing ──
  await page.locator('.sb-item', { hasText: 'A Third Chapter' }).click();
  await page.locator('.editor-ta').press('Control+End');
  await page.keyboard.type('\n\n## The Argument\n\nWords.\n\n### A Premise\n\nMore words.\n\n## The Reply');
  await page.waitForTimeout(900);
  const subs = await page.locator('.sb-outline.open .sb-sub').evaluateAll((els) => els.map((e) => ({ t: e.textContent, lv: e.className.includes('lv-2') ? 2 : 1, x: e.querySelector('.sb-sub-title').getBoundingClientRect().left })));
  check('the selected chapter shows its sections and subsections, subsections indented', subs.map((x) => x.t).join('|') === 'The Argument|A Premise|The Reply' && subs[1].x > subs[0].x && subs[2].x === subs[0].x, JSON.stringify(subs));
  const under = await page.evaluate(() => document.querySelector('.sb-outline')?.previousElementSibling?.textContent || '');
  check('the outline sits under its chapter', under.includes('A Third Chapter'));
  await page.locator('.sb-item', { hasText: 'The First Light' }).click();
  await page.waitForTimeout(500);
  check('other chapters’ headings are hidden', await page.locator('.sb-sub', { hasText: 'The Argument' }).count() === 0);
  await page.locator('.sb-item', { hasText: 'A Third Chapter' }).click();
  await page.waitForTimeout(500);
  await page.locator('.sb-sub', { hasText: 'A Premise' }).click();
  await page.waitForTimeout(200);
  const caretLine = await page.locator('.editor-ta').evaluate((ta) => ta.value.slice(0, ta.selectionStart).split('\n').length - 1);
  const premiseLine = (await textOf(page)).split('\n').indexOf('### A Premise');
  check('a heading in the outline jumps the editor to it', caretLine === premiseLine, `${caretLine} vs ${premiseLine}`);
  await page.locator('.sb-item', { hasText: 'A Third Chapter' }).click();
  await page.waitForTimeout(500);
  check('clicking the selected chapter folds its headings away', await page.locator('.sb-sub', { hasText: 'The Argument' }).count() === 0);
  await page.locator('.sb-item', { hasText: 'A Third Chapter' }).click();
  await page.waitForTimeout(500);
  check('and clicking it again brings them back', await page.locator('.sb-outline.open .sb-sub', { hasText: 'The Argument' }).count() === 1);
  await idle(page);
  const toc = await page.evaluate(() => Array.from(document.querySelectorAll('.pv-root .toc-entry .toc-title')).map((e) => e.textContent));
  check('contents page lists the new chapter', toc.includes('A Third Chapter'), toc.join(' | '));
  const drops = await page.evaluate(() => Object.fromEntries(['There is an hour', 'Fresh words'].map((t) => [t, Array.from(document.querySelectorAll('.pv-root .pg-content p')).find((p) => p.textContent.startsWith(t))?.classList.contains('dropcap')])));
  check('a drop cap opens running prose, not a single short line', drops['There is an hour'] === true && drops['Fresh words'] === false, JSON.stringify(drops));
  const tocX = await page.evaluate(() => { const x = (sel) => document.querySelector(`.pv-root ${sel} .toc-title`)?.getBoundingClientRect().left ?? 0; return { chapter: x('.toc-chapter'), section: x('.toc-sub') }; });
  check('contents page indents sections from their chapter', tocX.section > tocX.chapter + 5, JSON.stringify(tocX));
  await page.locator('.sb-item', { hasText: 'A Third Chapter' }).click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Delete' }).click();
  await page.locator('dialog .btn.danger').click();
  await page.waitForTimeout(800);
  check('deletes a chapter', !(await page.locator('.sb-item .sb-title').allTextContents()).includes('A Third Chapter'));
  await page.locator('.pj-bar').getByRole('button', { name: 'History' }).click();
  await page.waitForTimeout(800);
  const labels = await page.locator('.hist-item .hist-label').allTextContents();
  check('a version was saved before the deletion', labels.some((l) => l.includes('Before deleting')), labels.slice(0, 4).join(' | '));
  await page.keyboard.press('Escape');

  // ── templates: switch, adjust, save as new ──
  await page.getByRole('button', { name: 'Design' }).click();
  await page.locator('.ds-tpl', { hasText: 'Pocket Edition' }).click();
  await page.waitForTimeout(500);
  await idle(page);
  const pocket = await page.evaluate(() => document.querySelector('.pv-root').className);
  check('switches template', pocket.includes('tpl-pocket'));
  await page.locator('.ds-row', { hasText: 'Page size' }).locator('select').selectOption('6x9');
  await page.waitForTimeout(800);
  await idle(page);
  const w = await page.evaluate(() => getComputedStyle(document.querySelector('.pv-root')).getPropertyValue('--page-w').trim());
  check('changing page size re-typesets the book', w === '6in', w);
  await page.getByRole('button', { name: 'Save as new template…' }).click();
  await page.locator('dialog input').fill('My Pocket 6×9');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  check('saves a custom template', await page.locator('.ds-tpl', { hasText: 'My Pocket 6×9' }).count() === 1);
  await page.keyboard.press('Escape');

  // ── library: backup, delete, restore from backup ──
  await page.goto(URL + '#/');
  await page.waitForSelector('.book-card');
  await page.getByRole('button', { name: 'Backup' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.menu-item', { hasText: 'Download backup (.zip)' }).click()]);
  const zipPath = path.join(userDir, 'backup.zip');
  await dl.saveAs(zipPath);
  check('downloads a backup zip', fs.statSync(zipPath).size > 1000, `${fs.statSync(zipPath).size} bytes`);
  await page.locator('.book-card', { hasText: 'The Road Behind Us' }).locator('.card-more').click();
  await page.locator('.menu-item', { hasText: 'Delete' }).click();
  await page.locator('dialog .btn.danger').click();
  await page.waitForTimeout(500);
  check('delete moves the book to Recently deleted', await page.locator('.trash summary').count() === 1);
  await page.locator('.trash summary').click();
  await page.locator('.trash-row .btn.danger').click();
  await page.locator('dialog .btn.danger').click();
  await page.waitForTimeout(500);
  check('delete forever removes it', await page.locator('.book-card', { hasText: 'The Road Behind Us' }).count() === 0);
  await page.getByRole('button', { name: 'Import' }).click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.menu-item', { hasText: 'Backup (.zip)' }).click()]);
  await chooser.setFiles(zipPath);
  await page.waitForSelector('.book-card:has-text("The Road Behind Us")', { timeout: 10000 });
  await page.locator('.book-card', { hasText: 'The Road Behind Us' }).click();
  await page.waitForFunction((id) => window.serifwriter.project() && window.serifwriter.project().session.project.id === id, bookId);
  await page.locator('.sb-item', { hasText: 'The First Light' }).click();
  check('restoring the backup brings back the text', (await textOf(page)).includes('Typed just before the tab closed.'));
  await idle(page);
  const restoredImg = await page.evaluate(() => { const i = document.querySelector('.pv-root figure img'); return i ? i.naturalWidth : 0; });
  check('and its images', restoredImg === 300);

  // ── library: new book, duplicate ──
  await page.goto(URL + '#/');
  await page.getByRole('button', { name: 'New book' }).first().click();
  await page.locator('dialog input').first().fill('Second Book');
  await page.locator('dialog .tpl-card', { hasText: 'Manuscript' }).click();
  await page.getByRole('button', { name: 'Create book' }).click();
  await page.waitForFunction(() => window.serifwriter.project() && document.querySelector('.pj-title')?.textContent === 'Second Book');
  check('creates a new book with the chosen template', (await page.evaluate(() => window.serifwriter.project().session.project.templateId)) === 'manuscript');

  check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' / '));
  await context.close();

  // ── on an iPhone ──
  await require('./phone.cjs')(URL, check);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
