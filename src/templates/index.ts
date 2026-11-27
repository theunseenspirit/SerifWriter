import type { PageSizeId, Project, TemplateDef, TemplateSettings } from '../model/types.ts';
import { deepDiff, deepMerge, setPath } from '../util.ts';
import { FONTS, fontStack } from '../typeset/fonts.ts';

import classicJson from './classic/template.json';
import classicCss from './classic/template.css?raw';
import modernJson from './modern/template.json';
import modernCss from './modern/template.css?raw';
import manuscriptJson from './manuscript/template.json';
import manuscriptCss from './manuscript/template.css?raw';
import victorianJson from './victorian/template.json';
import victorianCss from './victorian/template.css?raw';
import pocketJson from './pocket/template.json';
import pocketCss from './pocket/template.css?raw';
import scholarlyJson from './scholarly/template.json';
import scholarlyCss from './scholarly/template.css?raw';
import syllogismJson from './syllogism/template.json';
import syllogismCss from './syllogism/template.css?raw';

const builtIn = (json: any, css: string): TemplateDef => ({ ...json, builtIn: true, base: json.id, css });

export const BUILT_IN: TemplateDef[] = [
  builtIn(classicJson, classicCss),
  builtIn(modernJson, modernCss),
  builtIn(manuscriptJson, manuscriptCss),
  builtIn(victorianJson, victorianCss),
  builtIn(pocketJson, pocketCss),
  builtIn(scholarlyJson, scholarlyCss),
  // Syllogism wears the Scholarly Monograph page; its arguments are laid out by the shared book styles.
  builtIn(syllogismJson, scholarlyCss.replaceAll('.tpl-scholarly', '.tpl-syllogism') + syllogismCss),
];

export const PAGE_SIZES: Record<PageSizeId, { w: number; h: number; label: string }> = {
  '5x8': { w: 5, h: 8, label: '5 × 8 in' },
  '5.5x8.5': { w: 5.5, h: 8.5, label: '5.5 × 8.5 in' },
  '6x9': { w: 6, h: 9, label: '6 × 9 in' },
  royal: { w: 6.14, h: 9.21, label: 'Royal (156 × 234 mm)' },
  '7x10': { w: 7, h: 10, label: '7 × 10 in' },
  a5: { w: 5.8268, h: 8.2677, label: 'A5 (148 × 210 mm)' },
  a4: { w: 8.2677, h: 11.6929, label: 'A4 (210 × 297 mm)' },
  letter: { w: 8.5, h: 11, label: 'US Letter (8.5 × 11 in)' },
};

let custom: TemplateDef[] = [];
export function setCustomTemplates(list: TemplateDef[]): void {
  custom = list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}
export const allTemplates = (): TemplateDef[] => [...BUILT_IN, ...custom];
export const customTemplates = (): TemplateDef[] => custom;

export function getTemplate(id: string): TemplateDef {
  return allTemplates().find((t) => t.id === id) || BUILT_IN[0];
}

export function baseTemplate(t: TemplateDef): TemplateDef {
  return BUILT_IN.find((b) => b.id === t.base) || BUILT_IN[0];
}

/** Template defaults merged with the project's own overrides. */
export function effectiveSettings(project: Pick<Project, 'templateId' | 'overrides'>): TemplateSettings {
  const t = getTemplate(project.templateId);
  // Custom templates store complete settings, but merge onto the base so new keys get defaults.
  const base = deepMerge(baseTemplate(t).settings, t.settings);
  return deepMerge(base, project.overrides || {});
}

/** A template's own settings, before a book's adjustments. */
export function templateDefaults(t: TemplateDef): TemplateSettings {
  return deepMerge(baseTemplate(t).settings, t.settings);
}

/** Changes one setting of a book (e.g. 'type.autoIndent'), stored as an adjustment to its template. */
export function setBookSetting(project: Pick<Project, 'templateId' | 'overrides'>, path: string, value: unknown): void {
  const cur = effectiveSettings(project);
  setPath(cur, path, value);
  project.overrides = deepDiff(templateDefaults(getTemplate(project.templateId)), cur) || {};
}

/** Whether new paragraphs get a first-line indent (never with space between paragraphs). */
export function indentsParagraphs(s: TemplateSettings): boolean {
  return s.type.paragraphStyle !== 'block' && s.type.autoIndent !== false;
}

/** Whether a single Return in the text starts a new line in the book (on unless turned off). */
export function keepsLineBreaks(s: TemplateSettings): boolean {
  return s.type.lineBreaks !== false;
}

/** The first-line indent of a paragraph, in em (0 when paragraphs are not indented). */
export function paragraphIndent(s: TemplateSettings): number {
  return indentsParagraphs(s) ? s.type.indent : 0;
}

export function pageSize(s: TemplateSettings) {
  return PAGE_SIZES[s.page.size] || PAGE_SIZES['6x9'];
}

/** CSS custom properties that drive every template stylesheet. */
export function bookVars(s: TemplateSettings): Record<string, string> {
  const { w, h } = pageSize(s);
  const m = s.page.margins;
  const lh = 1.2 * s.type.leading;
  const lhPt = s.type.size * lh;
  const cap = FONTS[s.type.display]?.capHeight ?? 0.68;
  const lines = Math.max(2, Math.round(s.dropCap.lines));
  return {
    '--page-w': `${w}in`,
    '--page-h': `${h}in`,
    '--m-in': `${m.inside}in`,
    '--m-out': `${m.outside}in`,
    '--m-top': `${m.top}in`,
    '--m-bot': `${m.bottom}in`,
    '--head-sep': `${s.page.headSep}in`,
    '--foot-skip': `${s.page.footSkip}in`,
    '--fs': `${s.type.size}pt`,
    '--lh': lh.toFixed(4),
    '--lh-pt': `${lhPt.toFixed(3)}pt`,
    '--font-body': fontStack(s.type.body),
    '--font-display': fontStack(s.type.display),
    '--ink': s.color.ink,
    '--accent': s.color.accent,
    '--paper': s.color.paper,
    '--indent': `${paragraphIndent(s)}em`,
    '--sink': `${Math.max(0, s.chapter.sink * h - m.top).toFixed(3)}in`,
    '--third': `${Math.max(0, h / 3 - m.top).toFixed(3)}in`,
    '--text-align': s.type.justify ? 'justify' : 'left',
    '--hyphens': s.type.hyphenate ? 'auto' : 'manual',
    '--dc-lines': String(lines),
    '--dc-size': `${(((lines - 1) * lhPt + cap * s.type.size) / cap).toFixed(2)}pt`,
  };
}

export function bookClasses(t: TemplateDef, s: TemplateSettings): string[] {
  return [
    'sw-book',
    `tpl-${t.base}`,
    t.builtIn ? '' : `tpl-c-${t.id}`,
    s.dropCap.enabled ? 'has-dropcap' : '',
    s.type.justify ? 'justify' : 'ragged',
    s.type.paragraphStyle === 'block' ? 'para-block' : indentsParagraphs(s) ? 'para-indent' : 'para-flush',
    s.page.twoSided ? 'two-sided' : 'one-sided',
    `rh-${s.runningHeads.align}`,
    `folio-${s.runningHeads.folio}`,
    s.type.oldstyleNums ? 'onum' : 'lnum',
    `leadin-${s.leadIn.mode}`,
  ].filter(Boolean);
}

/** Applies template classes and variables to a book root element. */
export function applyBookRoot(el: HTMLElement, t: TemplateDef, s: TemplateSettings, lang = 'en'): void {
  el.className = bookClasses(t, s).join(' ');
  el.lang = lang || 'en';
  const vars = bookVars(s);
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
}

/** Injects every template stylesheet (built-in and custom) once, refreshed on change. */
export function injectTemplateCss(extraProjectCss: { id: string; css: string }[] = []): void {
  let el = document.getElementById('sw-templates') as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = 'sw-templates';
    document.head.appendChild(el);
  }
  const parts = BUILT_IN.map((t) => t.css);
  for (const t of custom) if (t.css.trim()) parts.push(`.tpl-c-${t.id} {\n${t.css}\n}`);
  for (const p of extraProjectCss) if (p.css.trim()) parts.push(`.proj-${p.id} {\n${p.css}\n}`);
  const css = parts.join('\n');
  if (el.textContent !== css) el.textContent = css;
}
