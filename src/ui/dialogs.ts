import { h, icon } from './dom.ts';
import { isPhone } from './viewport.ts';

// Modal dialogs (native <dialog>: focus trap and Esc for free), popover menus and toasts.

export interface ModalHandle { dialog: HTMLDialogElement; body: HTMLElement; footer: HTMLElement; close: (v?: any) => void; result: Promise<any> }

export function modal(title: string, opts: { wide?: boolean; className?: string; onClose?: () => void } = {}): ModalHandle {
  const body = h('div', { class: 'dlg-body' });
  const footer = h('div', { class: 'dlg-foot' });
  const closeBtn = h('button', { class: 'btn icon dlg-x', type: 'button', 'aria-label': 'Close' }, icon('close'));
  const dialog = h('dialog', { class: `dlg ${opts.wide ? 'wide' : ''} ${opts.className || ''}` },
    h('div', { class: 'dlg-head' }, h('h2', null, title), closeBtn), body, footer) as HTMLDialogElement;
  let resolve!: (v: any) => void;
  const result = new Promise<any>((r) => (resolve = r));
  let value: any;
  const close = (v?: any) => { value = v; if (dialog.open) dialog.close(); };
  dialog.addEventListener('close', () => { resolve(value); opts.onClose?.(); setTimeout(() => dialog.remove(), 0); });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  closeBtn.addEventListener('click', () => close());
  sheetDrag(dialog, dialog.querySelector('.dlg-head') as HTMLElement, () => close());
  document.body.appendChild(dialog);
  dialog.showModal();
  return { dialog, body, footer, close, result };
}

/** On a phone, dialogs and the Design panel are sheets from the bottom: drag one down by its top edge to dismiss it. */
export function sheetDrag(dialog: HTMLElement, head: HTMLElement, dismiss: () => void): void {
  let start: number | null = null;
  let dy = 0;
  head.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !isPhone() || (e.target as HTMLElement).closest('button')) return;
    start = e.clientY;
    dy = 0;
    try { head.setPointerCapture(e.pointerId); } catch { /* no live pointer to capture */ }
    dialog.classList.add('dragging');
  });
  head.addEventListener('pointermove', (e) => {
    if (start === null) return;
    dy = Math.max(0, e.clientY - start);
    dialog.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (start === null) return;
    start = null;
    dialog.classList.remove('dragging');
    if (dy > 90) dismiss();
    else dialog.style.transform = '';
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);
}

export function confirmDialog(title: string, message: string, opts: { ok?: string; danger?: boolean; cancel?: string } = {}): Promise<boolean> {
  const m = modal(title);
  m.body.appendChild(h('p', { class: 'dlg-msg' }, message));
  const ok = h('button', { class: `btn ${opts.danger ? 'danger' : 'primary'}`, type: 'button' }, opts.ok || 'OK');
  ok.addEventListener('click', () => m.close(true));
  const cancel = h('button', { class: 'btn', type: 'button' }, opts.cancel || 'Cancel');
  cancel.addEventListener('click', () => m.close(false));
  m.footer.append(cancel, ok);
  setTimeout(() => ok.focus(), 0);
  return m.result.then((v) => v === true);
}

export function promptDialog(title: string, label: string, value = '', opts: { ok?: string; multiline?: boolean; placeholder?: string } = {}): Promise<string | null> {
  const m = modal(title);
  const input = opts.multiline
    ? h('textarea', { class: 'input', rows: 4, placeholder: opts.placeholder || '' }) as HTMLTextAreaElement
    : h('input', { class: 'input', type: 'text', placeholder: opts.placeholder || '', autocapitalize: 'words', enterkeyhint: 'done', autocomplete: 'off' }) as HTMLInputElement;
  input.value = value;
  const form = h('form', { class: 'dlg-form' }, h('label', { class: 'field' }, h('span', null, label), input));
  form.addEventListener('submit', (e) => { e.preventDefault(); m.close(input.value); });
  m.body.appendChild(form);
  const ok = h('button', { class: 'btn primary', type: 'button' }, opts.ok || 'OK');
  ok.addEventListener('click', () => m.close(input.value));
  const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
  cancel.addEventListener('click', () => m.close(null));
  m.footer.append(cancel, ok);
  setTimeout(() => { input.focus(); (input as HTMLInputElement).select?.(); }, 0);
  return m.result.then((v) => (typeof v === 'string' ? v : null));
}

export function choiceDialog<T extends string>(title: string, message: string, choices: { value: T; label: string; primary?: boolean; danger?: boolean }[]): Promise<T | null> {
  const m = modal(title);
  m.body.appendChild(h('p', { class: 'dlg-msg' }, message));
  const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
  cancel.addEventListener('click', () => m.close(null));
  m.footer.appendChild(cancel);
  for (const c of choices) {
    const b = h('button', { class: `btn ${c.primary ? 'primary' : ''} ${c.danger ? 'danger' : ''}`, type: 'button' }, c.label);
    b.addEventListener('click', () => m.close(c.value));
    m.footer.appendChild(b);
  }
  return m.result.then((v) => v ?? null);
}

// ───────── Popover menus ─────────

export interface MenuItem { label: string; icon?: string; onClick?: () => void; danger?: boolean; disabled?: boolean; hint?: string; separator?: boolean; checked?: boolean }

let openMenu: HTMLElement | null = null;
export function closeMenu(): void { openMenu?.remove(); openMenu = null; }

export function showMenu(anchor: HTMLElement | { x: number; y: number }, items: MenuItem[]): void {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it.separator) { menu.appendChild(h('div', { class: 'menu-sep' })); continue; }
    const b = h('button', { class: `menu-item ${it.danger ? 'danger' : ''}`, type: 'button', role: 'menuitem', disabled: it.disabled },
      it.icon ? icon(it.icon, 16) : h('span', { class: 'menu-ico-space' }, it.checked ? '✓' : ''),
      h('span', { class: 'menu-label' }, it.label),
      it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null);
    b.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); it.onClick?.(); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let x = r.left;
  let y = r.bottom + 4;
  if (x + mw > innerWidth - 8) x = Math.max(8, r.right - mw);
  if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 4);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  openMenu = menu;
  (menu.querySelector('.menu-item:not([disabled])') as HTMLElement | null)?.focus();
  const away = (e: Event) => {
    if (openMenu && !openMenu.contains(e.target as Node)) { closeMenu(); cleanup(); }
  };
  const key = (e: KeyboardEvent) => {
    if (!openMenu) return cleanup();
    const items = Array.from(openMenu.querySelectorAll<HTMLElement>('.menu-item:not([disabled])'));
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { closeMenu(); cleanup(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  };
  const cleanup = () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true); };
  setTimeout(() => { document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', key, true); }, 0);
}

// ───────── Toasts ─────────

let toastHost: HTMLElement | null = null;
export function toast(message: string, opts: { action?: string; onAction?: () => void; timeout?: number; kind?: 'info' | 'error' | 'success' } = {}): () => void {
  if (!toastHost) { toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(toastHost); }
  const t = h('div', { class: `toast ${opts.kind || 'info'}` }, h('span', null, message));
  const dismiss = () => { t.classList.add('out'); setTimeout(() => t.remove(), 200); };
  if (opts.action) {
    const b = h('button', { class: 'btn small', type: 'button' }, opts.action);
    b.addEventListener('click', () => { dismiss(); opts.onAction?.(); });
    t.appendChild(b);
  }
  toastHost.appendChild(t);
  if (opts.timeout !== 0) setTimeout(dismiss, opts.timeout ?? 3200);
  return dismiss;
}
