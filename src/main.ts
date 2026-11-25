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
import { openProjectView, closeProjectView } from './ui/project.ts';
import { toast } from './ui/dialogs.ts';
import { projectFromSingleMarkdown } from './storage/serialize.ts';

// Boot: open the database, replay the crash journal, then route.

const app = document.getElementById('app')!;

async function route(): Promise<void> {
  const m = /^#\/book\/([\w-]+)/.exec(location.hash);
  if (m) {
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

  const recovered = await recoverJournal().catch(() => 0);
  setCustomTemplates(await repo.listCustomTemplates());
  injectTemplateCss();
  mirror.init().catch(() => undefined);

  const projects = await repo.listProjects();
  if (!projects.length && !(await repo.kvGet('seeded'))) {
    const { project, sections } = sampleProject();
    await repo.createProject(project, sections);
    await repo.kvSet('seeded', true);
    if (!location.hash) location.hash = `#/book/${project.id}`;
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
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } });
    setInterval(() => reg.update().catch(() => undefined), 60 * 60 * 1000);
  }).catch((e) => console.warn('Service worker registration failed', e));
}

void boot();
