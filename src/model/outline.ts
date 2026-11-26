import type { TemplateSettings } from './types.ts';

// The headings inside one section's Markdown, for the sidebar outline: the
// lines the template sets as sections and subsections, with their source line
// so a click can jump the editor there.

export interface OutlineEntry {
  level: 1 | 2; // 1: section, 2: subsection
  title: string; // plain text
  line: number; // 0-based line in the section's content
  hnum?: string; // "1", "1.2" when the template numbers headings
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Inline Markdown → the plain words of a heading. */
export function plainHeading(src: string): string {
  return src
    .replace(/\s*\{[#.][^}]*\}\s*$/, '') // {#sec:id} attributes
    .replace(/\{\^[^}]*\}/g, '') // index entries
    .replace(/\^\[[^\]]*\]/g, '') // inline notes
    .replace(/\[\^[^\]]+\]/g, '') // note references
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links and images
    .replace(/\[([^\]]*)\]\{[^}]*\}/g, '$1') // [small caps]{.sc}
    .replace(/(\*\*|__|\*|_|`|~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/\\([\\`*_{}[\]()#+\-.!$^~|])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function outline(content: string, headings: TemplateSettings['headings'], numbered = false): OutlineEntry[] {
  const lines = content.replace(/^﻿/, '').split('\n');
  const out: OutlineEntry[] = [];
  let i = 0;
  // front matter
  if (/^---[ \t]*$/.test(lines[0] ?? '')) {
    for (let j = 1; j < lines.length; j++) if (/^(---|\.\.\.)[ \t]*$/.test(lines[j])) { i = j + 1; break; }
  }
  let fence = '';
  let math = false;
  let started = false; // any block seen yet
  let afterLead = false; // just past the section's own opening title
  const num = [0, 0];
  for (; i < lines.length; i++) {
    const l = lines[i];
    const f = FENCE.exec(l);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = ''; continue; }
    if (f) { fence = f[1]; continue; }
    if (/^\s*\$\$/.test(l)) {
      // a one-line $$ … $$ opens and closes on the same line
      const rest = l.trim().slice(2);
      if (math) math = false;
      else if (!/\$\$/.test(rest)) math = true;
      continue;
    }
    if (math) continue;
    const m = HEADING.exec(l);
    if (!m) { if (l.trim()) { started = true; afterLead = false; } continue; }
    const role = headings[`h${m[1].length}` as keyof TemplateSettings['headings']] || 'minor';
    const title = plainHeading(m[2]);
    const lead = afterLead;
    afterLead = false;
    if (role === 'chapter' || role === 'part') {
      // The first is the section's own title; later ones start a new chapter.
      afterLead = !started && role === 'chapter';
      if (started) num[0] = num[1] = 0;
      started = true;
      continue;
    }
    started = true;
    // A subsection straight under the opening title is its subtitle.
    if (role === 'subsection' && lead) continue;
    if (role !== 'section' && role !== 'subsection') continue;
    if (!title) continue;
    const level = role === 'section' ? 1 : 2;
    if (level === 1) { num[0]++; num[1] = 0; } else num[1]++;
    out.push({ level, title, line: i, ...(numbered ? { hnum: level === 1 ? String(num[0]) : `${num[0]}.${num[1]}` } : {}) });
  }
  return out;
}
