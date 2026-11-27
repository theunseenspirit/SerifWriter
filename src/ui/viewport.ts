// Phones: which layout applies, and where the on-screen keyboard is.
//
// The phone layout (one pane at a time) is used on narrow screens, and on a
// touch screen too short for three panes (a phone turned sideways). Keep this
// query in step with the phone block in styles/app.css.

export const PHONE_QUERY = '(max-width: 760px), (max-height: 500px) and (pointer: coarse)';
const phoneMQ = typeof matchMedia === 'function' ? matchMedia(PHONE_QUERY) : null;

export const isPhone = (): boolean => !!phoneMQ?.matches;

export function onPhoneChange(fn: (phone: boolean) => void): () => void {
  if (!phoneMQ) return () => undefined;
  const cb = () => fn(phoneMQ.matches);
  phoneMQ.addEventListener('change', cb);
  return () => phoneMQ.removeEventListener('change', cb);
}

/** True on an iPhone or iPad (iPadOS reports itself as a Mac with a touch screen). */
export const isIOS = (): boolean =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Opened from the Home Screen (or installed), rather than in a browser tab. */
export const isStandalone = (): boolean =>
  (navigator as any).standalone === true || matchMedia('(display-mode: standalone)').matches;

/**
 * On an iPhone, Safari and the Home Screen app colour the status bar from
 * theme-color: match it to the app's own background, light or dark. (Left
 * alone elsewhere, where it colours an installed app's title bar.)
 */
export function syncThemeColor(): void {
  if (!isIOS()) return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) requestAnimationFrame(() => { meta.content = getComputedStyle(document.body).backgroundColor; });
}

/**
 * Keeps CSS variables in step with the visual viewport, which on iOS shrinks
 * when the keyboard opens while the layout viewport does not:
 *   --vvh     visible height     --vv-top  how far iOS has panned the page
 *   --kb      keyboard height    html.kb-open while the keyboard is up
 * The phone layout pins the app to exactly the visible area, so the writing
 * keys sit just above the keyboard and nothing hides behind it.
 */
export function trackViewport(): void {
  const vv = window.visualViewport;
  const root = document.documentElement;
  const fit = () => {
    if (vv && vv.scale > 1.01) return; // pinch-zoomed: leave the layout alone
    const h = vv ? vv.height : innerHeight;
    const top = vv ? vv.offsetTop : 0;
    const kb = Math.max(0, innerHeight - h - top);
    root.style.setProperty('--vvh', `${Math.round(h)}px`);
    root.style.setProperty('--vv-top', `${Math.round(top)}px`);
    root.style.setProperty('--kb', `${Math.round(kb)}px`);
    root.classList.toggle('kb-open', kb > 120);
  };
  fit();
  vv?.addEventListener('resize', fit);
  vv?.addEventListener('scroll', fit);
  addEventListener('resize', fit);
}
