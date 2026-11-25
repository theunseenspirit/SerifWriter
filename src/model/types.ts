// Core data model. Everything here is stored as-is in IndexedDB.

export type SectionKind =
  | 'title'
  | 'copyright'
  | 'dedication'
  | 'epigraph'
  | 'toc'
  | 'part'
  | 'chapter'
  | 'section' // unnumbered chapter: preface, introduction, afterword, acknowledgements…
  | 'about'
  | 'bibliography' // BibTeX, set as the reference list
  | 'index'; // generated from {^term} marks

export interface CursorState {
  start: number;
  end: number;
  scroll: number;
}

export interface Section {
  id: string;
  projectId: string;
  kind: SectionKind;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  words: number;
  cursor?: CursorState;
}

export interface BookMeta {
  title: string;
  subtitle: string;
  author: string;
  publisher: string;
  year: string;
  language: string;
  /** Extra front-matter keys from the title page (contact, surname, isbn…). */
  extra: Record<string, string>;
}

export interface ProjectUI {
  previewZoom?: number; // 0 = fit width
  spread?: boolean;
  sidebar?: boolean;
  preview?: boolean;
  previewWidth?: number;
  sidebarWidth?: number;
}

export interface MirrorState {
  folder: string;
  files: Record<string, string>; // sectionId -> filename written
}

export interface Project {
  id: string;
  createdAt: number;
  updatedAt: number;
  openedAt: number;
  deletedAt: number | null;
  meta: BookMeta;
  order: string[];
  templateId: string;
  overrides: DeepPartial<TemplateSettings>;
  customCss: string;
  lastSectionId: string | null;
  words: number;
  ui: ProjectUI;
  mirror?: MirrorState;
  goal?: number; // target length in words
  stats?: WritingStats;
}

/** Writing habits, recorded as you write (local only). */
export interface WritingStats {
  /** Per local day (YYYY-MM-DD): net words added, active minutes, book length at day's end. */
  days: Record<string, { w: number; m: number; t: number }>;
  /** Active minutes by hour of day, 0–23. */
  hours: number[];
  dailyGoal?: number;
}

export interface SnapshotMeta {
  id: string;
  projectId: string;
  createdAt: number;
  label: string;
  auto: boolean;
  reason?: string;
  words: number;
  hash: string;
  size: number;
}

export interface SnapshotPayload {
  project: Project;
  sections: Section[];
}

export interface Asset {
  id: string;
  projectId: string;
  name: string;
  type: string;
  blob: Blob;
  createdAt: number;
}

// ───────────────────────── Templates ─────────────────────────

export type PageSizeId = '5x8' | '5.5x8.5' | '6x9' | 'royal' | '7x10' | 'a5' | 'a4' | 'letter';
export type FontId = 'cardo' | 'ebgaramond' | 'crimsonpro' | 'librebaskerville' | 'cormorant';
export type HeadingRole = 'part' | 'chapter' | 'section' | 'subsection' | 'minor' | 'runin';
export type OrnamentSetId = 'classic' | 'victorian' | 'modern' | 'minimal' | 'none';
export type RunningHeadContent = 'title' | 'author' | 'chapter' | 'section' | 'none';
export type FolioPosition = 'bottom-center' | 'bottom-outside' | 'top-outside' | 'none';

export interface TemplateSettings {
  page: {
    size: PageSizeId;
    margins: { inside: number; outside: number; top: number; bottom: number }; // inches
    twoSided: boolean;
    headSep: number; // inches from text block top to running-head baseline
    footSkip: number; // inches from text block bottom to folio baseline
  };
  type: {
    body: FontId;
    display: FontId;
    size: number; // pt
    leading: number; // like LaTeX \linespread: 1.0 = single spacing (1.2 × size)
    justify: boolean;
    hyphenate: boolean;
    indent: number; // em
    paragraphStyle: 'indent' | 'block';
    oldstyleNums: boolean;
    abbrSmallCaps?: boolean; // NATO, UNESCO in small capitals
  };
  color: { ink: string; accent: string; paper: string };
  chapter: {
    start: 'recto' | 'any';
    sink: number; // fraction of the page height where the opening starts
    label: string; // "Chapter {Word}", "{Roman}", "" …
    partLabel: string;
    ornament: boolean;
  };
  dropCap: { enabled: boolean; lines: number };
  leadIn: { mode: 'words' | 'line' | 'none'; words: number; afterBreak: boolean };
  ornaments: OrnamentSetId;
  sceneBreak: 'ornament' | 'asterism' | 'stars' | 'hash' | 'space';
  runningHeads: {
    verso: RunningHeadContent;
    recto: RunningHeadContent;
    align: 'center' | 'outside';
    folio: FolioPosition;
    folioOnOpeners: boolean;
    manuscript: boolean; // "Surname / TITLE / page" header on every page
  };
  footnotes: 'page' | 'endnotes';
  headings: Record<'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6', HeadingRole>;
  titlePage: { layout: 'classic' | 'modern' | 'manuscript'; frame: 'double' | 'single' | 'ornate' | 'none'; corners: boolean };
  citations: 'author-date' | 'numeric' | 'note';
  numberHeadings: boolean; // 1.1-style numbers on sections and subsections
  tocDepth: number; // contents: 1 chapters, 2 + sections, 3 + subsections
  widows: number;
  orphans: number;
  hiddenKinds: SectionKind[];
}

export interface TemplateDef {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
  base: string; // id of the built-in template whose CSS this uses
  settings: TemplateSettings;
  css: string; // extra CSS (built-ins: the template stylesheet; custom: user CSS)
  accentPresets: { name: string; value: string }[];
  cover: { leather: string; foil: string; style?: 'leather' | 'cloth' | 'paper' };
  createdAt?: number;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends any[] ? T[K] : DeepPartial<T[K]>) : T[K] };
