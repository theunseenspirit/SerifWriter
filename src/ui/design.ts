import type { ProjectCtx } from './project.ts';
import type { TemplateDef, TemplateSettings } from '../model/types.ts';
import { h, icon, button } from './dom.ts';
import { toast, promptDialog, confirmDialog, sheetDrag } from './dialogs.ts';
import { allTemplates, getTemplate, baseTemplate, effectiveSettings, PAGE_SIZES, setCustomTemplates, injectTemplateCss, indentsParagraphs, templateDefaults } from '../templates/index.ts';
import { FONTS, FONT_IDS } from '../typeset/fonts.ts';
import { ORNAMENT_SETS } from '../typeset/ornaments.ts';
import * as repo from '../db/repo.ts';
import { deepDiff, getPath, setPath, uid, debounce, downloadBlob, slug } from '../util.ts';
import { bookCover } from './home.ts';
import { isPhone, syncThemeColor } from './viewport.ts';

// The Design drawer: choose a template, then adjust everything about it.
// Changes are stored as overrides on the project; "Save as template" turns
// them into a reusable template (JSON settings + CSS).

let closeOpen: (() => void) | null = null;

/** Opens the Design panel, or closes it if it is open. */
export function openDesign(ctx: ProjectCtx): void {
  if (closeOpen) { closeOpen(); return; }
  if (isPhone()) ctx.pane('pages'); // on a phone the design sheet slides up over the pages, so you see each change
  const drawer = h('aside', { class: 'drawer', 'aria-label': 'Design' });
  const btn = document.querySelector('.pj-design');
  document.body.appendChild(drawer);
  btn?.classList.add('on');
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) close(); };
  const close = () => { drawer.remove(); closeOpen = null; btn?.classList.remove('on'); document.removeEventListener('keydown', onKey); };
  closeOpen = close;
  document.addEventListener('keydown', onKey);
  render(ctx, drawer, close);
}

function render(ctx: ProjectCtx, drawer: HTMLElement, close: () => void): void {
  const project = ctx.session.project;
  const tpl = getTemplate(project.templateId);
  const cur: TemplateSettings = effectiveSettings(project);
  const relayout = debounce(() => void ctx.relayout(), 250);

  const commit = () => {
    project.overrides = deepDiff(templateDefaults(tpl), cur) || {};
    ctx.session.markProjectDirty();
    relayout();
  };
  const set = (path: string, value: any) => { setPath(cur, path, value); commit(); };

  // ── control builders ──
  const row = (label: string, control: HTMLElement, title = '') => h('div', { class: 'ds-row', title }, h('label', null, label), control);
  const select = (path: string, options: [string, string][]) => {
    const s = h('select', { class: 'input' }) as HTMLSelectElement;
    for (const [v, l] of options) s.appendChild(h('option', { value: v }, l));
    s.value = String(getPath(cur, path));
    s.addEventListener('change', () => set(path, s.value));
    return s;
  };
  const selectNum = (path: string, options: [number, string][]) => {
    const s = select(path, options.map(([v, l]) => [String(v), l]));
    s.onchange = () => set(path, Number(s.value));
    return s;
  };
  const toggle = (path: string, label: string) => {
    const c = h('input', { type: 'checkbox' }) as HTMLInputElement;
    c.checked = !!getPath(cur, path);
    c.addEventListener('change', () => set(path, c.checked));
    return h('label', { class: 'ds-toggle' }, c, h('span', null, label));
  };
  const range = (path: string, min: number, max: number, step: number, fmt: (v: number) => string) => {
    const r = h('input', { type: 'range', min, max, step }) as HTMLInputElement;
    const out = h('output', null, fmt(Number(getPath(cur, path))));
    r.value = String(getPath(cur, path));
    r.addEventListener('input', () => { out.textContent = fmt(Number(r.value)); set(path, Number(r.value)); });
    return h('div', { class: 'ds-range' }, r, out);
  };
  const number = (path: string, step: number, min: number, max: number) => {
    const n = h('input', { class: 'input', type: 'number', step, min, max }) as HTMLInputElement;
    n.value = String(getPath(cur, path));
    n.addEventListener('change', () => { const v = Math.min(max, Math.max(min, Number(n.value) || min)); n.value = String(v); set(path, v); });
    return n;
  };
  const sec = (title: string, ...kids: (HTMLElement | null)[]) => h('section', { class: 'ds-sec' }, h('h3', null, title), ...kids.filter(Boolean) as HTMLElement[]);
  const fontOptions: [string, string][] = FONT_IDS.map((id) => [id, FONTS[id].name + (FONTS[id].smallCaps ? '' : ' (simulated small caps)')]);

  // ── templates ──
  const tpls = h('div', { class: 'ds-tpls' }, ...allTemplates().map((t) => {
    const b = h('button', { class: `ds-tpl ${t.id === tpl.id ? 'on' : ''}`, type: 'button', title: t.description },
      bookCover({ meta: { title: t.name, subtitle: '', author: '', publisher: '', year: '', language: 'en', extra: {} }, templateId: t.id, overrides: {} } as any, 'small'),
      h('span', null, t.name), t.builtIn ? null : h('small', null, 'Your template'));
    b.addEventListener('click', async () => {
      if (t.id === tpl.id) return;
      const prev = { templateId: project.templateId, overrides: project.overrides };
      project.templateId = t.id;
      project.overrides = {};
      ctx.session.markProjectDirty();
      await ctx.relayout();
      render(ctx, drawer, close);
      if (Object.keys(prev.overrides || {}).length) {
        toast(`Switched to ${t.name}. Your adjustments to the previous design were reset.`, {
          action: 'Undo', timeout: 7000,
          onAction: async () => { project.templateId = prev.templateId; project.overrides = prev.overrides; ctx.session.markProjectDirty(); await ctx.relayout(); render(ctx, drawer, close); },
        });
      }
    });
    return b;
  }));

  // ── colour ──
  const swatches = h('div', { class: 'ds-swatches' });
  const paintSwatches = () => {
    swatches.replaceChildren(...tpl.accentPresets.map((p) => {
      const b = h('button', { class: `ds-swatch ${p.value.toLowerCase() === cur.color.accent.toLowerCase() ? 'on' : ''}`, type: 'button', title: p.name, style: { background: p.value } });
      b.addEventListener('click', () => { set('color.accent', p.value); custom.value = p.value; paintSwatches(); });
      return b;
    }), custom);
  };
  const custom = h('input', { class: 'ds-color', type: 'color', title: 'Custom colour' }) as HTMLInputElement;
  custom.value = cur.color.accent;
  custom.addEventListener('input', () => { set('color.accent', custom.value); paintSwatches(); });
  paintSwatches();
  const colorInput = (path: string) => {
    const c = h('input', { class: 'ds-color', type: 'color' }) as HTMLInputElement;
    c.value = getPath(cur, path);
    c.addEventListener('input', () => set(path, c.value));
    return c;
  };

  // ── margins ──
  const margins = h('div', { class: 'ds-margins' },
    ...(['inside', 'outside', 'top', 'bottom'] as const).map((k) => h('label', null, `${k[0].toUpperCase()}${k.slice(1)} (in)`, number(`page.margins.${k}`, 0.05, 0.2, 2))));

  // ── labels ──
  const labelPresets: [string, string][] = [['Chapter {Word}', 'Chapter One'], ['Chapter {n}', 'Chapter 1'], ['Chapter {Roman}', 'Chapter I'], ['{Roman}', 'I'], ['{n}', '1'], ['{Word}', 'One'], ['', 'No label']];
  const labelSel = h('select', { class: 'input' }) as HTMLSelectElement;
  for (const [v, l] of labelPresets) labelSel.appendChild(h('option', { value: v }, l));
  if (!labelPresets.some(([v]) => v === cur.chapter.label)) labelSel.appendChild(h('option', { value: cur.chapter.label }, cur.chapter.label));
  labelSel.value = cur.chapter.label;
  labelSel.addEventListener('change', () => set('chapter.label', labelSel.value));
  const labelCustom = h('input', { class: 'input', type: 'text', placeholder: 'Custom, e.g. Letter {Word}' }) as HTMLInputElement;
  labelCustom.addEventListener('change', () => { if (labelCustom.value.trim()) set('chapter.label', labelCustom.value.trim()); });

  const headingRoles: [string, string][] = [['part', 'Part (new page)'], ['chapter', 'Chapter (new page)'], ['section', 'Section'], ['subsection', 'Subsection'], ['minor', 'Minor heading'], ['runin', 'Run-in heading']];

  // ── paragraphs & line breaks ──
  const autoIndent = toggle('type.autoIndent', 'Indent new paragraphs');
  const autoIndentBox = autoIndent.querySelector('input') as HTMLInputElement;
  const indentRange = range('type.indent', 0, 4, 0.1, (v) => `${v.toFixed(1)} em`);
  const indentRow = row('Indent', indentRange);
  const spaced = h('input', { type: 'checkbox' }) as HTMLInputElement;
  spaced.checked = cur.type.paragraphStyle === 'block';
  const spacedToggle = h('label', { class: 'ds-toggle' }, spaced, h('span', null, 'Space between paragraphs'));
  const paintParagraphs = () => {
    const block = cur.type.paragraphStyle === 'block';
    autoIndentBox.disabled = block;
    autoIndentBox.checked = !block && cur.type.autoIndent !== false;
    autoIndent.classList.toggle('off', block);
    const on = indentsParagraphs(cur);
    (indentRange.querySelector('input') as HTMLInputElement).disabled = !on;
    indentRow.classList.toggle('off', !on);
  };
  autoIndentBox.addEventListener('change', paintParagraphs);
  spaced.addEventListener('change', () => { set('type.paragraphStyle', spaced.checked ? 'block' : 'indent'); paintParagraphs(); });
  paintParagraphs();

  // ── custom CSS ──
  const css = h('textarea', { class: 'input ds-css', spellcheck: 'false', placeholder: '/* CSS for this book only, e.g. */\n.op-title { font-style: italic; }\n.pg-head { letter-spacing: .3em; }' }) as HTMLTextAreaElement;
  css.value = project.customCss || '';
  const applyCss = debounce(() => { project.customCss = css.value; ctx.session.markProjectDirty(); injectTemplateCss([{ id: project.id, css: css.value }]); relayout(); }, 600);
  css.addEventListener('input', applyCss);

  const previewDelay = h('select', { class: 'input' }) as HTMLSelectElement;
  for (const ms of [300, 500, 700, 1000, 1500, 2500]) previewDelay.appendChild(h('option', { value: String(ms) }, `${ms / 1000} s`));
  void repo.kvGet<number>('previewDelay').then((v) => { previewDelay.value = String(v || 700); });
  previewDelay.addEventListener('change', async () => { await repo.kvSet('previewDelay', Number(previewDelay.value)); toast('Takes effect next time you open the book.'); });

  const theme = h('select', { class: 'input' }) as HTMLSelectElement;
  for (const [v, l] of [['auto', 'Match the system'], ['light', 'Light'], ['dark', 'Dark']]) theme.appendChild(h('option', { value: v }, l));
  theme.value = document.documentElement.dataset.theme || 'auto';
  theme.addEventListener('change', async () => {
    if (theme.value === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme.value;
    syncThemeColor();
    await repo.kvSet('theme', theme.value);
  });

  // ── actions ──
  const saveAs = button('Save as new template…', { icon: 'save', class: 'small', onClick: async () => {
    const name = await promptDialog('Save as template', 'Template name', `${tpl.name} — ${project.meta.title.split('\n')[0].slice(0, 30)}`, { ok: 'Save template' });
    if (!name) return;
    const def: TemplateDef = {
      id: uid('t'), name: name.trim(), description: `Your template, based on ${baseTemplate(tpl).name}.`, builtIn: false, base: tpl.base,
      settings: structuredClone(cur), css: [tpl.builtIn ? '' : tpl.css, project.customCss || ''].filter(Boolean).join('\n'),
      accentPresets: tpl.accentPresets, cover: { ...tpl.cover }, createdAt: Date.now(),
    };
    await repo.saveCustomTemplate(def);
    setCustomTemplates(await repo.listCustomTemplates());
    project.templateId = def.id;
    project.overrides = {};
    project.customCss = '';
    ctx.session.markProjectDirty();
    await ctx.relayout();
    render(ctx, drawer, close);
    toast(`Saved “${def.name}”. It’s now in your template list for every book.`, { kind: 'success' });
  } });
  const reset = button('Reset to template', { icon: 'restore', class: 'small', onClick: async () => {
    if (!Object.keys(project.overrides || {}).length && !project.customCss) return void toast('Already using the template as designed.');
    if (!(await confirmDialog('Reset design?', `Undo all your adjustments and go back to ${tpl.name} as designed?`, { ok: 'Reset' }))) return;
    project.overrides = {};
    project.customCss = '';
    ctx.session.markProjectDirty();
    await ctx.relayout();
    render(ctx, drawer, close);
  } });
  const exportTpl = button('Export template', { icon: 'export', class: 'small', onClick: () => {
    const def = { format: 'serifwriter-template', version: 1, ...tpl, id: tpl.builtIn ? `${tpl.id}-copy` : tpl.id, builtIn: false, settings: cur, css: [tpl.builtIn ? '' : tpl.css, project.customCss].filter(Boolean).join('\n') };
    downloadBlob(new Blob([JSON.stringify(def, null, 2)], { type: 'application/json' }), `${slug(tpl.name)}.serifwriter-template.json`);
  } });
  const importTpl = button('Import template…', { icon: 'import', class: 'small', onClick: () => {
    const input = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } }) as HTMLInputElement;
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        if (!j.settings || !j.base) throw new Error('This is not a SerifWriter template.');
        const def: TemplateDef = { id: uid('t'), name: String(j.name || 'Imported template'), description: String(j.description || ''), builtIn: false, base: getTemplate(j.base).id, settings: j.settings, css: String(j.css || ''), accentPresets: j.accentPresets || getTemplate(j.base).accentPresets, cover: j.cover || getTemplate(j.base).cover, createdAt: Date.now() };
        await repo.saveCustomTemplate(def);
        setCustomTemplates(await repo.listCustomTemplates());
        render(ctx, drawer, close);
        toast(`Imported “${def.name}”.`, { kind: 'success' });
      } catch (e: any) { toast(e.message || 'Could not read that file.', { kind: 'error' }); }
    });
    document.body.appendChild(input);
    input.click();
  } });
  const del = tpl.builtIn ? null : button('Delete this template', { icon: 'trash', class: 'small danger', onClick: async () => {
    if (!(await confirmDialog('Delete template?', `“${tpl.name}” will be removed from your template list. This book keeps its current look as adjustments to ${baseTemplate(tpl).name}.`, { ok: 'Delete', danger: true }))) return;
    project.templateId = tpl.base;
    project.overrides = deepDiff(templateDefaults(baseTemplate(tpl)), cur) || {};
    project.customCss = [tpl.css, project.customCss].filter(Boolean).join('\n');
    await repo.deleteCustomTemplate(tpl.id);
    setCustomTemplates(await repo.listCustomTemplates());
    ctx.session.markProjectDirty();
    await ctx.relayout();
    render(ctx, drawer, close);
  } });

  const body = h('div', { class: 'drawer-body' },
    sec('Template', tpls, h('p', { class: 'ds-note' }, tpl.description), h('div', { class: 'ds-actions' }, saveAs, reset, exportTpl, importTpl, del)),
    sec('Paragraphs & line breaks',
      row('', autoIndent, 'The first line of each new paragraph is indented, as in printed books. Off: every paragraph starts flush left.'),
      indentRow,
      row('', spacedToggle, 'A blank line’s worth of space between paragraphs, which are then never indented.'),
      row('', toggle('type.lineBreaks', 'Return starts a new line'), 'On: each Return in your text starts a new line in the book. Off: a single Return runs on into the same paragraph, and a blank line starts a new one.'),
      h('p', { class: 'ds-note ds-indent-note' }, 'With indenting off and Return on, each line is set just as you typed it, flush left.')),
    sec('Colour',
      row('Accent', swatches),
      row('Ink', colorInput('color.ink')),
      row('Paper (screen)', colorInput('color.paper'), 'Paper tint shown on screen. PDFs print on white paper unless you choose otherwise when exporting.')),
    sec('Typography',
      row('Text font', select('type.body', fontOptions)),
      row('Display font', select('type.display', fontOptions)),
      row('Size', range('type.size', 8, 14, 0.1, (v) => `${v.toFixed(1)} pt`)),
      row('Line spacing', range('type.leading', 0.9, 2.2, 0.01, (v) => `${v.toFixed(2)}×`), 'Like LaTeX’s \\linespread: 1.0 is single spacing (1.2 × the type size).'),
      row('', toggle('type.justify', 'Justified text')),
      row('', toggle('type.hyphenate', 'Hyphenation')),
      row('', toggle('type.oldstyleNums', 'Old-style numerals')),
      row('', toggle('type.abbrSmallCaps', 'Small caps for abbreviations (NATO, UNESCO)'))),
    sec('Page',
      row('Page size', select('page.size', Object.entries(PAGE_SIZES).map(([k, v]) => [k, v.label]))),
      row('Margins', margins),
      row('', toggle('page.twoSided', 'Two-sided (mirrored margins)')),
      row('Chapters start', select('chapter.start', [['any', 'On the next page'], ['recto', 'On a right-hand page']])),
      row('Opening sink', range('chapter.sink', 0.08, 0.55, 0.01, (v) => `${Math.round(v * 100)}% down`))),
    sec('Chapter openings',
      row('Label', labelSel),
      row('', labelCustom),
      row('Part label', select('chapter.partLabel', [['Part {Word}', 'Part One'], ['Part {Roman}', 'Part I'], ['Part {n}', 'Part 1'], ['Book {Roman}', 'Book I'], ['Book {Word}', 'Book One'], ['', 'No label']])),
      row('', toggle('chapter.ornament', 'Ornament under the title')),
      row('', toggle('dropCap.enabled', 'Drop cap')),
      row('Drop cap lines', range('dropCap.lines', 2, 5, 1, (v) => `${v} lines`)),
      row('With the drop cap', select('leadIn.mode', [['words', 'First words in small caps'], ['line', 'Whole first line in small caps'], ['none', 'Nothing']]), 'Small caps appear only beside a drop cap'),
      row('Small-cap words', range('leadIn.words', 1, 8, 1, (v) => `${v}`))),
    sec('Ornaments',
      row('Ornament set', select('ornaments', Object.entries(ORNAMENT_SETS).map(([k, v]) => [k, v.name]))),
      row('Scene break (---)', select('sceneBreak', [['ornament', 'Ornament'], ['asterism', 'Asterism ⁂'], ['stars', '* * *'], ['hash', '# (manuscript)'], ['space', 'Blank line']]))),
    sec('Running heads & page numbers',
      row('Left pages', select('runningHeads.verso', [['title', 'Book title'], ['author', 'Author'], ['chapter', 'Chapter title'], ['section', 'Section title'], ['none', 'Nothing']])),
      row('Right pages', select('runningHeads.recto', [['chapter', 'Chapter title'], ['section', 'Section title'], ['title', 'Book title'], ['author', 'Author'], ['none', 'Nothing']])),
      row('Alignment', select('runningHeads.align', [['center', 'Centred'], ['outside', 'Outside edge']])),
      row('Page numbers', select('runningHeads.folio', [['bottom-center', 'Bottom, centred'], ['bottom-outside', 'Bottom, outside'], ['top-outside', 'Top, outside'], ['none', 'None']])),
      row('', toggle('runningHeads.folioOnOpeners', 'Numbers on chapter-opening pages')),
      row('', toggle('runningHeads.manuscript', 'Manuscript header (Surname / TITLE / page)'))),
    sec('Title page',
      row('Frame', select('titlePage.frame', [['double', 'Double rule'], ['ornate', 'Ornate triple rule'], ['single', 'Single rule'], ['none', 'None']])),
      row('', toggle('titlePage.corners', 'Corner flourishes')),
      row('Layout', select('titlePage.layout', [['classic', 'Centred, classic'], ['modern', 'Flush left, modern'], ['manuscript', 'Manuscript cover page']]))),
    sec('Headings in your text',
      h('p', { class: 'ds-note' }, 'What each Markdown heading level means in this book. A chapter-level heading at the top of a chapter becomes its title.'),
      ...(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const).map((k, i) => row(`${'#'.repeat(i + 1)} heading`, select(`headings.${k}`, headingRoles))),
      row('Contents shows', selectNum('tocDepth', [[1, 'Parts and chapters'], [2, 'Chapters and sections'], [3, 'Sections and subsections']]))),
    sec('Notes & flow',
      row('Citations', select('citations', [['author-date', 'Author–date (Doe 2001, 33)'], ['numeric', 'Numeric [1, 33]'], ['note', 'Notes (Chicago footnotes)']]), 'How [@key] citations are set. Add a Bibliography section with your BibTeX.'),
      row('', toggle('numberHeadings', 'Number sections (1.1, 1.2…)')),
      row('Footnotes', select('footnotes', [['page', 'At the foot of the page'], ['endnotes', 'At the end of each chapter']])),
      row('Orphans', number('orphans', 1, 1, 4), 'Minimum lines of a paragraph left at the bottom of a page.'),
      row('Widows', number('widows', 1, 1, 4), 'Minimum lines of a paragraph carried to the top of a page.')),
    sec('Custom CSS', h('p', { class: 'ds-note' }, 'Applies to this book only. Pages use .page, .pg-head, .pg-foot, .opener, .op-label, .op-title, .dropcap, .scene-break, .toc-entry…'), css),
    sec('App', row('Preview delay', previewDelay, 'How long after you stop typing the pages update.'), row('Appearance', theme)),
  );

  const head = h('div', { class: 'drawer-head' }, h('h2', null, 'Design'), h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Close', onclick: close }, icon('close')));
  sheetDrag(drawer, head, close);
  drawer.replaceChildren(head, body);
}
