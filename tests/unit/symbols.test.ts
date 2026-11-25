import { test } from 'node:test';
import assert from 'node:assert/strict';
import { symbolBefore } from '../../src/model/symbols.ts';

test('\\name before the caret becomes its symbol — but not in math, code, or when escaped or unknown', () => {
  const at = (s: string) => symbolBefore(s, s.length);
  assert.deepEqual(at('So \\forall'), { start: 3, char: '∀', prefix: true });
  assert.deepEqual(at('P \\to'), { start: 2, char: '→', prefix: false });
  assert.equal(at('In math $\\forall'), null);
  assert.equal(at('$$\n\\Box'), null);
  assert.deepEqual(at('$x$ then \\Box'), { start: 9, char: '□', prefix: true });
  assert.equal(at('In code `\\neg'), null);
  assert.equal(at('Escaped \\\\neg'), null);
  assert.equal(at('Unknown \\foo'), null);
  assert.deepEqual(at('$5 and $10.\n\nNow \\vdash'), { start: 17, char: '⊢', prefix: false });
});
