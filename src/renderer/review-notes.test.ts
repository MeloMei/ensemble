import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffLines, diffPosition, diffRangeAtRow, diffRangeLines, nextDiffPosition, reviewFeedback, reviewNoteSchema } from './review-notes';

test('diff notes retain actual scope, old-side deletions and quote-safe user text', () => {
  const lines = diffLines('Staged changes\ndiff --git a/a b/a\n@@ -2,2 +4,2 @@\n-old\n+new\n same\nWorking tree changes\ndiff --git a/a b/a\n@@ -8 +9 @@\n+working');
  assert.deepEqual(lines.filter(line => line.kind === 'removed').map(line => [line.scope, line.oldLine, line.newLine]), [['staged', 2, undefined]]);
  assert.deepEqual(lines.filter(line => line.kind === 'added').map(line => [line.scope, line.newLine]), [['staged', 4], ['working', 9]]);
  const prompt = reviewFeedback([{ id: 'note', filePath: 'a.ts', lineNumber: 2, body: 'quote " and\nnewline',
    scope: 'staged', side: 'original', revision: 'abc', createdAt: 'now' }]);
  assert.match(prompt, /Line: 2/); assert.match(prompt, /side: original/); assert.match(prompt, /quote \\" and\\nnewline/);
});

test('diff ranges keep contiguous numbers on one side and stop at the hunk boundary', () => {
  const lines = diffLines([
    'Staged changes', 'diff --git a/a b/a', '@@ -4,3 +8,3 @@', ' first', '-old', '+new', ' last',
    '@@ -20 +30 @@', '-another', '+different', 'Working tree changes', 'diff --git a/a b/a', '@@ -4 +8 @@', '-work', '+tree',
  ].join('\n'));
  const original = diffPosition(lines[3], 3, 'original')!;
  const modified = diffPosition(lines[6], 6, 'modified')!;
  const range = diffRangeAtRow(lines, original, 14);
  assert.deepEqual(diffRangeLines(range), { startLine: 4, lineNumber: 6 });
  assert.equal(range.end.scope, 'staged');
  assert.equal(range.end.side, 'original');
  assert.equal(nextDiffPosition(lines, range.end, 1), undefined);
  assert.equal(diffPosition(lines[5], 5, 'original'), undefined);
  assert.deepEqual(diffRangeLines(diffRangeAtRow(lines, modified, 3)), { startLine: 8, lineNumber: 10 });
  const note = reviewNoteSchema.parse({ id: 'range', filePath: 'a.ts', ...diffRangeLines(range), body: 'check all three',
    scope: range.anchor.scope, side: range.anchor.side, revision: 'abc', createdAt: 'now' });
  assert.match(reviewFeedback([note]), /File: a\.ts\nLines: 4-6\nUser comment: "check all three"\nDiff: staged; side: original; revision: abc/);
  assert.equal(reviewNoteSchema.safeParse({ ...note, startLine: 7 }).success, false);
});
