import type { Project, Section } from '../model/types.ts';
import { splitFrontMatter, withFrontMatter, type FMValue } from '../md/frontmatter.ts';
import { sectionTitle } from '../model/defaults.ts';
import * as repo from '../db/repo.ts';
import { extFor } from './common.ts';

// The whole book as one Markdown file with YAML front matter. If the book has
// images, it becomes a .zip with book.md and an images/ folder.

export async function exportMarkdown(project: Project, sections: Section[]): Promise<{ blob: Blob; ext: 'md' | 'zip' }> {
  const m = project.meta;
  const fm: Record<string, FMValue> = { title: m.title };
  if (m.subtitle) fm.subtitle = m.subtitle;
  if (m.author) fm.author = m.author;
  if (m.publisher) fm.publisher = m.publisher;
  if (m.year) fm.year = m.year;
  if (m.language && m.language !== 'en') fm.language = m.language;
  const out: string[] = [];
  for (const s of sections) {
    if (s.kind === 'title' || s.kind === 'toc' || s.kind === 'index') continue;
    const body = splitFrontMatter(s.content).body.trim();
    if (s.kind === 'copyright' || s.kind === 'dedication' || s.kind === 'epigraph') {
      if (body) out.push(`<!-- ${s.kind} -->\n\n${body}`);
      continue;
    }
    const title = sectionTitle(s);
    if (s.kind === 'bibliography') { out.push(`# ${title}\n\n\`\`\`bibtex\n${body}\n\`\`\``); continue; }
    const startsWithHeading = /^#\s/.test(body);
    const head = s.kind === 'part' ? `# Part: ${title}` : startsWithHeading ? '' : `# ${title}`;
    out.push([head, body].filter(Boolean).join('\n\n'));
  }
  const assets = await repo.listAssets(project.id);
  let text = withFrontMatter(fm, '\n' + out.join('\n\n') + '\n', ['title', 'subtitle', 'author']);
  if (!assets.length) return { blob: new Blob([text], { type: 'text/markdown' }), ext: 'md' };
  const { zipSync } = await import('fflate');
  const enc = new TextEncoder();
  const files: Record<string, Uint8Array> = {};
  for (const a of assets) {
    const name = `images/${a.id}.${extFor(a.type)}`;
    text = text.split(`asset:${a.id}`).join(name);
    files[name] = new Uint8Array(await a.blob.arrayBuffer());
  }
  files['book.md'] = enc.encode(text);
  return { blob: new Blob([zipSync(files) as BlobPart], { type: 'application/zip' }), ext: 'zip' };
}
