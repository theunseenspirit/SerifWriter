// Small shared helpers. No dependencies.

export function uid(prefix = ''): string {
  const c = globalThis.crypto;
  const id = c && 'randomUUID' in c ? c.randomUUID().replace(/-/g, '').slice(0, 16) : Math.random().toString(36).slice(2, 18);
  return prefix + id;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Fast non-cryptographic 53-bit string hash (cyrb53), returned as base36. */
export function hashString(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** A filename-safe version of a title (keeps spaces and case; macOS-friendly). */
export function safeFilename(s: string, fallback = 'Untitled'): string {
  const out = s
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|#^\[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  return out || fallback;
}

export function slug(s: string): string {
  return (
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  );
}

export function isObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge for plain JSON-like objects. Arrays and scalars in `over` replace. */
export function deepMerge<T>(base: T, over: any): T {
  if (!isObject(over)) return (over === undefined ? base : over) as T;
  const out: any = isObject(base) ? { ...base } : {};
  for (const k of Object.keys(over)) {
    const v = over[k];
    if (v === undefined) continue;
    out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/** Returns only the keys of `value` that differ from `base` (for storing overrides). */
export function deepDiff(base: any, value: any): any {
  if (!isObject(base) || !isObject(value)) return JSON.stringify(base) === JSON.stringify(value) ? undefined : value;
  const out: any = {};
  let any = false;
  for (const k of Object.keys(value)) {
    const d = deepDiff(base[k], value[k]);
    if (d !== undefined) {
      out[k] = d;
      any = true;
    }
  }
  return any ? out : undefined;
}

export function getPath(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj: any, path: string, value: any): void {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isObject(o[keys[i]])) o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Yield to the browser so input and paint can happen (scheduler.yield when available). */
export function yieldToMain(): Promise<void> {
  const s = (globalThis as any).scheduler;
  if (s && typeof s.yield === 'function') return s.yield();
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

export function idle(timeout = 1000): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as any).requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout });
    else setTimeout(resolve, 30);
  });
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

export function numberToWords(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  n = Math.floor(n);
  if (n < 0) return 'minus ' + numberToWords(-n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' and ' + numberToWords(n % 100) : '');
  if (n < 1_000_000) return numberToWords(Math.floor(n / 1000)) + ' thousand' + (n % 1000 ? ' ' + numberToWords(n % 1000) : '');
  return String(n);
}

export function toRoman(n: number): string {
  if (n <= 0 || n >= 4000) return String(n);
  const table: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '';
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return out;
}

const capFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const titleCase = (s: string) => s.replace(/(^|[\s-])([a-z])/g, (_m, a, b) => a + b.toUpperCase()).replace(/ And /g, ' and ');

/** Expands "Chapter {Word}" style label patterns. */
export function formatLabel(pattern: string, n: number): string {
  return pattern
    .replace(/\{n\}/g, String(n))
    .replace(/\{Roman\}/g, toRoman(n))
    .replace(/\{roman\}/g, toRoman(n).toLowerCase())
    .replace(/\{Word\}/g, titleCase(numberToWords(n)))
    .replace(/\{word\}/g, numberToWords(n))
    .replace(/\{WORD\}/g, numberToWords(n).toUpperCase())
    .replace(/\{Sentence\}/g, capFirst(numberToWords(n)));
}

export function formatRelative(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr${h > 1 ? 's' : ''} ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(ts).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export const fmtNum = (n: number) => n.toLocaleString();

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function todayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Debounce with a max-wait, so continuous typing still saves every few seconds. */
export function debounce<A extends any[]>(fn: (...a: A) => void, wait: number, maxWait = Infinity) {
  let t: ReturnType<typeof setTimeout> | undefined;
  let first = 0;
  let lastArgs: A;
  const run = () => {
    t = undefined;
    first = 0;
    fn(...lastArgs);
  };
  const d = (...args: A) => {
    lastArgs = args;
    const now = Date.now();
    if (!first) first = now;
    if (t) clearTimeout(t);
    const remaining = maxWait - (now - first);
    t = setTimeout(run, Math.max(0, Math.min(wait, remaining)));
  };
  d.flush = () => { if (t) { clearTimeout(t); run(); } };
  d.cancel = () => { if (t) clearTimeout(t); t = undefined; first = 0; };
  d.pending = () => !!t;
  return d;
}
