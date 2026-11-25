import type { OrnamentSetId } from '../model/types.ts';

// Original vector ornaments. Every piece uses currentColor, so it takes the
// template's accent colour. Corners are drawn for the top-left position and
// mirrored with CSS for the other three.

export interface OrnamentSet {
  name: string;
  corner: string; // title-page corner flourish
  rule: string; // wide rule under the book title
  chapter: string; // short rule under chapter titles
  fleuron: string; // small ornament (title page foot, dedication)
  scene: string; // scene break
  headpiece: string; // optional band above chapter openings
}

const svg = (vb: string, body: string, cls = '') =>
  `<svg class="orn ${cls}" viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${body}</svg>`;

// Tapering hairline from x1 to x2 at height y with max half-thickness t.
const taper = (x1: number, x2: number, y: number, t: number) => {
  const m = (x1 + x2) / 2;
  return `<path d="M${x1} ${y} Q${m} ${y - t} ${x2} ${y} Q${m} ${y + t} ${x1} ${y}Z"/>`;
};
const lozenge = (cx: number, cy: number, rx: number, ry: number) => `<path d="M${cx} ${cy - ry}L${cx + rx} ${cy}L${cx} ${cy + ry}L${cx - rx} ${cy}Z"/>`;
const dot = (cx: number, cy: number, r: number) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`;

// ───────── Classic ─────────
const classicLeaf = (x: number, y: number, s: number, flip = 1) =>
  `<path d="M${x} ${y}c${4 * s * flip} ${-5 * s} ${11 * s * flip} ${-6 * s} ${16 * s * flip} ${-3 * s}c${-4 * s * flip} ${4 * s} ${-11 * s * flip} ${5 * s} ${-16 * s * flip} ${3 * s}z"/>`;

const classic: OrnamentSet = {
  name: 'Classic fleurons',
  corner: svg('0 0 60 60',
    `<g fill="none" stroke="currentColor" stroke-linecap="round">
      <path d="M4 56V10Q4 4 10 4H56" stroke-width="1.3"/>
      <path d="M12 46C12 24 24 12 46 12" stroke-width="1.6"/>
      <path d="M46 12c6 0 8 5 5 8s-7 1-6-2" stroke-width="1.3"/>
      <path d="M12 46c0 6 5 8 8 5s1-7-2-6" stroke-width="1.3"/>
      <path d="M20 30C21 25 25 21 30 20" stroke-width="1"/>
    </g>
    <g fill="currentColor">${lozenge(17, 17, 4, 4)}${dot(26, 26, 1.6)}${dot(56, 4, 1.4)}${dot(4, 56, 1.4)}</g>`, 'orn-corner'),
  rule: svg('0 0 240 24',
    `<g fill="currentColor">
      ${taper(2, 92, 12, 1.2)}${taper(148, 238, 12, 1.2)}
      ${lozenge(120, 12, 7, 8)}
      ${dot(103, 12, 1.8)}${dot(137, 12, 1.8)}
    </g>
    <g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
      <path d="M92 12c4-7 12-7 13-2s-4 6-6 3"/><path d="M92 12c4 7 12 7 13 2s-4-6-6-3"/>
      <path d="M148 12c-4-7-12-7-13-2s4 6 6 3"/><path d="M148 12c-4 7-12 7-13 2s4-6 6-3"/>
    </g>`, 'orn-rule'),
  chapter: svg('0 0 140 14',
    `<g fill="currentColor">${taper(4, 56, 7, 0.9)}${dot(61.5, 7, 1.5)}${lozenge(70, 7, 4.5, 5)}${dot(78.5, 7, 1.5)}${taper(84, 136, 7, 0.9)}</g>`, 'orn-chapter'),
  fleuron: svg('0 0 40 40',
    `<g fill="currentColor">
      <path d="M20 3C26.5 10 27 18 20 25C13 18 13.5 10 20 3Z"/>
      ${classicLeaf(19, 27, 1, -1)}${classicLeaf(21, 27, 1, 1)}
      ${dot(20, 33.5, 1.8)}
    </g>
    <path d="M20 25v6" stroke="currentColor" stroke-width="1.2" fill="none"/>`, 'orn-fleuron'),
  scene: svg('0 0 60 16',
    `<g fill="currentColor">${dot(14, 8, 1.6)}${lozenge(30, 8, 4.5, 5.5)}${dot(46, 8, 1.6)}</g>
     <g fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"><path d="M20 8c2-3 5-3 5 0"/><path d="M40 8c-2-3-5-3-5 0"/></g>`, 'orn-scene'),
  headpiece: '',
};

// ───────── Victorian ─────────
const scrollPair = (cx: number, cy: number, w: number, dir: 1 | -1) => {
  const x = cx + dir * 4;
  return `<path d="M${x} ${cy}c${dir * w * 0.25} -9 ${dir * w * 0.7} -9 ${dir * w * 0.7} -2c0 4 ${-dir * 5} 5 ${-dir * 6} 1"/>
          <path d="M${x} ${cy}c${dir * w * 0.25} 9 ${dir * w * 0.7} 9 ${dir * w * 0.7} 2c0 -4 ${-dir * 5} -5 ${-dir * 6} -1"/>`;
};
const rosette = (cx: number, cy: number, r: number) =>
  `<g fill="currentColor">${dot(cx, cy, r * 0.42)}${[0, 45, 90, 135, 180, 225, 270, 315]
    .map((a) => `<ellipse cx="${cx}" cy="${cy - r * 0.78}" rx="${r * 0.2}" ry="${r * 0.32}" transform="rotate(${a} ${cx} ${cy})"/>`)
    .join('')}</g>`;

const victorian: OrnamentSet = {
  name: 'Victorian scrollwork',
  corner: svg('0 0 70 70',
    `<g fill="none" stroke="currentColor" stroke-linecap="round">
      <path d="M3 67V3H67" stroke-width="1.6"/><path d="M8 67V8H67" stroke-width=".6"/>
      <path d="M14 52C14 28 28 14 52 14" stroke-width="1.5"/>
      <path d="M52 14c8 0 10 7 6 10s-8 0-7-3" stroke-width="1.2"/>
      <path d="M14 52c0 8 7 10 10 6s0-8-3-7" stroke-width="1.2"/>
      <path d="M22 38c0-9 7-16 16-16" stroke-width="1"/>
      <path d="M38 22c4-3 9-1 9 3" stroke-width="1"/><path d="M22 38c-3 4-1 9 3 9" stroke-width="1"/>
    </g>${rosette(16, 16, 6)}`, 'orn-corner'),
  rule: svg('0 0 260 30',
    `<g fill="currentColor">${taper(2, 74, 15, 1)}${taper(186, 258, 15, 1)}${dot(80, 15, 1.8)}${dot(180, 15, 1.8)}</g>
     <g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">${scrollPair(130, 15, 44, -1)}${scrollPair(130, 15, 44, 1)}</g>
     ${rosette(130, 15, 7)}`, 'orn-rule'),
  chapter: svg('0 0 160 20',
    `<g fill="currentColor">${taper(4, 52, 10, .9)}${taper(108, 156, 10, .9)}</g>
     <g fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round">${scrollPair(80, 10, 26, -1)}${scrollPair(80, 10, 26, 1)}</g>
     ${rosette(80, 10, 4.5)}`, 'orn-chapter'),
  fleuron: svg('0 0 40 40', `${rosette(20, 20, 13)}`, 'orn-fleuron'),
  scene: svg('0 0 60 20',
    `<g fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round">${scrollPair(30, 10, 22, -1)}${scrollPair(30, 10, 22, 1)}</g>${rosette(30, 10, 3.6)}`, 'orn-scene'),
  headpiece: svg('0 0 300 26',
    `<g fill="currentColor"><rect x="0" y="2" width="300" height="2.2"/><rect x="0" y="6.4" width="300" height=".7"/><rect x="0" y="22" width="300" height="2.2"/><rect x="0" y="19" width="300" height=".7"/></g>
     <g fill="none" stroke="currentColor" stroke-width=".9">${Array.from({ length: 15 }, (_, i) => `<path d="M${10 + i * 20} 13c4-5 8-5 10 0s6 5 10 0"/>`).join('')}</g>`, 'orn-headpiece'),
};

// ───────── Modern ─────────
const modern: OrnamentSet = {
  name: 'Modern hairlines',
  corner: '',
  rule: svg('0 0 200 6', `<rect x="70" y="2.6" width="60" height=".8" fill="currentColor"/>`, 'orn-rule'),
  chapter: svg('0 0 200 6', `<rect x="0" y="2.6" width="34" height="1" fill="currentColor"/>`, 'orn-chapter orn-left'),
  fleuron: svg('0 0 20 20', `${lozenge(10, 10, 3.2, 3.2)}`, 'orn-fleuron'),
  scene: svg('0 0 60 10', `<g fill="currentColor">${dot(22, 5, 1.3)}${dot(30, 5, 1.3)}${dot(38, 5, 1.3)}</g>`, 'orn-scene'),
  headpiece: '',
};

// ───────── Minimal ─────────
const minimal: OrnamentSet = {
  name: 'Minimal',
  corner: '',
  rule: svg('0 0 200 4', `<rect x="0" y="1.6" width="200" height=".8" fill="currentColor"/>`, 'orn-rule'),
  chapter: svg('0 0 100 4', `<rect x="30" y="1.6" width="40" height=".8" fill="currentColor"/>`, 'orn-chapter'),
  fleuron: svg('0 0 20 20', `${lozenge(10, 10, 2.6, 2.6)}`, 'orn-fleuron'),
  scene: svg('0 0 60 12', `<g fill="currentColor">${lozenge(30, 6, 3, 3)}</g>`, 'orn-scene'),
  headpiece: '',
};

const none: OrnamentSet = { name: 'None', corner: '', rule: '', chapter: '', fleuron: '', scene: '', headpiece: '' };

export const ORNAMENT_SETS: Record<OrnamentSetId, OrnamentSet> = { classic, victorian, modern, minimal, none };

export function sceneBreakHtml(style: string, set: OrnamentSet): string {
  switch (style) {
    case 'asterism': return '<span class="sb-glyph">⁂</span>';
    case 'stars': return '<span class="sb-glyph sb-stars">*&#8195;*&#8195;*</span>';
    case 'hash': return '<span class="sb-glyph sb-hash">#</span>';
    case 'space': return '';
    default: return set.scene || '<span class="sb-glyph">⁂</span>';
  }
}
