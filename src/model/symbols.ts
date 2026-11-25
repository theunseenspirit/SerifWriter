// Symbols for logic, philosophy and mathematics in running prose. Type the
// LaTeX name (\forall, \to, \Box…) and a space or punctuation, or pick one from
// the palette (⌘⇧L). Whole formulas are better written as math: $\forall x\,Fx$.

export const SYMBOLS: [name: string, char: string, label: string][] = [
  ['neg', '¬', 'not'], ['lnot', '¬', 'not'], ['wedge', '∧', 'and'], ['land', '∧', 'and'], ['vee', '∨', 'or'], ['lor', '∨', 'or'],
  ['to', '→', 'if … then (conditional)'], ['rightarrow', '→', 'conditional'], ['supset', '⊃', 'horseshoe conditional'],
  ['leftrightarrow', '↔', 'if and only if'], ['iff', '↔', 'if and only if'], ['equiv', '≡', 'equivalent'],
  ['Rightarrow', '⇒', 'implies'], ['Leftrightarrow', '⇔', 'equivalent (meta)'], ['oplus', '⊕', 'exclusive or'],
  ['forall', '∀', 'for all'], ['exists', '∃', 'there exists'], ['nexists', '∄', 'there is no'],
  ['Box', '□', 'necessarily'], ['Diamond', '◇', 'possibly'], ['boxright', '□→', 'counterfactual'],
  ['vdash', '⊢', 'proves'], ['nvdash', '⊬', 'does not prove'], ['models', '⊨', 'entails'], ['nmodels', '⊭', 'does not entail'],
  ['therefore', '∴', 'therefore'], ['because', '∵', 'because'], ['bot', '⊥', 'falsum, contradiction'], ['top', '⊤', 'verum'],
  ['in', '∈', 'member of'], ['notin', '∉', 'not a member of'], ['subset', '⊂', 'proper subset'], ['subseteq', '⊆', 'subset'],
  ['cup', '∪', 'union'], ['cap', '∩', 'intersection'], ['emptyset', '∅', 'empty set'], ['setminus', '∖', 'set difference'],
  ['neq', '≠', 'not equal'], ['leq', '≤', 'at most'], ['geq', '≥', 'at least'], ['approx', '≈', 'approximately'],
  ['times', '×', 'times, product'], ['circ', '∘', 'composition'], ['infty', '∞', 'infinity'], ['aleph', 'ℵ', 'aleph'],
  ['ulcorner', '⌜', 'Quine quote, left'], ['urcorner', '⌝', 'Quine quote, right'], ['langle', '⟨', 'angle bracket, left'], ['rangle', '⟩', 'angle bracket, right'],
  ['vDash', '⊨', 'entails'], ['Vdash', '⊩', 'forces'], ['mid', '∣', 'such that'], ['dagger', '†', 'dagger'], ['S', '§', 'section'], ['P', '¶', 'paragraph'],
  ['alpha', 'α', ''], ['beta', 'β', ''], ['gamma', 'γ', ''], ['delta', 'δ', ''], ['epsilon', 'ε', ''], ['theta', 'θ', ''], ['lambda', 'λ', ''],
  ['mu', 'μ', ''], ['pi', 'π', ''], ['sigma', 'σ', ''], ['tau', 'τ', ''], ['phi', 'φ', ''], ['psi', 'ψ', ''], ['omega', 'ω', ''],
  ['Gamma', 'Γ', ''], ['Delta', 'Δ', ''], ['Sigma', 'Σ', ''], ['Phi', 'Φ', ''], ['Psi', 'Ψ', ''], ['Omega', 'Ω', ''],
];

export const SYMBOL_BY_NAME = new Map(SYMBOLS.map(([n, c]) => [n, c]));
/** Prefix operators are written tight (∀x, ¬p, □p): like TeX, the space after their name is swallowed. */
export const PREFIX = new Set(['forall', 'exists', 'nexists', 'neg', 'lnot', 'Box', 'Diamond']);

/**
 * If the text just before the caret is a known \name (not escaped, not inside
 * $math$ or `code` on this paragraph), returns where it starts and its symbol.
 */
export function symbolBefore(text: string, caret: number): { start: number; char: string; prefix: boolean } | null {
  const m = /(^|[^\\])\\([A-Za-z]+)$/.exec(text.slice(Math.max(0, caret - 40), caret));
  const char = m && SYMBOL_BY_NAME.get(m[2]);
  if (!m || !char) return null;
  const para = text.slice(text.lastIndexOf('\n\n', caret - 1) + 1, caret);
  const odd = (re: RegExp) => (para.match(re) || []).length % 2 === 1;
  if (odd(/(?<!\\)\$\$?/g) || odd(/`/g)) return null; // $$ counts once
  return { start: caret - m[2].length - 1, char, prefix: PREFIX.has(m[2]) };
}
