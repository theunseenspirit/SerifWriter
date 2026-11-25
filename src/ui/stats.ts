import type { ProjectCtx } from './project.ts';
import { h } from './dom.ts';
import { modal } from './dialogs.ts';
import { habits, prose, dayKey, daysAgo, emptyStats } from '../model/stats.ts';
import { sectionTitle } from '../model/defaults.ts';
import { escapeHtml } from '../util.ts';

// Writing stats: habits from the per-day log, and a look at the prose itself.
// Charts are small hand-written SVGs; every mark has a hover tooltip.

const num = (n: number) => Math.round(n).toLocaleString();
const compact = (n: number) => (Math.abs(n) >= 10000 ? `${Math.round(n / 1000)}K` : num(n));
/** Rounds an axis maximum up to a clean number (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × a power of ten). */
const nice = (v: number) => { const p = 10 ** Math.floor(Math.log10(Math.max(1, v))); return p * [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((f) => f * p >= v)!; };
const time = (min: number) => (min < 60 ? `${Math.round(min)} min` : `${Math.floor(min / 60)} h ${Math.round(min % 60)} min`);
const dateLabel = (d: Date, o: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }) => d.toLocaleDateString(undefined, o);

/** A column with a 4px rounded data end, square at the baseline (works for negative values too). */
function column(x: number, w: number, y0: number, y1: number): string {
  if (Math.abs(y1 - y0) < 0.5) return '';
  const s = y1 < y0 ? 1 : -1;
  const r = Math.min(4, Math.abs(y1 - y0), w / 2);
  return `<path class="st-mark" d="M${x},${y0}V${y1 + s * r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + s * r}V${y0}Z"/>`;
}

function columns(W: number, vals: number[], tips: string[], labels: string[], label: string, goal = 0): string {
  const H = 180, L = 44, T = 12, B = 24, R = goal ? 64 : 0;
  W -= R;
  const hi = nice(Math.max(1, ...vals, goal));
  const lo = Math.min(...vals, 0) < 0 ? -nice(-Math.min(...vals)) : 0;
  const y = (v: number) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const slot = (W - L) / vals.length;
  const bw = Math.min(24, slot - 2);
  let g = '';
  for (const t of new Set([lo, 0, hi / 2, hi])) g += `<line class="st-grid" x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text class="st-tick" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`;
  vals.forEach((v, i) => {
    const x = L + i * slot + (slot - bw) / 2;
    g += column(x, bw, y(0), y(v));
    if (labels[i]) g += `<text class="st-tick" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${labels[i]}</text>`;
    g += `<rect class="st-hit" x="${L + i * slot}" y="${T}" width="${slot}" height="${H - T - B}" data-tip="${escapeHtml(tips[i])}"/>`;
  });
  if (goal) g += `<line class="st-goal" x1="${L}" x2="${W + 4}" y1="${y(goal)}" y2="${y(goal)}"/><text class="st-tick" x="${W + 8}" y="${y(goal) + 4}">goal ${compact(goal)}</text>`;
  return `<svg width="${W + R}" height="${H}" role="img" aria-label="${escapeHtml(label)}">${g}</svg>`;
}

/** Book length over time: a 2px line, a 10% wash, an end dot with a surface ring and its value. */
function growth(W: number, points: { d: Date; t: number }[]): string {
  const H = 160, L = 44, T = 14, B = 22, R = 56;
  const t0 = +points[0].d, t1 = Math.max(+points.at(-1)!.d, t0 + 864e5);
  const hi = nice(Math.max(1, ...points.map((p) => p.t)));
  const x = (d: Date) => L + ((+d - t0) / (t1 - t0)) * (W - L - R);
  const y = (v: number) => T + ((hi - v) / hi) * (H - T - B);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.d).toFixed(1)},${y(p.t).toFixed(1)}`).join('');
  const end = points.at(-1)!;
  let g = '';
  for (const t of [0, hi / 2, hi]) g += `<line class="st-grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="st-tick" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`;
  g += `<path class="st-wash" d="${line}L${x(end.d)},${y(0)}L${x(points[0].d)},${y(0)}Z"/><path class="st-line" d="${line}"/>`;
  g += `<circle class="st-dot" cx="${x(end.d)}" cy="${y(end.t)}" r="4"/><text class="st-val" x="${x(end.d) + 8}" y="${y(end.t) + 4}">${compact(end.t)}</text>`;
  for (const [i, lbl] of [[0, points[0].d], [1, end.d]] as const) g += `<text class="st-tick" x="${x(lbl)}" y="${H - 6}" text-anchor="${i ? 'end' : 'start'}">${dateLabel(lbl, { day: 'numeric', month: 'short' })}</text>`;
  const step = (W - L - R) / Math.max(1, points.length);
  for (const p of points) g += `<rect class="st-hit" x="${x(p.d) - step / 2}" y="${T}" width="${step}" height="${H - T - B}" data-tip="${escapeHtml(`${dateLabel(p.d)}: ${num(p.t)} words`)}"/>`;
  return `<svg width="${W}" height="${H}" role="img" aria-label="Book length over time">${g}</svg>`;
}

/** Twenty-six weeks of writing days; one hue, darker for more words. */
function calendar(days: Record<string, { w: number; m: number }>): string {
  const C = 13, G = 3, L = 30, T = 18, WEEKS = 26;
  const start = daysAgo(7 * (WEEKS - 1) + ((new Date().getDay() + 6) % 7));
  const pos = Object.values(days).map((d) => d.w).filter((w) => w > 0).sort((a, b) => a - b);
  const q = [0.25, 0.5, 0.75].map((f) => pos[Math.floor(f * (pos.length - 1))] ?? 0);
  const level = (w: number) => (w <= 0 ? 0 : 1 + q.filter((t) => w > t).length);
  let g = '';
  let month = -1;
  for (let i = 0; i < WEEKS * 7; i++) {
    const d = daysAgo(-i, start);
    if (d > new Date()) break;
    const wk = Math.floor(i / 7);
    const dow = i % 7;
    if (dow === 0 && d.getMonth() !== month) { month = d.getMonth(); g += `<text class="st-tick" x="${L + wk * (C + G)}" y="10">${dateLabel(d, { month: 'short' })}</text>`; }
    const v = days[dayKey(d)];
    g += `<rect class="st-cell l${level(v?.w ?? 0)}" x="${L + wk * (C + G)}" y="${T + dow * (C + G)}" width="${C}" height="${C}" rx="2" data-tip="${escapeHtml(`${dateLabel(d)}: ${v ? `${num(v.w)} words, ${time(v.m)}` : 'no writing'}`)}"/>`;
  }
  ['Mon', '', 'Wed', '', 'Fri', '', ''].forEach((t, i) => { if (t) g += `<text class="st-tick" x="0" y="${T + i * (C + G) + 10}">${t}</text>`; });
  const W = L + WEEKS * (C + G);
  const H = T + 7 * (C + G) + 18;
  g += `<text class="st-tick" x="${W - 5 * (C + G) - 34}" y="${H - 4}">Less</text>`;
  for (let l = 0; l < 5; l++) g += `<rect class="st-cell l${l}" x="${W - (5 - l) * (C + G)}" y="${H - 14}" width="${C - 3}" height="${C - 3}" rx="2"/>`;
  return `<svg width="${W + 30}" height="${H}" role="img" aria-label="Writing days over the last six months"><text class="st-tick" x="${W + 2}" y="${H - 4}">More</text>${g}</svg>`;
}

export function openStats(ctx: ProjectCtx): void {
  const { session } = ctx;
  const m = modal('Writing stats', { className: 'huge stats-dlg' });
  const tip = h('div', { class: 'st-tip', role: 'tooltip', hidden: true });
  m.dialog.appendChild(tip);
  for (const ev of ['scroll', 'pointerleave'] as const) m.body.addEventListener(ev, () => { tip.hidden = true; }, { passive: true });
  m.dialog.addEventListener('pointermove', (e) => {
    const t = (e.target as Element).closest?.('[data-tip]') as HTMLElement | null;
    tip.hidden = !t;
    if (!t) return;
    tip.textContent = t.dataset.tip!;
    const r = m.dialog.getBoundingClientRect();
    tip.style.left = `${Math.min(e.clientX - r.left + 12, r.width - tip.offsetWidth - 8)}px`;
    tip.style.top = `${e.clientY - r.top - 34}px`;
  });

  const paint = () => {
    const p = session.project;
    const st = p.stats || emptyStats();
    const hb = habits(st);
    const goal = st.dailyGoal || 0;
    const today = st.days[dayKey(new Date())];
    const book = session.totalWords;
    const body = session.sections.filter((s) => s.kind === 'chapter' || s.kind === 'section' || s.kind === 'about' || s.kind === 'part');
    const pr = prose(body.map((s) => s.content).join('\n\n'));

    const tile = (label: string, value: string, sub = '', extra = '') => `<div class="st-tile"><div class="st-label">${label}</div><div class="st-num">${value}</div>${sub ? `<div class="st-sub">${sub}</div>` : ''}${extra}</div>`;
    const meter = p.goal ? `<div class="st-meter" role="meter" aria-valuenow="${book}" aria-valuemax="${p.goal}"><span style="width:${Math.min(100, (100 * book) / p.goal)}%"></span></div>` : '';

    const last30 = Array.from({ length: 30 }, (_, i) => daysAgo(29 - i));
    const daily = last30.map((d) => st.days[dayKey(d)]);
    const met = goal ? daily.filter((d) => (d?.w ?? 0) >= goal).length : 0;
    const growthPts = Object.keys(st.days).sort().map((k) => ({ d: new Date(`${k}T12:00`), t: st.days[k].t }));
    const maxCh = Math.max(1, ...body.map((s) => s.words));
    const hours = st.hours.map((x) => x || 0);
    const hourName = (i: number) => `${i % 12 || 12}${i < 12 ? 'am' : 'pm'}`;

    const html = `
      <div class="st-tiles">
        ${tile('Today', `${today && today.w > 0 ? '+' : ''}${num(today?.w ?? 0)}`, goal ? `${today && today.w >= goal ? 'goal met' : `of ${num(goal)} goal`} · ${time(today?.m ?? 0)}` : `words · ${time(today?.m ?? 0)}`)}
        ${tile('Streak', `${hb.streak} day${hb.streak === 1 ? '' : 's'}`, `best ${hb.best}`)}
        ${tile('Last 7 days', num(hb.week), 'words')}
        ${tile('Average writing day', num(hb.avg), `words · ${hb.writingDays} days written`)}
        ${tile('Time writing', time(hb.minutes), hb.pace ? `${num(hb.pace)} words an hour` : 'recorded as you type')}
        ${tile('Book', num(book), p.goal ? `of ${num(p.goal)} · ${Math.round((100 * book) / p.goal)}%` : 'words', meter)}
      </div>
      ${Object.keys(st.days).length ? '' : '<p class="st-note">Your writing habits build up here as you write — words added each day, time spent and when you write. Everything stays on this computer.</p>'}
      <section class="st-card st-wide"><h3>Words written per day <small>last 30 days${goal ? ` · goal met on ${met}` : ''}</small></h3>
        <div class="st-chart" data-k="daily"></div>
        <details><summary>Show as a table</summary><table class="st-table"><tr><th>Day</th><th>Words</th><th>Time</th></tr>${last30.map((d, i) => `<tr><td>${dateLabel(d)}</td><td>${num(daily[i]?.w ?? 0)}</td><td>${time(daily[i]?.m ?? 0)}</td></tr>`).reverse().join('')}</table></details>
      </section>
      <section class="st-card"><h3>Writing days <small>last six months</small></h3><div class="st-chart" data-k="calendar"></div></section>
      <section class="st-card"><h3>When you write <small>minutes by hour of day</small></h3>
        <div class="st-chart" data-k="hours"></div></section>
      <section class="st-card st-wide"><h3>Book length</h3>${growthPts.length > 1 ? '<div class="st-chart" data-k="growth"></div>' : '<p class="st-note">Appears after your second day of writing.</p>'}</section>
      <section class="st-card"><h3>Chapter lengths <small>words</small></h3><div class="st-bars">${body.map((s) => `<div class="st-row" data-tip="${escapeHtml(`${sectionTitle(s)}: ${num(s.words)} words`)}"><span class="st-name">${escapeHtml(sectionTitle(s))}</span><span class="st-bar"><span style="width:${(100 * s.words) / maxCh}%"></span></span><span class="st-v">${compact(s.words)}</span></div>`).join('')}</div></section>
      <section class="st-card"><h3>The prose <small>chapters and sections</small></h3>
        <div class="st-tiles small">
          ${tile('Average sentence', `${pr.avgSentence}`, `words · longest ${pr.longest}`)}
          ${tile('Reading ease', `${pr.flesch}`, `Flesch · ${pr.flesch >= 60 ? 'plain' : pr.flesch >= 30 ? 'academic' : 'dense'}`)}
          ${tile('Vocabulary', `${pr.variety}%`, 'different words per 1,000')}
        </div>
        <h4>Most used words</h4><ol class="st-words">${pr.top.map(([w, n]) => `<li><span>${escapeHtml(w)}</span><span>${n}</span></li>`).join('')}</ol>
      </section>`;
    view.innerHTML = html;
    charts = {
      daily: (W) => columns(W, daily.map((d) => d?.w ?? 0), last30.map((d, i) => `${dateLabel(d)}: ${num(daily[i]?.w ?? 0)} words, ${time(daily[i]?.m ?? 0)}`), last30.map((d, i) => (i % 7 === 2 ? dateLabel(d, { day: 'numeric', month: 'short' }) : '')), 'Words written per day', goal),
      hours: (W) => columns(W, hours, hours.map((v, i) => `${hourName(i)}–${hourName((i + 1) % 24)}: ${time(v)}`), hours.map((_, i) => (i % 6 === 0 ? hourName(i) : '')), 'Minutes written by hour of day'),
      growth: (W) => growth(W, growthPts),
      calendar: () => calendar(st.days),
    };
    draw();
  };
  // Charts are drawn at their real width (crisp 11px labels at any size) and redrawn on resize.
  let charts: Record<string, (W: number) => string> = {};
  const draw = () => { for (const el of Array.from(view.querySelectorAll<HTMLElement>('.st-chart'))) el.innerHTML = charts[el.dataset.k!]?.(Math.max(280, el.clientWidth)) || ''; };
  let lastW = 0;

  const numInput = (label: string, value: number | undefined, set: (v: number | undefined) => void) => {
    const i = h('input', { class: 'input', type: 'number', min: 0, step: 50, placeholder: 'none', value: value || '' }) as HTMLInputElement;
    i.addEventListener('change', () => { set(Number(i.value) > 0 ? Math.round(Number(i.value)) : undefined); session.markProjectDirty(); paint(); });
    return h('label', { class: 'st-goal-in' }, h('span', null, label), i);
  };
  const view = h('div', { class: 'st-grid' });
  new ResizeObserver(() => { if (view.clientWidth !== lastW) { lastW = view.clientWidth; draw(); } }).observe(view);
  m.body.append(
    h('div', { class: 'st-goals' },
      numInput('Daily goal (words)', session.project.stats?.dailyGoal, (v) => { (session.project.stats ??= emptyStats()).dailyGoal = v; }),
      numInput('Book goal (words)', session.project.goal, (v) => { session.project.goal = v; })),
    view);
  paint();
}
