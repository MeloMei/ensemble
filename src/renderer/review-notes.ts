import { z } from 'zod';
import { translate } from '../shared/i18n';
import { formatDiffComments } from './vendor/orca/diff-comments-format';

export interface DiffComment { filePath: string; lineNumber: number; startLine?: number; body: string; source?: 'diff' | 'markdown' }
export const reviewNoteSchema = z.object({
  id: z.string(), filePath: z.string(), lineNumber: z.number().int().positive(), startLine: z.number().int().positive().optional(),
  body: z.string().min(1).max(10_000),
  scope: z.enum(['staged', 'working']), side: z.enum(['original', 'modified']), revision: z.string(), createdAt: z.string(),
}).refine(note => note.startLine === undefined || note.startLine <= note.lineNumber, { path: ['startLine'] });
export type ReviewNote = z.infer<typeof reviewNoteSchema>;
export interface DiffLine {
  text: string; oldLine?: number; newLine?: number; hunk?: number; scope: ReviewNote['scope'];
  kind: 'added' | 'removed' | 'context' | 'header';
}
export interface DiffPosition { row: number; line: number; side: ReviewNote['side']; scope: ReviewNote['scope']; hunk: number }
export interface DiffRange { anchor: DiffPosition; end: DiffPosition }
export interface DiffNoteDraft { revision: string; range: DiffRange; body: string }

function hunkCoordinates(text: string) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
  if (!match) return;
  return {
    oldStart: Number(match[1]), oldCount: Number(match[2] ?? 1),
    newStart: Number(match[3]), newCount: Number(match[4] ?? 1),
  };
}

export function diffLines(patch: string): DiffLine[] {
  let oldLine: number | undefined; let newLine: number | undefined;
  let hunk: number | undefined;
  let scope: DiffLine['scope'] = 'working';
  return patch.split('\n').map((text, index) => {
    if (text === 'Staged changes') scope = 'staged';
    if (text === 'Working tree changes') scope = 'working';
    const header = hunkCoordinates(text);
    if (header) {
      oldLine = header.oldStart; newLine = header.newStart; hunk = index;
    } else if (hunk !== undefined && oldLine !== undefined && newLine !== undefined) {
      if (text.startsWith('+')) return { text, scope, hunk, kind: 'added', newLine: newLine++ };
      if (text.startsWith('-')) return { text, scope, hunk, kind: 'removed', oldLine: oldLine++ };
      if (text.startsWith(' ')) return { text, scope, hunk, kind: 'context', oldLine: oldLine++, newLine: newLine++ };
      if (text.startsWith('\\ ')) return { text, scope, hunk, kind: 'header' };
      hunk = undefined;
    }
    return { text, scope, kind: 'header' };
  });
}

export function diffRowForFileLine(lines: DiffLine[], fileLine: number): number | undefined {
  const working = lines.filter(line => line.scope === 'working');
  if (working.filter(line => line.kind === 'header' && line.text.startsWith('diff --git ')).length > 1) return;
  const direct = lines.findIndex(line => line.scope === 'working' && line.newLine === fileLine);
  if (direct >= 0) return direct;

  let indexLine = fileLine;
  for (const line of working) {
    if (line.kind !== 'header') continue;
    const hunk = hunkCoordinates(line.text);
    if (!hunk) continue;
    const newAfter = hunk.newStart + Math.max(1, hunk.newCount);
    if (fileLine < newAfter) break;
    const oldAfter = hunk.oldStart + Math.max(1, hunk.oldCount);
    indexLine = fileLine + oldAfter - newAfter;
  }
  const staged = lines.filter(line => line.scope === 'staged');
  if (staged.filter(line => line.kind === 'header' && line.text.startsWith('diff --git ')).length > 1) return;
  const matches = lines.flatMap((line, row) => line.scope === 'staged' && line.newLine === indexLine ? [row] : []);
  return matches.length === 1 ? matches[0] : undefined;
}

export function diffPosition(line: DiffLine, row: number, side: ReviewNote['side']): DiffPosition | undefined {
  const number = side === 'original' ? line.oldLine : line.newLine;
  if (line.hunk !== undefined && number !== undefined && number > 0) return { row, line: number, side, scope: line.scope, hunk: line.hunk };
}

function* adjacentPositions(lines: DiffLine[], start: DiffPosition, direction: -1 | 1): Generator<DiffPosition> {
  let nextLine = start.line + direction;
  for (let row = start.row + direction; row >= 0 && row < lines.length; row += direction) {
    const line = lines[row];
    if (line.hunk !== start.hunk || line.scope !== start.scope) return;
    const point = diffPosition(line, row, start.side);
    if (!point) continue;
    if (point.line !== nextLine) return;
    yield point;
    nextLine += direction;
  }
}

export function nextDiffPosition(lines: DiffLine[], start: DiffPosition, direction: -1 | 1): DiffPosition | undefined {
  return adjacentPositions(lines, start, direction).next().value;
}

export function diffRangeAtRow(lines: DiffLine[], anchor: DiffPosition, row: number): DiffRange {
  const direction = row < anchor.row ? -1 : 1;
  let end = anchor;
  for (const position of adjacentPositions(lines, anchor, direction)) {
    if ((position.row - row) * direction > 0) break;
    end = position;
  }
  return { anchor, end };
}

export function diffRangeLines({ anchor, end }: DiffRange): Pick<ReviewNote, 'startLine' | 'lineNumber'> {
  return { lineNumber: Math.max(anchor.line, end.line),
    ...(anchor.line !== end.line ? { startLine: Math.min(anchor.line, end.line) } : {}) };
}

export function reviewFeedback(notes: ReviewNote[]): string {
  return `${translate('workspace:files.feedbackPrompt')}\n\n${notes.map(note =>
    `${formatDiffComments([note])}\nDiff: ${note.scope}; side: ${note.side}; revision: ${note.revision}`).join('\n\n')}`;
}
