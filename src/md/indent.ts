/**
 * Indented lines (a tab, or two or more spaces) are set as indented lines of
 * prose, one per line — premises, numbered propositions, verse — instead of
 * CommonMark's indented code blocks (fenced code still works). Two tabs indent
 * further. An indented line also ends the paragraph above it.
 */
export function indentedLines(md: any): void {
  md.disable('code');
  md.block.ruler.before('paragraph', 'indent', (state: any, start: number, end: number, silent: boolean) => {
    if (state.parentType === 'list') return false;
    const cols = (l: number) => state.sCount[l] - state.blkIndent;
    const emit = (from: number, to: number, cls: string) => {
      const open = state.push('paragraph_open', 'p', 1);
      open.map = [from, to];
      if (cls) open.attrSet('class', cls);
      const inline = state.push('inline', '', 0);
      inline.content = state.getLines(from, to, state.blkIndent, false).trim();
      inline.map = [from, to];
      inline.children = [];
      state.push('paragraph_close', 'p', -1);
    };
    let line = start;
    if (cols(start) >= 2) {
      if (silent) return true;
      for (; line < end && !state.isEmpty(line) && cols(line) >= 2; line++) emit(line, line + 1, `ind ind${Math.min(4, Math.max(1, Math.round(cols(line) / 4)))}`);
    } else {
      // A paragraph that runs into an indented line ends there (CommonMark would make it a lazy continuation).
      const terminators = state.md.block.ruler.getRules('paragraph');
      for (line = start + 1; line < end && !state.isEmpty(line) && cols(line) < 2; line++) {
        if (cols(line) >= 0 && terminators.some((r: any) => r(state, line, end, true))) return false;
      }
      if (line >= end || state.isEmpty(line) || silent) return false;
      emit(start, line, '');
    }
    state.line = line;
    return true;
  });
}
