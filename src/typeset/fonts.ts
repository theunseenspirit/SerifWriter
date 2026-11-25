import type { FontId } from '../model/types.ts';

// Bundled SIL OFL fonts, subset to Latin with every OpenType feature kept
// (small caps, old-style figures, ligatures). Family names are prefixed so a
// locally installed copy of the same font can never change the typesetting.

interface Face { file: string; weight: string; style: 'normal' | 'italic' }
export interface FontInfo {
  id: FontId;
  name: string;
  family: string;
  faces: Face[];
  smallCaps: boolean; // real `smcp` small capitals
  oldstyle: boolean; // `onum` figures
  capHeight: number;
  note: string;
}

export const FONTS: Record<FontId, FontInfo> = {
  cardo: {
    id: 'cardo', name: 'Cardo', family: 'SW Cardo', smallCaps: true, oldstyle: true, capHeight: 0.688,
    note: 'Bembo-like old style; the Classic Leather face.',
    faces: [
      { file: 'cardo-regular.woff2', weight: '400', style: 'normal' },
      { file: 'cardo-italic.woff2', weight: '400', style: 'italic' },
      { file: 'cardo-bold.woff2', weight: '700', style: 'normal' },
    ],
  },
  ebgaramond: {
    id: 'ebgaramond', name: 'EB Garamond', family: 'SW EB Garamond', smallCaps: true, oldstyle: true, capHeight: 0.65,
    note: 'Claude Garamont’s 16th-century roman, with true small caps.',
    faces: [
      { file: 'ebgaramond-roman.woff2', weight: '400 800', style: 'normal' },
      { file: 'ebgaramond-italic.woff2', weight: '400 800', style: 'italic' },
    ],
  },
  crimsonpro: {
    id: 'crimsonpro', name: 'Crimson Pro', family: 'SW Crimson Pro', smallCaps: false, oldstyle: true, capHeight: 0.573,
    note: 'A contemporary book face; small caps are simulated.',
    faces: [
      { file: 'crimsonpro-roman.woff2', weight: '200 900', style: 'normal' },
      { file: 'crimsonpro-italic.woff2', weight: '200 900', style: 'italic' },
    ],
  },
  librebaskerville: {
    id: 'librebaskerville', name: 'Libre Baskerville', family: 'SW Libre Baskerville', smallCaps: false, oldstyle: false, capHeight: 0.77,
    note: 'Broad 18th-century transitional; set it a size smaller.',
    faces: [
      { file: 'librebaskerville-roman.woff2', weight: '400 700', style: 'normal' },
      { file: 'librebaskerville-italic.woff2', weight: '400 700', style: 'italic' },
    ],
  },
  cormorant: {
    id: 'cormorant', name: 'Cormorant', family: 'SW Cormorant', smallCaps: true, oldstyle: true, capHeight: 0.625,
    note: 'A display Garamond — beautiful for titles, delicate for text.',
    faces: [
      { file: 'cormorant-roman.woff2', weight: '300 700', style: 'normal' },
      { file: 'cormorant-italic.woff2', weight: '300 700', style: 'italic' },
    ],
  },
};

export const FONT_IDS = Object.keys(FONTS) as FontId[];

export function fontUrl(file: string): string {
  return new URL(`fonts/${file}`, document.baseURI).href;
}

let injected = false;
export function injectFontFaces(): void {
  if (injected) return;
  injected = true;
  const css = Object.values(FONTS)
    .flatMap((f) => f.faces.map((face) => `@font-face{font-family:"${f.family}";src:url("${fontUrl(face.file)}") format("woff2");font-weight:${face.weight};font-style:${face.style};font-display:block;}`))
    .join('\n');
  const style = document.createElement('style');
  style.id = 'sw-fonts';
  style.textContent = css;
  document.head.appendChild(style);
}

// Symbols the Latin subsets lack (∀ ¬ □ ⊢) fall back to a serif symbol font rather than whatever the system picks.
export const SYMBOL_FALLBACK = '"STIX Two Text", "STIX Two Math", "Cambria Math", "Segoe UI Symbol"';
export const fontStack = (id: FontId) => `"${FONTS[id].family}", "${FONTS[id].name}", Georgia, ${SYMBOL_FALLBACK}, serif`;

/** Waits until the faces a template uses are loaded, so measurements are final. */
export async function ensureFonts(ids: FontId[]): Promise<void> {
  injectFontFaces();
  const loads: Promise<unknown>[] = [];
  for (const id of new Set(ids)) {
    const f = FONTS[id];
    if (!f) continue;
    for (const spec of ['400 12px', 'italic 400 12px', '700 12px']) loads.push(document.fonts.load(`${spec} "${f.family}"`).catch(() => undefined));
  }
  await Promise.all(loads);
}
