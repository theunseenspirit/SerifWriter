// Word counting that ignores Markdown syntax, link targets and front matter.

const WORD = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

export function stripForCount(md: string): string {
  let s = md.replace(/^﻿/, '');
  if (/^---[ \t]*\n/.test(s)) {
    const end = s.search(/\n(---|\.\.\.)[ \t]*(\n|$)/);
    if (end > 0) s = s.slice(s.indexOf('\n', end + 1) + 1 || s.length);
  }
  return s
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, ' ') // images
    .replace(/\]\([^)]*\)/g, ']') // link targets
    .replace(/^\s*\[\^[^\]]+\]:/gm, ' ') // footnote definitions
    .replace(/\[\^[^\]]+\]/g, ' ') // footnote refs
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, ' ') // link reference definitions
    .replace(/<[^>\n]+>/g, ' ') // html tags
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^@\w+\s*\{[\s\S]*?\}\s*$/gm, ' ') // BibTeX entries
    .replace(/-?@\w[\w:.#$%&+?<>~/-]*/g, ' ') // citation keys
    .replace(/\$\$[\s\S]*?\$\$|\$[^$\s][^$\n]*?\$(?!\d)/g, ' '); // TeX math
}

export function countWords(md: string): number {
  const m = stripForCount(md).match(WORD);
  return m ? m.length : 0;
}

/** Rounds like a manuscript cover page: "about 85,000 words". */
export function roundedWords(n: number): string {
  if (n < 1000) return Math.max(100, Math.round(n / 100) * 100).toLocaleString('en-US');
  if (n < 20000) return (Math.round(n / 100) * 100).toLocaleString('en-US');
  return (Math.round(n / 1000) * 1000).toLocaleString('en-US');
}
