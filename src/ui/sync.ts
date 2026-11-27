import { h, icon, button } from './dom.ts';
import { modal, showMenu, toast } from './dialogs.ts';
import { sync } from '../sync/engine.ts';
import { formatRelative } from '../util.ts';

// Sync between devices: the library's sync button and the one-time setup on each device.

/** "owner/name", or a github.com URL of the repository. */
export function parseRepo(v: string): { owner: string; repo: string } | null {
  const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(v.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

export function syncLabel(): string {
  if (!sync.configured) return '';
  if (sync.status === 'syncing') return 'Syncing…';
  if (sync.status === 'offline') return 'Offline — will sync when back online';
  if (sync.status === 'error') return `Sync paused: ${sync.lastError}`;
  return sync.lastSync ? `Synced ${formatRelative(sync.lastSync)}` : 'Sync on';
}

/** The library's sync button: set up on first use, then its status and a menu. */
export function syncChip(): HTMLElement {
  const chip = h('button', { class: 'chip sync-chip', type: 'button' });
  const paint = () => {
    const st = sync.status;
    chip.className = `chip sync-chip ${st === 'error' ? 'warn' : st === 'idle' ? 'ok' : ''}`;
    const text = !sync.configured ? 'Sync devices…' : st === 'syncing' ? 'Syncing…' : st === 'offline' ? 'Offline' : st === 'error' ? 'Sync paused' : sync.lastSync ? `Synced ${formatRelative(sync.lastSync)}` : 'Sync on';
    chip.replaceChildren(icon('sync', 15), h('span', null, text));
    chip.title = sync.configured ? `${syncLabel()} · ${sync.repoName}` : 'Keep your books in step across your devices';
  };
  paint();
  const off = sync.onChange(() => { if (!chip.isConnected) off(); else paint(); });
  const tick = setInterval(() => { if (!chip.isConnected) clearInterval(tick); else paint(); }, 30_000);
  chip.addEventListener('click', () => {
    if (!sync.configured) return void openSyncSetup();
    showMenu(chip, [
      { label: 'Sync now', icon: 'sync', onClick: () => void sync.now('all') },
      ...(sync.status === 'error' ? [{ label: sync.lastError, disabled: true }] : []),
      { label: `Syncing with ${sync.repoName}`, disabled: true },
      { separator: true, label: '' },
      { label: 'Stop syncing on this device', icon: 'close', onClick: async () => { await sync.disconnect(); toast('Sync is off on this device. Your books are still here, and in the repository.'); } },
    ]);
  });
  return chip;
}

/** One-time setup on a device: the private repository and an access token for it. */
export function openSyncSetup(): void {
  const m = modal('Sync your devices', { wide: true, className: 'sync-dlg' });
  const repoIn = h('input', { class: 'input', type: 'text', placeholder: 'yourname/serifwriter-books', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', autocomplete: 'off', enterkeyhint: 'next' }) as HTMLInputElement;
  const tokenIn = h('input', { class: 'input', type: 'password', placeholder: 'github_pat_…', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', autocomplete: 'off', enterkeyhint: 'done' }) as HTMLInputElement;
  const err = h('p', { class: 'sync-err', role: 'alert', hidden: true });
  const link = (href: string, text: string) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
  m.body.append(
    h('p', { class: 'dlg-msg' }, 'Your books are kept in a private GitHub repository of your own, and each device you connect stays in step with it: when the app opens, every half-minute while you write, and when you leave. If the same chapter changes on two devices before they sync, neither version is lost.'),
    h('ol', { class: 'sync-steps' },
      h('li', null, 'On GitHub, ', link('https://github.com/new', 'create a new repository'), ', set it to ', h('b', null, 'Private'), ', and name it — for example serifwriter-books.'),
      h('li', null, link('https://github.com/settings/personal-access-tokens/new', 'Create an access token'), ': under ', h('i', null, 'Repository access'), ' choose ', h('i', null, 'Only select repositories'), ' and pick that repository; under ', h('i', null, 'Permissions ▸ Repository permissions'), ' set ', h('b', null, 'Contents'), ' to ', h('b', null, 'Read and write'), '. Pick an expiration up to a year, then copy the token.'),
      h('li', null, 'Enter both below — and the same on each device (AirDrop or Notes is an easy way to get the token to your phone).')),
    h('label', { class: 'field' }, h('span', null, 'Repository'), repoIn),
    h('label', { class: 'field' }, h('span', null, 'Access token'), tokenIn),
    h('p', { class: 'dlg-note' }, 'The token stays on this device. It can read and change only that one repository; keep it to yourself.'),
    err,
  );
  const connect = button('Connect', { class: 'primary', onClick: async () => {
    const r = parseRepo(repoIn.value);
    const token = tokenIn.value.trim();
    const fail = (msg: string) => { err.textContent = msg; err.hidden = false; connect.disabled = false; connect.textContent = 'Connect'; };
    if (!r) return fail('Enter the repository as yourname/repository-name.');
    if (!token) return fail('Paste the access token.');
    connect.disabled = true;
    connect.textContent = 'Connecting…';
    try {
      await sync.connect({ ...r, token });
      m.close(true);
      toast(`Syncing with ${r.owner}/${r.repo}.`, { kind: 'success' });
    } catch (e: any) {
      fail(e instanceof TypeError ? 'Could not reach GitHub. Check the connection and try again.' : e?.message || String(e));
    }
  } });
  tokenIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect.click(); });
  m.footer.append(button('Cancel', { onClick: () => m.close(false) }), connect);
  setTimeout(() => repoIn.focus(), 0);
}
