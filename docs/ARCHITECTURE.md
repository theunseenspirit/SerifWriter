# SerifWriter — Architecture & Build Plan

A private, offline, local-first writing app that typesets your Markdown into
book pages live, as you write.

---

## 1. The one decision: PWA now, Tauri only if needed later

**Recommendation: ship as an installable Progressive Web App, used in Chrome.
Don't wrap it in Tauri now.**

| Need | PWA in Chrome | Tauri (WKWebView on macOS) |
|---|---|---|
| Opens instantly offline from the Dock | ✅ service worker + "Install app" | ✅ |
| Real `.md` files in a folder on disk | ✅ File System Access API (Chrome/Edge only) — folder permission can persist ("Allow on every visit", Chrome 122+) | ✅ native fs |
| Print-ready PDF with embedded fonts | ✅ Chrome's print engine honours `@page` sizes and embeds subset fonts | ⚠️ WKWebView printing is limited; `@page size` support is patchy, and `window.print()` historically doesn't work in Tauri on macOS |
| Bundle / RAM on a 2018 MacBook Air | ~1.2 MB total (fonts are ~1 MB of it) | +~8 MB shell, separate runtime process |
| Updates | automatic (service worker) | needs signing + updater |
| Safari | works (no folder mirror; zip backup instead) | n/a |

The only thing Tauri would add is folder access without a permission prompt and
in Safari's engine. Chrome's persistent permissions remove most of that
friction, and Tauri would *cost* us the best part of the PDF pipeline. The
storage layer is written behind small adapters (`storage/mirror.ts`), so a
Tauri backend can be added later without touching the editor or typesetter.

**Revisit Tauri if:** you want to work only in Safari, want OS-level file
associations (double-click a `.md` to open it), or want the app to write
backups to disk with no browser involved at all.

---

## 2. The second decision: a small custom paginator, not Paged.js

Paged.js was measured: **503 KB minified / 97 KB gzipped**, and it is built as
a polyfill that re-flows the *whole document* on every change. That fights
the two hard requirements — *typing never lags* on a dual-core 2018 Air, and
*re-paginate only the chapter being edited*.

Instead SerifWriter uses its own ~450-line paginator (`src/typeset/paginate.ts`)
that keeps Paged.js's good idea — real CSS `@page` rules for printing — and
drops the rest:

* **Per-section pagination.** Every chapter starts on a new page, and mirrored
  margins never change the text-block *width* (inside + outside is constant),
  so a chapter's line breaks don't depend on what came before it. Each section
  is paginated alone and cached by a hash of (content + template settings).
  Editing chapter 7 re-paginates only chapter 7; page numbers, recto/verso
  margins, running heads and the table of contents are re-assigned afterwards
  in a cheap "assembly" pass that only touches text and class names.
* **Line-accurate splitting.** Blocks are poured into a fixed-size page box;
  when one overflows, a binary search over `Range.getClientRects()` finds the
  first line that doesn't fit, and `Range.extractContents()` splits the DOM
  there (nested lists, quotes and inline formatting split cleanly). Widows and
  orphans (2/2 by default), keep-with-next for headings, hyphenated breaks,
  justified last lines, continued list numbering and table header repetition
  are handled.
* **Page-bottom footnotes.** Footnote bodies are placed on the page of their
  reference; the text area shrinks to make room.
* **Never blocks typing.** Pagination runs in ~8 ms slices with `yield` between
  them, is cancelled if you start typing again, only starts after you pause
  (700 ms), and offscreen pages use `content-visibility: auto` so the browser
  skips painting them.

Printing uses the same page DOM: `@page { size: 6in 9in; margin: 0 }`, each
page is one sheet, so the PDF is exactly what the preview shows.

---

## 3. Architecture

```
┌──────────────────────────── UI (vanilla TypeScript, no framework) ─────────────────────────────┐
│ Home (library of books)  │  Project: sidebar (sections) │ editor (textarea) │ live page preview │
│ Design panel (templates) │  History  │  Export  │  Reading mode (full-screen spreads)            │
└─────────────┬──────────────────────────────────────┬──────────────────────────────┬───────────┘
              │                                      │                              │
      storage/autosave                     typeset/book (assembly)            export/*
   debounce → IndexedDB                    ├ md/render (markdown-it + plugins)   PDF (print CSS, bleed)
   sync journal → localStorage             │  ├ md/cite (BibTeX, 3 styles)       EPUB 3 (zip)
   storage/snapshots (gzip)                │  └ md/math (TeX → MathML, lazy)     DOCX (OOXML)
   storage/mirror (File System Access)     ├ typeset/sections (page types)       HTML, Markdown
   storage/backup (zip)                    ├ typeset/paginate (per section)
                                           └ templates (JSON + CSS)
              │
          db/idb + db/repo  — IndexedDB: projects · sections · snapshots · snapshotData · templates · assets · kv
```

### Data model (IndexedDB `serifwriter`)

* `projects` — book metadata (title, subtitle, author…), section order,
  template id + your overrides, last-opened section, cached word count, goals,
  and `stats` — writing habits: per day {net words, active minutes, book
  length}, plus active minutes by hour of day. The session records them on
  each content change (`storage/session.ts`); `model/stats.ts` derives
  streaks, pace and prose metrics; `ui/stats.ts` draws them as small SVG
  charts at their real pixel width.
* `sections` — one row per sidebar item: `kind` (title, copyright, dedication,
  epigraph, toc, part, chapter, section, about, bibliography), Markdown
  (or, for the bibliography, BibTeX) `content`, word
  count, cursor + scroll position (so it reopens where you left off).
* `snapshots` / `snapshotData` — version history; metadata is listed quickly,
  the gzipped project copy is loaded only when you preview or restore.
* `templates` — your saved custom templates (JSON settings + CSS).
* `assets` — pasted/dropped images as Blobs.
* `kv` — app state (last project, folder handle, preferences).

### Never losing words

1. Every keystroke marks the section dirty (no work on the keystroke itself).
2. 400 ms after you pause (max 2 s while typing continuously) the text is
   written to IndexedDB in one transaction. IndexedDB writes are atomic.
3. On `pagehide` / tab hidden, the unsaved text is written **synchronously**
   to a localStorage journal, which is replayed on next launch.
4. `navigator.storage.persist()` asks the browser not to evict the data.
5. Version snapshots every 10 minutes of active writing, before every restore,
   import or deletion, plus named versions on demand. Older automatic snapshots
   are thinned (all for 24 h → hourly for a week → daily for 3 months → weekly).
6. Optional folder mirror: each book becomes a folder of plain `.md` files
   (with YAML front matter) plus `project.json`, rewritten ~1.5 s after saves.
7. One-click `.zip` backup/restore of everything.

### Typesetting pipeline

`Markdown → markdown-it (CommonMark + GFM tables/strikethrough/autolinks,
task lists, footnotes, typographer quotes, citations, TeX math) → sanitizer →
math fill-in → DOM post-processing (heading roles and numbers, scene breaks,
drop cap, small-caps lead-in, footnote extraction, source-line mapping) → section builder (page types) → paginator →
book assembly (blank pages for recto starts, roman/arabic folios, running
heads, TOC page numbers) → preview / print / reader`.

**Citations** (`md/cite.ts`, ~300 lines): a BibTeX reader (nested braces,
`#` concatenation, LaTeX accents, `and`-separated names with von-parts and
`{protected}` groups) and three styles. The book layout scans every section
once per pause for cited keys (in order of first appearance) and hands the
parsed bibliography to the renderer through markdown-it's `env`. A section's
cache key includes a hash of (BibTeX + style + citation order) only if it
contains an `@`, so editing the bibliography or adding a new citation
re-paginates just the sections that cite and the reference list. Notes style
writes footnote tokens the same way markdown-it-footnote's inline notes do;
the core inline pass is re-run with a flag so citations inside footnote
definitions are set in place rather than nested.

**Cross-references** reuse the same scan and context: `{#fig:…}`, `{#tbl:…}`
and `{#eq:…}` labels are numbered per kind in book order, `@fig:…` resolves
through the citation rule, figures and `Table:` captions are numbered in the
section post-processing, and labelled equations get a `\tag{n}`. Sections are
re-laid out when that context changes only if they contain `@` or `{#`.

**Math** (`md/math.ts`): `$…$`/`$$…$$` become sanitised placeholders, filled
after sanitising with MathML from Temml (trusted output, no HTML passthrough).
Temml is a separate 60 KB chunk, imported only when a book contains `$`;
once it loads, sections with `$` are re-queued. A paragraph that is only a
display equation becomes an unbreakable block.

Heading levels map to roles per template — e.g. `#` → chapter, `##` → section
— or `#` → part, `##` → chapter. A leading chapter-level heading becomes the
chapter's title.

### Templates = JSON + CSS

Each template is a folder `src/templates/<id>/` with `template.json`
(every setting: page size, margins, fonts, size, leading, colours, drop caps,
ornament set, running heads, heading map…) and `template.css` (scoped with
CSS nesting under `.tpl-<id>`, driven by CSS custom properties). Your changes
are stored as overrides on the project; "Save as template" stores a new
template (base + settings + optional extra CSS) in IndexedDB, exportable as
`.json`.

Built-ins: **Classic Leather** (the flagship, matching `demo.tex`),
**Modern Literary**, **Manuscript** (standard submission format),
**Ornate Victorian**, **Pocket Edition**, **Scholarly Monograph**
(university press: numbered sections, author–date citations).

Fonts (SIL Open Font License, bundled, subset to Latin with *all* OpenType
features kept — the Google Fonts/npm builds strip small caps and old-style
figures): Cardo, EB Garamond, Crimson Pro, Libre Baskerville, Cormorant.
Real small caps exist in Cardo, EB Garamond and Cormorant; the others fall back
to browser-synthesised small caps.

### Dependencies (runtime)

* `markdown-it` + `markdown-it-footnote` — spec-compliant CommonMark parser.
* `fflate` — zip for EPUB, DOCX and backups (loaded only when exporting).
* `temml` — TeX → MathML (loaded only for books with math).

That's all. No UI framework, no Paged.js, no editor library (a native
`<textarea>` is the fastest, most robust writing surface and keeps native
undo, spellcheck and IME support).

### Browser support

| Feature | Chrome/Edge | Safari 17+ (Sonoma) |
|---|---|---|
| Install to Dock, offline | ✅ | ✅ (File ▸ Add to Dock) |
| IndexedDB autosave, history, zip backup | ✅ | ✅ |
| Folder mirror (File System Access) | ✅ | ❌ — use zip backup |
| Drop caps (`initial-letter`) | ✅ 110+ | ✅ (prefixed) |
| PDF export with exact page size | ✅ best | ⚠️ works; page-size support varies |

**Use Chrome as the primary browser.** Data lives per *origin* (e.g.
`http://localhost:4173`); keep using the same address, and move between
origins with the zip backup.

---

## 4. Phased build plan

| Phase | Scope |
|---|---|
| 0 | Architecture, Vite + TypeScript scaffold, font subsetting, licences |
| 1 | IndexedDB layer, library home screen (create/rename/duplicate/delete with trash), project view, sidebar with drag-reorder and word counts, textarea editor, autosave + crash journal, resume where you left off, service worker + manifest |
| 2 | Markdown pipeline, paginator, page types, book assembly, live preview with debounce and per-chapter re-pagination, Classic Leather to `demo.tex` spec |
| 3 | The other four templates, Design panel (accent presets + custom colour, fonts, size, leading, margins, page size, drop caps, ornaments, running heads, heading map, custom CSS), save as template |
| 4 | Version history (auto + named, diff view, restore project or one chapter), folder mirror + import from folder, zip backup/restore |
| 5 | Exports: PDF (with bleed), EPUB 3, DOCX, HTML, Markdown; full-screen reading mode |
| 6 | Browser verification, CPU-throttled typing check, tests |
| 7 | Scholarship: BibTeX citations (author–date, numeric, notes), bibliography, TeX math, numbered sections, cross-references, Scholarly Monograph template, A4/Royal page sizes, find & replace |
| 8 | Writing stats: habits (streaks, words per day, time, pace, hours of day), book growth, chapter balance, prose metrics |

All eight phases are built. Measured results (Chromium, CPU throttled 4× ≈ 2018 MacBook Air,
120,000-word / 350-page book, `tests/e2e/perf.cjs`):

| | 4× throttle | 6× throttle |
|---|---|---|
| Whole book typeset on open | 2.5 s | 4.4 s |
| Keystroke latency, median / p95 / worst | 16 / 24 / 32 ms | 16 / 32 / 56 ms |
| Re-paginate the edited chapter (12 pages) after a pause | 64 ms, sliced | 118 ms, sliced |
| Longest main-thread task while writing | 66 ms (after a pause) | 116 ms (after a pause) |

Verification: 24 unit tests (`npm test`) and 33 browser checks (`npm run e2e`): autosave across
reload, crash-journal recovery on tab close, offline launch, folder mirror, image paste, section
operations, versions, templates, backup → delete → restore, citations in all three styles, the
bibliography, cross-references, math, find & replace, the citation picker, writing stats, and
citations/math in the DOCX and EPUB.
Exports were checked by rendering the PDF (6 × 9 in, 6.125 × 9.25 in with bleed, fonts embedded),
structurally validating the EPUB, and opening the DOCX in LibreOffice.
