// Writing statistics: habits (from the per-day log) and the prose itself.

import type { WritingStats } from './types.ts';
import { stripForCount } from './words.ts';
import { todayKey } from '../util.ts';

export const emptyStats = (): WritingStats => ({ days: {}, hours: Array(24).fill(0) });
export const dayKey = (d: Date) => todayKey(d);
export const daysAgo = (n: number, from = new Date()) => { const d = new Date(from); d.setDate(d.getDate() - n); return d; };

export interface Habits { streak: number; best: number; writingDays: number; week: number; avg: number; minutes: number; pace: number }

/** Streaks count days with words added; today doesn't break a streak until it's over. */
export function habits(st: WritingStats | undefined, now = new Date()): Habits {
  const days = st?.days || {};
  const wrote = (k: string) => (days[k]?.w ?? 0) > 0;
  let streak = 0;
  for (let i = wrote(dayKey(now)) ? 0 : 1; wrote(dayKey(daysAgo(i, now))); i++) streak++;
  let best = 0;
  let run = 0;
  let prev = '';
  for (const k of Object.keys(days).sort()) {
    if (!wrote(k)) { run = 0; continue; }
    run = prev && dayKey(daysAgo(1, new Date(`${k}T12:00`))) === prev ? run + 1 : 1;
    prev = k;
    best = Math.max(best, run);
  }
  const vals = Object.values(days);
  const writing = vals.filter((d) => d.w > 0);
  const words = writing.reduce((n, d) => n + d.w, 0);
  const minutes = vals.reduce((n, d) => n + d.m, 0);
  let week = 0;
  for (let i = 0; i < 7; i++) week += days[dayKey(daysAgo(i, now))]?.w ?? 0;
  return { streak, best, writingDays: writing.length, week, avg: writing.length ? Math.round(words / writing.length) : 0, minutes, pace: minutes > 5 ? Math.round(words / (minutes / 60)) : 0 };
}

const STOP = new Set('about above after again against also among another because been before being below between both came cannot come could does doing down during each even ever every from further have having here herself himself however into itself just like made make many more most much must myself never only other ought ours ourselves over same shall should since some such than that their theirs them themselves then there these they this those through thus under until upon very well were what when where whether which while whom whose will with within without would your yours yourself yourselves said says shall still though toward towards around away back yet'.split(' '));

export interface Prose { words: number; sentences: number; avgSentence: number; longest: number; flesch: number; variety: number; top: [string, number][] }

const syllables = (w: string) => Math.max(1, (w.toLowerCase().replace(/e$/, '').match(/[aeiouy]+/g) || []).length);

/** Sentence length, Flesch reading ease (English), vocabulary variety and the most-used words. */
export function prose(markdown: string): Prose {
  const text = stripForCount(markdown).replace(/^#+\s.*$/gm, '').replace(/^\s*(>|[-*+]|\d+[.)])\s+/gm, '').replace(/[*_`~|]/g, ' ');
  const sentences = text.split(/(?<=[.!?…])["”’)\]]*\s+|\n\s*\n/).map((s) => s.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).filter((w) => w.length);
  const all = sentences.flat();
  const n = all.length || 1;
  const freq = new Map<string, number>();
  for (const w of all) { const k = w.toLowerCase(); if (k.length > 3 && !STOP.has(k) && !/^\d+$/.test(k)) freq.set(k, (freq.get(k) || 0) + 1); }
  const avgSentence = n / (sentences.length || 1);
  const syl = all.reduce((s, w) => s + syllables(w), 0) / n;
  return {
    words: all.length,
    sentences: sentences.length,
    avgSentence: Math.round(avgSentence * 10) / 10,
    longest: Math.max(0, ...sentences.map((s) => s.length)),
    flesch: Math.round(206.835 - 1.015 * avgSentence - 84.6 * syl),
    // Variety per 1,000 words (unique/total on rolling windows), so long books aren't penalised.
    variety: Math.round(100 * windows(all.map((w) => w.toLowerCase()), 1000)),
    top: [...freq].sort((a, b) => b[1] - a[1]).slice(0, 12),
  };
}

function windows(words: string[], size: number): number {
  if (!words.length) return 0;
  if (words.length <= size) return new Set(words).size / words.length;
  let sum = 0;
  let k = 0;
  for (let i = 0; i + size <= words.length; i += size, k++) sum += new Set(words.slice(i, i + size)).size / size;
  return sum / k;
}
