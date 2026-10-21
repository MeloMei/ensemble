// Adapted import only from Orca 36913fd4f556c44495ed6da5cd6a81910c3cde21, src/shared/diff-comments-format.ts.
// Copyright (c) 2026 Lovecast Inc. MIT; see licenses/Orca-MIT.txt.
import type { DiffComment } from '../../review-notes'

function isMarkdownComment(comment: Pick<DiffComment, 'source'>): boolean {
  return comment.source === 'markdown'
}

// Why: the pasted format is the contract between review notes and whichever
// agent consumes them. Keep it deterministic and quote-safe across clients.
export function formatDiffComment(c: DiffComment): string {
  const escaped = c.body
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
  const locationLabel =
    c.lineNumber === 0
      ? 'Scope: file'
      : c.startLine !== undefined && c.startLine !== c.lineNumber
        ? `Lines: ${c.startLine}-${c.lineNumber}`
        : `Line: ${c.lineNumber}`
  if (!isMarkdownComment(c)) {
    return [`File: ${c.filePath}`, locationLabel, `User comment: "${escaped}"`].join('\n')
  }
  return [
    `File: ${c.filePath}`,
    'Source: markdown',
    locationLabel,
    `User comment: "${escaped}"`
  ].join('\n')
}

export function formatDiffComments(comments: readonly DiffComment[]): string {
  return comments.map(formatDiffComment).join('\n\n')
}
