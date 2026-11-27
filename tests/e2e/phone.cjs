// Phone checks: the app on an emulated iPhone 14 Plus (428 × 926, touch).
// Called from run.cjs with the same URL and check() reporter.
const { chromium, devices } = require('playwright');

module.exports = async function phoneChecks(URL, check) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['iPhone 14 Plus'], deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL);
  await page.waitForFunction(() => window.serifwriter && window.serifwriter.project());
  await page.waitForFunction(() => { const c = window.serifwriter.project(); return c && !c.book.busy && c.book.pageRefs.length > 0; }, null, { timeout: 60000 });
  const shown = (sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; }, sel);

  const bar = await page.evaluate(() => { const b = document.querySelector('.pj-bar'); return { fits: b.scrollWidth <= b.clientWidth && document.documentElement.scrollWidth <= innerWidth, title: document.querySelector('.pj-title').getBoundingClientRect().width }; });
  check('phone: the top bar fits the screen, with room for the title', bar.fits && bar.title > 100, JSON.stringify(bar));
  check('phone: opens on the writing pane with writing keys, pages out of sight', await shown('.editor-ta') && await shown('.pj-keys') && !(await shown('.preview')) && !(await shown('.pj-design')));

  const seg = await page.evaluate(() => Array.from(document.querySelectorAll('.pj-seg-btn')).map((b) => ({ label: b.getAttribute('aria-label'), text: b.textContent.trim(), icon: !!b.querySelector('svg') })));
  check('phone: Write and Pages are an icon switch, labelled for VoiceOver', JSON.stringify(seg) === '[{"label":"Write","text":"","icon":true},{"label":"Pages","text":"","icon":true}]', JSON.stringify(seg));
  const small = await page.evaluate(() => Array.from(document.querySelectorAll('.pj-bar button, .pj-bar a, .pj-key')).filter((b) => b.offsetParent && b.getBoundingClientRect().height < 34).map((b) => b.getAttribute('aria-label') || b.textContent));
  check('phone: top bar and writing keys are finger-sized', small.length === 0, small.join(', '));
  await page.getByRole('button', { name: 'Pages', exact: true }).tap();
  await page.waitForTimeout(500);
  check('phone: Pages shows the typeset book in place of the editor', await shown('.preview .pv-frame') && !(await shown('.editor-ta')));
  await page.getByRole('button', { name: 'Write', exact: true }).tap();

  await page.locator('.pj-contents').tap();
  await page.waitForTimeout(450);
  check('phone: the contents slide in as a drawer', await shown('.sidebar .sb-item'));
  check('phone: behind the open drawer the page is out of reach (inert)', await page.evaluate(() => document.querySelector('.pj-editor').inert && document.querySelector('.pj-bar').inert));
  // Drag it back to the left to close it, then open it again.
  const sb = await page.locator('.sidebar').boundingBox();
  await page.evaluate(({ x, y }) => {
    const el = document.querySelector('.sidebar');
    const ev = (type, cx) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'touch', pointerId: 7, clientX: cx, clientY: y }));
    ev('pointerdown', x); for (let i = 1; i <= 6; i++) ev('pointermove', x - i * 25); ev('pointerup', x - 150);
  }, { x: sb.x + sb.width - 40, y: sb.y + 300 });
  await page.waitForTimeout(400);
  check('phone: swiping the drawer left closes it', !(await page.evaluate(() => document.querySelector('.project').classList.contains('sb-open'))) && !(await page.evaluate(() => document.querySelector('.pj-editor').inert)));
  await page.locator('.pj-contents').tap();
  await page.waitForTimeout(450);
  await page.locator('.sb-item', { hasText: 'Notes from the Side' }).tap();
  await page.waitForTimeout(450);
  const picked = await page.evaluate(() => ({ open: document.querySelector('.project').classList.contains('sb-open'), text: document.querySelector('.editor-ta').value.slice(0, 200) }));
  check('phone: picking a chapter closes the drawer and opens it for writing', !picked.open && !(await shown('.sidebar .sb-item')) && picked.text.length > 0, picked.text.slice(0, 40));

  await page.locator('.editor-ta').tap();
  await page.locator('.editor-ta').press('Control+End');
  await page.keyboard.type('\n\nAll men are mortal');
  check('phone: the writing keys start with line and format keys; symbols wait behind “Symbols ›”', !(await page.locator('.pj-key[title="Therefore"]').isVisible()) && await page.locator('.pj-key[title="Symbols"]').isVisible());
  await page.locator('.pj-key[title^="Indent"]').tap();
  await page.locator('.pj-key[title="Symbols"]').tap();
  await page.locator('.pj-key[title="Therefore"]').tap();
  const last = await page.evaluate(() => { const v = document.querySelector('.editor-ta').value; return v.slice(v.lastIndexOf('\n') + 1); });
  check('phone: the ⇥ key indents the line and the Symbols row types ∴, as there is no Tab key', last === '\tAll men are mortal∴', JSON.stringify(last));
  await page.locator('.pj-key[title^="Back"]').tap();
  check('phone: ‹ goes back to the writing keys', await page.locator('.pj-key[title="Bold"]').isVisible() && !(await page.locator('.pj-key[title="Therefore"]').isVisible()));

  await page.locator('.pj-more').tap();
  await page.locator('.menu-item', { hasText: 'Indent new paragraphs' }).tap();
  await page.locator('.pj-more').tap();
  await page.locator('.menu-item', { hasText: 'Return starts a new line' }).tap();
  const quick = await page.evaluate(() => window.serifwriter.project().session.project.overrides.type);
  await page.locator('.pj-more').tap();
  const ticks = await page.locator('.menu-item').evaluateAll((els) => els.filter((e) => /Indent new paragraphs|Return starts/.test(e.textContent)).map((e) => e.querySelector('.menu-ico-space')?.textContent));
  await page.keyboard.press('Escape');
  check('phone: ⋯ has one-tap toggles for paragraph indents and line breaks, ticked when on', JSON.stringify(quick) === '{"autoIndent":false,"lineBreaks":false}' && ticks.join() === ',', `${JSON.stringify(quick)} ${ticks.join()}`);

  await page.locator('.pj-more').tap();
  await page.locator('.menu-item', { hasText: 'Design' }).tap();
  await page.waitForTimeout(500);
  const sheet = await page.evaluate(() => { const d = document.querySelector('.drawer').getBoundingClientRect(); return { top: d.top, bottom: d.bottom, h: innerHeight }; });
  check('phone: Design opens as a sheet over the lower screen, the pages above it', await shown('.preview .pv-frame') && sheet.top > 200 && Math.abs(sheet.bottom - sheet.h) < 2, JSON.stringify(sheet));
  await page.locator('.drawer-head .btn').tap();

  await page.locator('.pj-more').tap();
  await page.locator('.menu-item', { hasText: 'Export' }).tap();
  await page.waitForTimeout(400);
  const exp = await page.evaluate(() => { const d = document.querySelector('dialog.dlg').getBoundingClientRect(); const b = document.querySelector('.exp-item .btn').getBoundingClientRect(); return { left: d.left, width: d.width, bottom: d.bottom, h: innerHeight, btn: Math.round(b.width), label: document.querySelector('.exp-item .btn').textContent }; });
  check('phone: dialogs open as full-width sheets from the bottom, with full-width actions', exp.left === 0 && exp.width === 428 && Math.abs(exp.bottom - exp.h) < 2 && exp.btn > 300 && exp.label === 'Save PDF…', JSON.stringify(exp));
  const head = await page.locator('dialog .dlg-head').boundingBox();
  await page.evaluate(({ x, y }) => {
    const el = document.querySelector('dialog .dlg-head');
    const ev = (type, cy) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'touch', pointerId: 8, clientX: x, clientY: cy }));
    ev('pointerdown', y); for (let i = 1; i <= 6; i++) ev('pointermove', y + i * 30); ev('pointerup', y + 180);
  }, { x: head.x + 120, y: head.y + 10 });
  await page.waitForTimeout(300);
  check('phone: dragging a sheet down dismisses it', await page.locator('dialog[open]').count() === 0);

  await page.goto(URL + '#/');
  await page.waitForSelector('.book-card');
  check('phone: Safari on an iPhone explains Add to Home Screen', await shown('.install-tip'));
  check('phone: launch screens are linked for the Home Screen app', await page.evaluate(() => document.querySelectorAll('link[rel="apple-touch-startup-image"]').length) === 4);
  check('phone: book options are visible without hovering', (await page.locator('.card-more').first().evaluate((b) => getComputedStyle(b).opacity)) === '1');
  check('phone: library fits the screen', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check('phone: no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' / '));
  await browser.close();
};
