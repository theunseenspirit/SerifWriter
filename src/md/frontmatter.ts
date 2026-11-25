// A small YAML front-matter reader/writer covering what books need:
// `key: value`, quoted strings, `|` / `>` block scalars, simple `- item` lists
// and `# comments`. Anything fancier is kept as raw text.

export type FMValue = string | string[];
export interface FrontMatter {
  data: Record<string, FMValue>;
  body: string;
  /** Number of source lines taken by the front matter block (for line mapping). */
  lines: number;
  present: boolean;
}

const FENCE = /^---[ \t]*$/;
const END = /^(---|\.\.\.)[ \t]*$/;

export function splitFrontMatter(text: string): FrontMatter {
  const src = text.replace(/^﻿/, '');
  const lines = src.split('\n');
  if (!lines.length || !FENCE.test(lines[0])) return { data: {}, body: src, lines: 0, present: false };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (END.test(lines[i])) { end = i; break; }
  }
  if (end < 0) return { data: {}, body: src, lines: 0, present: false };
  const data = parseYaml(lines.slice(1, end).join('\n'));
  return { data, body: lines.slice(end + 1).join('\n'), lines: end + 1, present: true };
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    return t.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") return t.slice(1, -1).replace(/''/g, "'");
  // strip trailing comment (" # ...") on plain scalars
  return t.replace(/\s+#.*$/, '');
}

export function parseYaml(src: string): Record<string, FMValue> {
  const out: Record<string, FMValue> = {};
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = /^([A-Za-z_][\w\- ]*?)\s*:(?:\s+(.*)|\s*)$/.exec(line);
    if (!m) continue;
    const key = m[1].trim().toLowerCase().replace(/[\s-]+/g, '_');
    const raw = (m[2] ?? '').trimEnd();
    if (raw === '|' || raw === '>' || raw === '|-' || raw === '>-' || raw === '|+' || raw === '>+') {
      const block: string[] = [];
      let indent = -1;
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next.trim() === '') { block.push(''); i++; continue; }
        const ind = next.length - next.trimStart().length;
        if (ind === 0) break;
        if (indent < 0) indent = ind;
        block.push(next.slice(Math.min(indent, ind)));
        i++;
      }
      while (block.length && block[block.length - 1] === '') block.pop();
      out[key] = raw[0] === '>' ? block.join(' ').replace(/ {2,}/g, ' ').replace(/ ?\n ?/g, '\n') : block.join('\n');
      continue;
    }
    if (raw === '') {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        items.push(unquote(lines[i + 1].replace(/^\s*-\s+/, '')));
        i++;
      }
      out[key] = items.length ? items : '';
      continue;
    }
    if (raw.startsWith('[') && raw.endsWith(']')) {
      out[key] = raw.slice(1, -1).split(',').map((s) => unquote(s)).filter(Boolean);
      continue;
    }
    out[key] = unquote(raw);
  }
  return out;
}

function quoteIfNeeded(v: string): string {
  if (v === '') return '""';
  if (/^[\s]|[\s]$|^[-?:,\[\]{}#&*!|>'"%@`]|: | #|^(true|false|null|yes|no|~)$/i.test(v) || /^\d/.test(v) && !/^\d{4}$/.test(v)) {
    return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return v;
}

export function stringifyYaml(data: Record<string, FMValue>, order: string[] = []): string {
  const keys = [...order.filter((k) => k in data), ...Object.keys(data).filter((k) => !order.includes(k))];
  const out: string[] = [];
  for (const k of keys) {
    const v = data[k];
    if (Array.isArray(v)) {
      out.push(`${k}:`);
      for (const item of v) out.push(`  - ${quoteIfNeeded(item)}`);
    } else if (v.includes('\n')) {
      out.push(`${k}: |`);
      for (const l of v.split('\n')) out.push(l ? '  ' + l : '');
    } else out.push(`${k}: ${quoteIfNeeded(v)}`);
  }
  return out.join('\n');
}

export function withFrontMatter(data: Record<string, FMValue>, body: string, order: string[] = []): string {
  const keys = Object.keys(data);
  if (!keys.length) return body;
  return `---\n${stringifyYaml(data, order)}\n---\n${body.startsWith('\n') || !body ? body : '\n' + body}`;
}

export const fmString = (v: FMValue | undefined): string => (v === undefined ? '' : Array.isArray(v) ? v.join(', ') : v);
