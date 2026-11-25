# SerifWriter

A private, offline writing app that typesets your words into book pages **as you write**.
Your manuscript lives in your browser's own database on your Mac — no accounts, no servers —
and appears beside you as a real book: drop caps, small capitals, running heads, fleurons.
For scholars it also sets citations and a bibliography from BibTeX, TeX mathematics and numbered
sections, in a university-press template or any other.

![Classic Leather](docs/classic-leather.jpg)

## Install it (once)

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
```

```bash
npm start
```

Then open **http://localhost:4173** in **Chrome** and click the *Install* icon at the right of the
address bar (or ⋮ ▸ *Cast, save and share* ▸ *Install page as app*). SerifWriter is now in your
Dock and Launchpad and opens instantly, **with no internet and without `npm start` running** — the
whole app, fonts included, is cached by its service worker.

* **Keep using the same address.** Browsers keep data per address, so a book written at
  `localhost:4173` lives there. Use *Backup* ▸ *Download backup* to move books anywhere else.
* **Updates:** pull the new code and run `npm start` again; the app shows *“A new version is
  ready — Restart”*.
* **Safari (macOS Sonoma):** open the address and choose *File ▸ Add to Dock*. Everything works
  except mirroring to a folder (Safari doesn't support it) — use zip backups there.
* You can also host the `dist/` folder on any static host (GitHub Pages, Netlify). Your writing
  still never leaves your machine.

## Your words are safe

| Layer | What happens |
|---|---|
| Autosave | 0.35 s after you pause (and every 2 s while typing nonstop), atomically, to IndexedDB. No save button. |
| Crash journal | When the tab closes or the Mac sleeps, unsaved text is written synchronously to a local journal and replayed on next launch. |
| Persistent storage | The app asks the browser to never evict its data. |
| Version history | A version every 10 minutes of writing, each time you open a book, and before any delete or restore; name versions to keep them forever. Paragraph diffs; restore a whole book or one chapter. |
| Folder mirror | *Back up to a folder…* (Chrome/Edge): every book is mirrored as plain `.md` files with YAML front matter plus `project.json` — readable in any editor, importable back. |
| Zip backup | One click: every book as Markdown + settings (+ history if you like). *Import* restores it. |

## Writing

Full CommonMark + GitHub-flavoured Markdown: `*italic*`, `**bold**`, `~~strike~~`, `> quotes`,
lists and task lists, tables, `` `code` `` and fenced code, links, autolinks, footnotes, images
(paste or drag them in), raw HTML (sanitised), and TeX math.

| You type | You get |
|---|---|
| `---` on its own line, with a blank line before it | a scene-break ornament |
| `Text.[^1]` … `[^1]: The note.` | a footnote at the foot of the page (or chapter endnotes) |
| `# Heading` at the top of a chapter | the chapter's title (the opening page) |
| `#`…`######` elsewhere | part / chapter / section / subsection… — configurable per template |
| `<!-- pagebreak -->` | a page break |
| `"quotes"`, `--`, `---`, `...` | “curly quotes”, en dash, em dash, ellipsis |
| `[@key]`, `[see @key, 33–35; @other]` | a citation: (Doe 2001, 33–35), [1, 33] or a footnote, by style |
| `[-@key]`, `@key`, `@key [33]` | year only (2001); narrative Doe (2001) or Doe (2001, 33) |
| `$e^{i\pi}+1=0$`, `$$ … $$` | inline and display mathematics (`\tag{1}` numbers an equation) |

**Book details** are YAML front matter in the *Title Page* section (or *Book details* in the top bar):

```yaml
---
title: |
  The Road
  Behind Us
subtitle: Essays on Leaving and Arriving
author: Your Name
publisher: Privately Printed
year: MMXXVI
---
```

A line break in the title is where it breaks on the title page. For the Manuscript template you can
add `legal_name`, `address`, `email`, `phone`, `pen_name`, `surname` and `short_title`. The copyright
page understands `{author} {title} {year} {thisYear} {publisher} {font}`.

**Page types** (*Add* in the sidebar): title page, copyright, dedication, epigraph, contents
(generated, with page numbers), part divider, chapter, unnumbered chapter (preface, afterword…),
about the author, bibliography. Drag to reorder, or select one and press ⌥↑ / ⌥↓.

### Citations and bibliography

Add a **Bibliography** section and paste your BibTeX into it — a Zotero, Mendeley, JabRef or
Google Scholar export works as is (BibLaTeX `date`, `journaltitle` and `location` too). Cite with
Pandoc's syntax above, or press ⌘⇧K to search the bibliography and insert one. The bibliography page lists the works you cite (all of them until you cite
one), with accents, `{Braces}` and `\emph{}` understood, and same-author-same-year works told apart
as 2001a / 2001b. *Design ▸ Notes & flow ▸ Citations* chooses the style for the whole book:

* **Author–date** (Chicago author–date): (Arendt 1958, 7–9) and an alphabetical reference list.
* **Numeric**: [1, 7–9], numbered in order of first citation.
* **Notes** (Chicago notes–bibliography): each citation becomes a footnote — a full note the first
  time a work is cited in a chapter, a short note after. Citations inside your own footnotes are
  set in place.

A key missing from the bibliography shows in red. Citations come out right in every export.

### Mathematics

`$…$` is inline and `$$…$$` display math, in LaTeX syntax, set as MathML (a dollar followed by a
space or a digit after the closing one — “$5 and $10” — stays a dollar). The maths engine loads only
for books that contain math. Errors show in red, with the message on hover.

### Keyboard

| Keys | |
|---|---|
| ⌘B / ⌘I / ⌘K | bold / italic / link |
| ⌘S | save now (it already saved) |
| ⌘F | find & replace in the whole book (match case, whole words, regular expressions) |
| ⌘⇧K | insert a citation: search your bibliography by author, year, title or key |
| ⌘⇧F | focus mode (Esc to leave) |
| ⌘\\ | show/hide the sidebar |
| Return in a list or quote | continues it; Return on an empty item ends it |
| Tab / ⇧Tab in a list | indent / outdent |
| Reading mode | ← → Space PageUp PageDown Home End, Esc to close |

Click anywhere on a page in the preview to jump to that paragraph in the editor.

## Design

Six templates, each a folder of **JSON settings + CSS** (`src/templates/<id>/`):

* **Classic Leather** — the flagship, after the `demo.tex` prototype: 6 × 9 in, mirrored margins
  (0.95/0.8/0.9/1.0 in), Cardo 11 pt, real small caps and old-style figures, ink `#1E1A16` and
  rubric `#7A1E1E`, double-rule title page with corner flourishes, openings a third down the page,
  3-line drop caps with the first words in small caps, centred spaced-capital running heads.
* **Modern Literary** — Crimson Pro, 5.5 × 8.5, big chapter numerals, flush-left openings.
* **Manuscript** — standard submission format: Letter, 12 pt, double-spaced, 1 in margins, ragged
  right, `Surname / TITLE / page` header, word count on the cover page.
* **Ornate Victorian** — Libre Baskerville, ruled running heads, scrollwork, framed title page.
* **Pocket Edition** — 5 × 8, EB Garamond with Cormorant display, italic heads, roman numerals.
* **Scholarly Monograph** — a university-press interior: 6 × 9, EB Garamond, numbered sections
  (2.1, 2.1.1), author–date citations, page footnotes, flush-left openings, italic running heads.

*Design* adjusts everything: accent presets or any colour, ink and paper, text and display fonts
(Cardo, EB Garamond, Crimson Pro, Libre Baskerville, Cormorant — all bundled, all offline), size,
line spacing, indent, justification, hyphenation, page size (5 × 8, 5.5 × 8.5, 6 × 9, A5, Letter),
margins, two-sided layout, where chapters start and how far down, chapter/part labels, drop caps,
small-cap lead-ins, ornament sets, scene breaks, running heads and folios, heading roles, footnote
placement, citation style, section numbering, widows/orphans, and custom CSS. *Save as new template* keeps it for every book; templates
export and import as `.json`.

## Export

* **PDF** — print-ready, the exact preview pages at trim size with embedded fonts, through the
  browser's print engine (choose *Save as PDF* in Chrome). Optional ⅛″ bleed (outside, top, bottom).
* **EPUB 3** — reflowable, fonts embedded, nav, popup footnotes, images, MathML.
* **DOCX** — Word styles, real footnotes (citation notes included), lists, tables, images, Word
  drop caps, page setup. Math is kept as its TeX source.
* **HTML** — one self-contained file (fonts and images inside).
* **Markdown** — the whole book in one `.md` with front matter (a `.zip` if it has images);
  citations stay as `[@key]` and the bibliography as a `bibtex` block, ready for Pandoc.

## Performance

Measured with Chromium's CPU throttled 4× (≈ a 2018 MacBook Air) on a 120,000-word, 350-page book
(`node tests/e2e/perf.cjs 4`): whole book typeset in ~2.5 s; keystroke latency median 16 ms,
95th percentile 24 ms, worst 32 ms (one frame); after you pause, only the edited chapter is
re-paginated (~70 ms, in slices that yield to typing). At 6× throttle: worst keystroke 56 ms.

The app is ~105 KB of gzipped JavaScript plus ~1 MB of fonts, all cached for offline use; the maths
engine (60 KB) loads only for books with math.

## Development

```bash
npm run dev        # live-reloading dev server
npm run build      # type-check and build to dist/
npm test           # unit tests (Node's built-in runner)
npm run e2e        # browser tests against `npm run preview` (needs Playwright installed)
```

Architecture, the PWA-vs-Tauri decision and the custom paginator are explained in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Fonts

Math is set in the system's maths font (STIX Two Math on macOS, Cambria Math on Windows).
Cardo, EB Garamond, Crimson Pro, Libre Baskerville and Cormorant are licensed under the
[SIL Open Font License 1.1](public/fonts/licenses/) and bundled, subset to Latin with all OpenType
features kept.
