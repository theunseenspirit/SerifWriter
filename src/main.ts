import './styles/app.css';
import './styles/book.css';
import { openDB } from './db/idb.ts';
import * as repo from './db/repo.ts';
import { injectFontFaces } from './typeset/fonts.ts';
import { recoverJournal } from './storage/session.ts';
import { setCustomTemplates, injectTemplateCss } from './templates/index.ts';
import { mirror } from './storage/mirror.ts';
import { sampleProject } from './model/defaults.ts';
import { renderHome } from './ui/home.ts';
import { openProjectView, closeProjectView, getProjectCtx } from './ui/project.ts';
import { toast } from './ui/dialogs.ts';
import { projectFromSingleMarkdown } from './storage/serialize.ts';
import { trackViewport, syncThemeColor } from './ui/viewport.ts';

// Boot: open the database, replay the crash journal, then route.

const app = document.getElementById('app')!;

// Route changes are serialised so two can never open a book at the same time.
let routing: Promise<void> = Promise.resolve();
function route(): Promise<void> {
  routing = routing.then(doRoute, doRoute);
  return routing;
}

async function doRoute(): Promise<void> {
  const m = /^#\/book\/([\w-]+)/.exec(location.hash);
  if (m) {
    if (getProjectCtx()?.session.project.id === m[1]) return; // already open
    const p = await repo.getProject(m[1]);
    if (p && !p.deletedAt) {
      await repo.kvSet('lastRoute', location.hash);
      await openProjectView(app, p);
      return;
    }
  }
  await closeProjectView();
  await repo.kvSet('lastRoute', '#/');
  await renderHome(app);
}

async function boot(): Promise<void> {
  trackViewport();
  injectFontFaces();
  try {
    await openDB();
  } catch (e) {
    app.innerHTML = '<div class="fatal"><h1>Storage is unavailable</h1><p>SerifWriter keeps your writing in this browser’s database (IndexedDB), which is blocked here. Private windows and some privacy settings disable it.</p></div>';
    document.getElementById('boot')?.remove();
    throw e;
  }
  // Ask the browser to keep our data even under storage pressure.
  navigator.storage?.persist?.().catch(() => undefined);

  const theme = await repo.kvGet<string>('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  syncThemeColor();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeColor);

  const recovered = await recoverJournal().catch(() => 0);
  setCustomTemplates(await repo.listCustomTemplates());
  injectTemplateCss();
  mirror.init().catch(() => undefined);

  const projects = await repo.listProjects();
  if (!projects.length && !(await repo.kvGet('seeded'))) {
    const { project, sections } = sampleProject();
    await repo.createProject(project, sections);
    await repo.kvSet('seeded', true);
    if (!location.hash) history.replaceState(null, '', `#/book/${project.id}`);
  } else if (!location.hash) {
    // Reopen right where you left off.
    const last = await repo.kvGet<string>('lastRoute');
    if (last && last.startsWith('#/book/')) history.replaceState(null, '', last);
  }

  window.addEventListener('hashchange', () => void route());
  await route();
  document.getElementById('boot')?.remove();
  if (recovered) toast(`Recovered unsaved writing in ${recovered} section${recovered > 1 ? 's' : ''}.`, { kind: 'success', timeout: 6000 });

  handleLaunchFiles();
  registerServiceWorker();
  // Console access for power users and tests (everything stays local).
  (window as any).serifwriter = { repo, mirror, project: getProjectCtx };
}

/** "Open with SerifWriter" for .md files when installed (Chrome file handlers). */
function handleLaunchFiles(): void {
  const lq = (window as any).launchQueue;
  if (!lq) return;
  lq.setConsumer(async (params: any) => {
    for (const handle of params.files || []) {
      const file: File = await handle.getFile();
      const { project, sections } = projectFromSingleMarkdown(await file.text(), file.name);
      await repo.createProject(project, sections);
      location.hash = `#/book/${project.id}`;
    }
  });
}

function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const offer = (w: ServiceWorker) => {
      toast('A new version of SerifWriter is ready.', {
        action: 'Restart',
        timeout: 0,
        onAction: () => { w.postMessage('skipWaiting'); },
      });
    };
    // An update that was waiting when the app opens is applied straight away, before any writing.
    if (reg.waiting && navigator.serviceWorker.controller) reg.waiting.postMessage('skipWaiting');
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
    // Reload only when an update replaces a running worker — never on first install, mid-sentence.
    let reloading = !navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } else reloading = false; });
    // Look for a new version every 15 minutes and whenever you come back to the app.
    const check = () => reg.update().catch(() => undefined);
    setInterval(check, 15 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  }).catch((e) => console.warn('Service worker registration failed', e));
}

void boot();
