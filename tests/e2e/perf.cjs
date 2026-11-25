// Typing-latency and pagination benchmark on a 120,000-word book with the CPU
// throttled (default 4×, roughly a 2018 MacBook Air). Run against a build:
//   npm run build && npm run preview   (in another terminal)
//   node tests/e2e/perf.cjs [throttle] [url]
const { chromium } = require('playwright');

const THROTTLE = Number(process.argv[2] || 4);
const URL = process.argv[3] || 'http://localhost:4173/';

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL);
  await page.waitForFunction(() => window.serifwriter);

  // Build a long book directly in IndexedDB.
  const projectId = await page.evaluate(async () => {
    const { repo } = window.serifwriter;
    const base = [
      'There is an hour before morning that belongs to no one. The streetlights have not yet given up, and the sky has not yet decided what color it will be. In that hour the world feels unfinished, as though it is waiting to be told what it is.',
      'I did not always see it that way. For most of my life the early hour was only a thing to be endured, a gap between the warmth of sleep and the obligations of the day. I filled it with noise.',
      'What it said was simple, and I resisted it for a long time: *you are allowed to begin again.* Not once, in some grand and final reckoning, but every morning, in small and unremarkable ways.',
      'It is a strange thing to discover that the walls of your own life were built by other hands. There is grief in it, and also a kind of relief. The grief is for the years spent living inside a shape you did not choose.',
      'I remember the first morning I understood this clearly. It was not a dramatic morning. There was no storm, no revelation in the sky. I was sitting at a kitchen table with a cup of coffee going cold.',
    ];
    const now = Date.now();
    const id = 'pperf' + now;
    const sections = [];
    const mk = (kind, title, content) => ({ id: 's' + Math.random().toString(36).slice(2, 12), projectId: id, kind, title, content, createdAt: now, updatedAt: now, words: content.split(/\s+/).filter(Boolean).length });
    sections.push(mk('title', 'Title Page', '---\ntitle: A Very Long Book\nauthor: Test Author\n---\n'));
    sections.push(mk('toc', 'Contents', ''));
    for (let c = 1; c <= 30; c++) {
      const paras = [];
      let words = 0;
      let i = c;
      while (words < 4000) {
        let p = base[i % base.length] + ' ' + base[(i * 7 + 3) % base.length];
        if (i % 23 === 0) p += `[^n${i}]`;
        paras.push(p);
        if (i % 23 === 0) paras.push(`[^n${i}]: A note on paragraph ${i}, which is here to exercise page-bottom footnotes.`);
        if (i % 17 === 0) paras.push('---');
        words += p.split(/\s+/).length;
        i++;
      }
      sections.push(mk('chapter', `Chapter Title ${c}`, paras.join('\n\n')));
    }
    const project = { id, createdAt: now, updatedAt: now, openedAt: now, deletedAt: null,
      meta: { title: 'A Very Long Book', subtitle: '', author: 'Test Author', publisher: '', year: '2026', language: 'en', extra: {} },
      order: sections.map((s) => s.id), templateId: 'classic', overrides: {}, customCss: '', lastSectionId: sections[2].id, words: 0, ui: {} };
    await repo.createProject(project, sections);
    return id;
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

  const t0 = Date.now();
  await page.evaluate((id) => { location.hash = `#/book/${id}`; }, projectId);
  await page.waitForSelector('.pv-frame');
  const firstPage = Date.now() - t0;
  await page.waitForFunction(() => { const c = window.serifwriter.project(); return c && !c.book.busy && c.book.pageRefs.length > 300; }, null, { timeout: 600000, polling: 250 });
  const fullLayout = Date.now() - t0;
  const pages = await page.evaluate(() => window.serifwriter.project().book.pageRefs.length);

  // Type in the middle of chapter 15.
  await page.locator('.sb-item', { hasText: 'Chapter Title 15' }).click();
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const ta = document.querySelector('.editor-ta');
    ta.focus();
    ta.setSelectionRange(ta.value.length >> 1, ta.value.length >> 1);
    window.__events = [];
    window.__long = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__events.push({ name: e.name, d: e.duration, p: e.processingEnd - e.processingStart, delay: e.processingStart - e.startTime }); }).observe({ type: 'event', durationThreshold: 16, buffered: false });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ type: 'longtask', buffered: false });
  });
  const text = ' Every morning the light came back, and every morning I wrote down a little of what it showed me.';
  const typeStart = Date.now();
  await page.keyboard.type(text.repeat(3), { delay: 60 });
  const typed = Date.now() - typeStart;
  const tRepag = Date.now();
  await page.waitForTimeout(800);
  await page.waitForFunction(() => !window.serifwriter.project().book.busy, null, { timeout: 120000, polling: 50 });
  const repaginate = Date.now() - tRepag;
  const stats = await page.evaluate(() => {
    const keyEvents = window.__events.filter((e) => /key|input|beforeinput/.test(e.name));
    const ds = keyEvents.map((e) => e.d).sort((a, b) => a - b);
    const q = (p) => (ds.length ? ds[Math.min(ds.length - 1, Math.floor(p * ds.length))] : 0);
    const m = performance.getEntriesByType('measure').filter((e) => e.name.startsWith('sw-')).slice(-2).map((e) => `${e.name}: ${Math.round(e.duration)}ms`);
    return { slowKeyEvents: ds.length, p50: q(0.5), p95: q(0.95), max: ds[ds.length - 1] || 0, longTasks: window.__long.length, longTaskMax: Math.max(0, ...window.__long), lastChapterLayout: m };
  });
  const chars = text.length * 3;
  console.log(JSON.stringify({ throttle: THROTTLE, pages, firstPageMs: firstPage, fullLayoutMs: fullLayout, typedChars: chars, typingMs: typed, repaginateAfterPauseMs: repaginate, ...stats, errors }, null, 1));
  await browser.close();
})();
