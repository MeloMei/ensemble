import { z } from 'zod';
import { translate } from '../shared/i18n';
import { formatDiffComments } from './vendor/orca/diff-comments-format';

export interface DiffComment { filePath: string; lineNumber: number; startLine?: number; body: string; source?: 'diff' | 'markdown' }
export const reviewNoteSchema = z.object({
  id: z.string(), filePath: z.string(), lineNumber: z.number().int().positive(), body: z.string().min(1).max(10_000),
  scope: z.enum(['staged', 'working']), side: z.enum(['original', 'modified']), revision: z.string(), createdAt: z.string(),
});
export type ReviewNote = z.infer<typeof reviewNoteSchema>;
export interface DiffLine { text: string; oldLine?: number; newLine?: number; scope: 'staged' | 'working'; kind: 'added' | 'removed' | 'context' | 'header' }

export function diffLines(patch: string): DiffLine[] {
  let oldLine: number | undefined; let newLine: number | undefined;
  let scope: DiffLine['scope'] = 'working';
  return patch.split('\n').map(text => {
    if (text === 'Staged changes') scope = 'staged';
    if (text === 'Working tree changes') scope = 'working';
    if (text === 'Working tree changes' || text.startsWith('diff --git')) { oldLine = undefined; newLine = undefined; }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); return { text, scope, kind: 'header' }; }
    if (oldLine !== undefined && newLine !== undefined) {
      if (text.startsWith('+')) return { text, scope, kind: 'added', newLine: newLine++ };
      if (text.startsWith('-')) return { text, scope, kind: 'removed', oldLine: oldLine++ };
      if (text.startsWith(' ')) return { text, scope, kind: 'context', oldLine: oldLine++, newLine: newLine++ };
    }
    return { text, scope, kind: 'header' };
  });
}

export function reviewFeedback(notes: ReviewNote[]): string {
  return `${translate('workspace:files.feedbackPrompt')}\n\n${notes.map(note =>
    `${formatDiffComments([note])}\nDiff: ${note.scope}; side: ${note.side}; revision: ${note.revision}`).join('\n\n')}`;
}
