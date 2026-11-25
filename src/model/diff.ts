// Paragraph-level diff (LCS) for the version history view.

export type DiffOp = { type: 'same' | 'add' | 'del'; text: string };

export function paragraphs(text: string): string[] {
  return text.replace(/\r/g, '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

export function diffParagraphs(oldText: string, newText: string): DiffOp[] {
  const a = paragraphs(oldText);
  const b = paragraphs(newText);
  // Trim common head/tail so the quadratic part is small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const head: DiffOp[] = a.slice(0, start).map((text) => ({ type: 'same', text }));
  const tail: DiffOp[] = a.slice(endA).map((text) => ({ type: 'same', text }));
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  const n = A.length;
  const m = B.length;
  const mid: DiffOp[] = [];
  if (n * m > 4_000_000) {
    for (const t of A) mid.push({ type: 'del', text: t });
    for (const t of B) mid.push({ type: 'add', text: t });
    return [...head, ...mid, ...tail];
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { mid.push({ type: 'same', text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) mid.push({ type: 'del', text: A[i++] });
    else mid.push({ type: 'add', text: B[j++] });
  }
  while (i < n) mid.push({ type: 'del', text: A[i++] });
  while (j < m) mid.push({ type: 'add', text: B[j++] });
  return [...head, ...mid, ...tail];
}
