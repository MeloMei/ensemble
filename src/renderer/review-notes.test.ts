import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffLines, reviewFeedback } from './review-notes';

test('diff notes retain actual scope, old-side deletions and quote-safe user text', () => {
  const lines = diffLines('Staged changes\ndiff --git a/a b/a\n@@ -2,2 +4,2 @@\n-old\n+new\n same\nWorking tree changes\ndiff --git a/a b/a\n@@ -8 +9 @@\n+working');
  assert.deepEqual(lines.filter(line => line.kind === 'removed').map(line => [line.scope, line.oldLine, line.newLine]), [['staged', 2, undefined]]);
  assert.deepEqual(lines.filter(line => line.kind === 'added').map(line => [line.scope, line.newLine]), [['staged', 4], ['working', 9]]);
  const prompt = reviewFeedback([{ id: 'note', filePath: 'a.ts', lineNumber: 2, body: 'quote " and\nnewline',
    scope: 'staged', side: 'original', revision: 'abc', createdAt: 'now' }]);
  assert.match(prompt, /Line: 2/); assert.match(prompt, /side: original/); assert.match(prompt, /quote \\" and\\nnewline/);
});
