// Sync between two devices — a Mac-sized window and an iPhone-sized one — through a
// stand-in for GitHub's contents API (an in-memory repository). Called from run.cjs.
const { chromium, devices } = require('playwright');
const crypto = require('node:crypto');

function fakeGitHub() {
  const files = new Map(); // path → { sha, text }
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS' };
  const json = (route, status, body) => route.fulfill({ status, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function handle(route) {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (req.headers().authorization !== 'Bearer test-token') return json(route, 401, { message: 'Bad credentials' });
    const m = /\/repos\/me\/books(?:\/contents\/(.*))?$/.exec(new URL(req.url()).pathname);
    if (!m) return json(route, 404, { message: 'Not Found' });
    const path = m[1];
    if (path === undefined) return json(route, 200, { private: true, permissions: { push: true } });
    if (req.method() === 'GET') {
      if (files.has(path)) { const f = files.get(path); return json(route, 200, { type: 'file', sha: f.sha, encoding: 'base64', content: Buffer.from(f.text).toString('base64') }); }
      const inDir = [...files.keys()].filter((p) => p.startsWith(path + '/'));
      return inDir.length ? json(route, 200, inDir.map((p) => ({ type: 'file', name: p.slice(path.length + 1), sha: files.get(p).sha }))) : json(route, 404, { message: 'Not Found' });
    }
    const body = JSON.parse(req.postData() || '{}');
    const cur = files.get(path);
    if (req.method() === 'PUT') {
      if (cur && body.sha !== cur.sha) return json(route, cur && !body.sha ? 422 : 409, { message: 'sha mismatch' });
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      const sha = crypto.createHash('sha1').update(text).digest('hex');
      files.set(path, { sha, text });
      return json(route, cur ? 200 : 201, { content: { sha } });
    }
    if (req.method() === 'DELETE') { if (!cur || body.sha !== cur.sha) return json(route, 409, {}); files.delete(path); return json(route, 200, {}); }
    return json(route, 405, {});
  }
  return { files, handle };
}

module.exports = async function syncChecks(URL, check) {
  const gh = fakeGitHub();
  const browser = await chromium.launch();
  const open = async (opts) => {
    const ctx = await browser.newContext({ ...opts, serviceWorkers: 'block' });
    await ctx.route('https://api.github.com/**', (r) => gh.handle(r));
    const page = await ctx.newPage();
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    await page.goto(URL);
    await page.waitForFunction(() => window.serifwriter && window.serifwriter.project());
    return page;
  };
  const mac = await open({ viewport: { width: 1280, height: 860 } });
  const phone = await open({ ...devices['iPhone 14 Plus'], deviceScaleFactor: 1 });
  const editorText = (p) => p.locator('.editor-ta').inputValue();
  const syncNow = (p) => p.evaluate(() => window.serifwriter.sync.now('all'));
  const macBook = await mac.evaluate(() => window.serifwriter.project().session.project.id);

  // ── the Mac connects through the library's dialog ──
  await mac.locator('.editor-ta').press('Control+End');
  await mac.keyboard.type('\n\nWritten on the Mac.');
  await mac.goto(URL + '#/');
  await mac.locator('.sync-chip').click();
  await mac.locator('.sync-dlg input').first().fill('https://github.com/me/books');
  await mac.locator('.sync-dlg input[type="password"]').fill('test-token');
  await mac.getByRole('button', { name: 'Connect' }).click();
  await mac.waitForFunction(() => window.serifwriter.sync.status === 'idle' && window.serifwriter.sync.lastSync > 0);
  check('sync: the Mac connects to a private repository and sends its books', gh.files.has(`books/${macBook}.json`) && JSON.parse(gh.files.get(`books/${macBook}.json`).text).sections.some((s) => s.content.includes('Written on the Mac.')));
  check('sync: the library shows it is synced', /Synced/.test(await mac.locator('.sync-chip').textContent()));

  // ── the phone connects, and the Mac's book arrives ──
  await phone.evaluate(() => window.serifwriter.sync.connect({ owner: 'me', repo: 'books', token: 'test-token' }));
  const arrived = await phone.evaluate(async (id) => { const p = await window.serifwriter.repo.getProject(id); if (!p) return ''; return (await window.serifwriter.repo.getSections(p)).map((s) => s.content).join('\n'); }, macBook);
  check('sync: the phone receives the Mac’s book with its writing', arrived.includes('Written on the Mac.'));

  // ── both open the same book; a change on the phone appears in the Mac's open editor ──
  await mac.goto(URL + `#/book/${macBook}`);
  await mac.waitForFunction((id) => window.serifwriter.project()?.session.project.id === id, macBook);
  await mac.locator('.sb-item', { hasText: 'The First Light' }).click();
  await phone.goto(URL + `#/book/${macBook}`);
  await phone.waitForFunction((id) => window.serifwriter.project()?.session.project.id === id, macBook);
  await phone.locator('.pj-contents').tap();
  await phone.locator('.sb-item', { hasText: 'The First Light' }).tap();
  await phone.locator('.editor-ta').evaluate((ta) => { ta.value += '\n\nAdded on the phone.'; ta.dispatchEvent(new Event('input')); });
  await phone.evaluate(() => window.serifwriter.sync.now('open'));
  await syncNow(mac);
  check('sync: writing on the phone appears in the book open on the Mac', (await editorText(mac)).includes('Added on the phone.'));

  // ── the same chapter written on both before either syncs: neither is lost ──
  await mac.locator('.editor-ta').evaluate((ta) => { ta.value += '\n\nMac at the same time.'; ta.dispatchEvent(new Event('input')); });
  await phone.locator('.editor-ta').evaluate((ta) => { ta.value += '\n\nPhone at the same time.'; ta.dispatchEvent(new Event('input')); });
  await mac.evaluate(() => window.serifwriter.sync.now('open'));
  await phone.evaluate(() => window.serifwriter.sync.now('open'));
  await mac.evaluate(() => window.serifwriter.sync.now('open'));
  const both = async (p) => p.evaluate(() => window.serifwriter.project().session.sections.map((s) => `${s.title}::${s.content}`).join('\n'));
  const [m, ph] = [await both(mac), await both(phone)];
  check('sync: the same chapter changed on both devices keeps both versions, on both devices',
    [m, ph].every((t) => t.includes('Mac at the same time.') && t.includes('Phone at the same time.') && t.includes('other device’s copy')), '');

  // ── deleted forever on the phone: on the Mac it moves to Recently Deleted ──
  await phone.goto(URL + '#/');
  await phone.evaluate(async (id) => { await window.serifwriter.sync.forget(id); await window.serifwriter.repo.purgeProject(id); await window.serifwriter.sync.now('all'); }, macBook);
  await mac.goto(URL + '#/');
  await syncNow(mac);
  const gonePhone = await phone.evaluate(async (id) => !(await window.serifwriter.repo.getProject(id)), macBook);
  const macCopy = await mac.evaluate(async (id) => { const p = await window.serifwriter.repo.getProject(id); return p ? (p.deletedAt ? 'in Recently Deleted' : 'still in the library') : 'missing'; }, macBook);
  check('sync: a book deleted forever on one device goes to Recently Deleted on the other', gonePhone && !gh.files.has(`books/${macBook}.json`) && macCopy === 'in Recently Deleted', `phone deleted: ${gonePhone}, in repository: ${gh.files.has(`books/${macBook}.json`)}, Mac: ${macCopy}`);
  check('sync: no uncaught page errors on either device', mac.errors.length + phone.errors.length === 0, [...mac.errors, ...phone.errors].slice(0, 3).join(' / '));
  await browser.close();
};
