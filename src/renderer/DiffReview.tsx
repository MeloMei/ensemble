import { Fragment, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileDiff } from '../shared/types';
import type { FileReference } from './workspace-file-reference';
import {
  diffLines, diffPosition, diffRangeAtRow, diffRangeLines, diffRowForFileLine, nextDiffPosition,
  type DiffNoteDraft, type DiffPosition, type DiffRange,
} from './review-notes';

const sides = ['original', 'modified'] as const;

export function DiffReview({ diff, location, busy, draft, onDraftChange, onSave }: {
  diff: FileDiff;
  location?: FileReference;
  busy: boolean;
  draft?: DiffNoteDraft;
  onDraftChange: (draft: DiffNoteDraft | undefined) => void;
  onSave: (draft: DiffNoteDraft) => void;
}) {
  const { t } = useTranslation('workspace');
  const hintId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const locatedLine = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ pointerId: number; range: DiffRange } | null>(null);
  const [preview, setPreview] = useState<DiffRange>();
  const lines = useMemo(() => diff.binary ? [] : diffLines(diff.patch), [diff.binary, diff.patch]);
  const canAnnotate = Boolean(diff.revision && !diff.binary && !diff.truncated);
  const current = canAnnotate && draft?.revision === diff.revision ? draft : undefined;
  const range = preview ?? current?.range;
  const inlineRow = current ? Math.max(current.range.anchor.row, current.range.end.row) : undefined;
  const referenceLine = location?.path === diff.path ? location.line : undefined;
  const referenceRow = referenceLine === undefined || diff.truncated ? undefined : diffRowForFileLine(lines, referenceLine);
  useLayoutEffect(() => {
    locatedLine.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [referenceRow, location]);

  const select = (range: DiffRange) => {
    if (!canAnnotate || busy || !diff.revision) return;
    onDraftChange({ revision: diff.revision, range, body: draft?.body ?? '' });
  };
  const focusPosition = ({ row, side }: DiffPosition) =>
    scroller.current?.querySelector<HTMLButtonElement>(`[data-diff-row="${row}"] button[data-side="${side}"]`)?.focus();
  const start = (event: PointerEvent<HTMLButtonElement>, point: DiffPosition) => {
    if (event.button !== 0 || !event.isPrimary || gesture.current) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const range = { anchor: point, end: point };
    gesture.current = { pointerId: event.pointerId, range };
    setPreview(range);
  };
  const rangeAtPointer = (event: PointerEvent<HTMLDivElement>, range: DiffRange): DiffRange => {
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-diff-row]');
    return row && scroller.current?.contains(row) ? diffRangeAtRow(lines, range.anchor, Number(row.dataset.diffRow)) : range;
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const range = rangeAtPointer(event, active.range);
    if (range.end.row === active.range.end.row) return;
    active.range = range;
    setPreview(range);
  };
  const finish = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    gesture.current = null;
    setPreview(undefined);
    if (commit) {
      const range = rangeAtPointer(event, active.range);
      select(range);
      focusPosition(range.end);
    }
  };
  const extendByKey = (event: KeyboardEvent<HTMLButtonElement>, point: DiffPosition) => {
    if (!event.shiftKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || gesture.current) return;
    event.preventDefault();
    const selection = current?.range;
    const anchor = selection?.end.row === point.row && selection.end.side === point.side ? selection.anchor : point;
    const end = nextDiffPosition(lines, point, event.key === 'ArrowUp' ? -1 : 1);
    if (!end) return;
    select({ anchor, end });
    focusPosition(end);
  };

  const editor = (note: DiffNoteDraft, outdated: boolean) => {
    const { anchor } = note.range;
    const { startLine, lineNumber } = diffRangeLines(note.range);
    const location = startLine !== undefined
      ? t('files.noteRange', { side: t(`files.side.${anchor.side}`), start: startLine, end: lineNumber })
      : t(anchor.side === 'original' ? 'files.originalLine' : 'files.modifiedLine', { line: lineNumber });
    return <form className="review-note-editor" onSubmit={event => {
      event.preventDefault();
      if (!outdated && !busy && note.body.trim()) onSave(note);
    }}>
      <label>{t(`files.scope.${anchor.scope}`)} · {location}
        <textarea aria-label={t('files.lineNote')} value={note.body} maxLength={10_000}
          disabled={busy} onChange={event => onDraftChange({ ...note, body: event.target.value })} />
      </label>
      {outdated && <p className="review-diff-hint" role="status">{t('files.noteSelectionOutdated')}</p>}
      <button type="submit" disabled={outdated || busy || !note.body.trim()}>{t('files.saveNote')}</button>
      <button type="button" disabled={busy} onClick={() => onDraftChange(undefined)}>
        {t(note.body.trim() ? 'files.discardNoteDraft' : 'common.cancel')}
      </button>
    </form>;
  };

  return <>
    {diff.binary ? <div className="pane-note">{t('files.binaryDiff')}</div>
      : <div ref={scroller} className="review-diff" aria-label={t('files.annotatedDiff')}
        onPointerMove={move} onPointerUp={event => finish(event, true)}
        onPointerCancel={event => finish(event, false)} onLostPointerCapture={event => finish(event, false)}>
        {canAnnotate && lines.some(line => line.hunk !== undefined) && <p id={hintId} className="review-diff-hint">{t('files.selectDiffLines')}</p>}
        {referenceLine !== undefined && !diff.truncated && referenceRow === undefined &&
          <p className="review-diff-hint" role="status">{t('files.referenceLineOutsideDiff', { line: referenceLine })}</p>}
        {lines.map((line, row) => {
          const points = sides.map(side => diffPosition(line, row, side));
          const selected = range && row >= Math.min(range.anchor.row, range.end.row) && row <= Math.max(range.anchor.row, range.end.row)
            ? points.find(point => point?.side === range.anchor.side && point.hunk === range.anchor.hunk) : undefined;
          return <Fragment key={row}>
            <div className={`review-diff-line ${line.kind}`} data-diff-row={row} data-selected={selected ? '' : undefined}
              data-reference={row === referenceRow || undefined} ref={row === referenceRow ? locatedLine : undefined}>
              <div className="review-diff-gutter">{points.map((point, index) => !point || !canAnnotate
                ? <span key={sides[index]}>{point?.line}</span>
                : <button key={point.side} type="button" data-side={point.side}
                  aria-label={t('files.annotateLine', { scope: t(`files.scope.${point.scope}`), side: t(`files.side.${point.side}`), line: point.line })}
                  aria-describedby={hintId} aria-pressed={selected?.side === point.side} disabled={busy}
                  onPointerDown={event => start(event, point)} onKeyDown={event => extendByKey(event, point)}
                  onClick={event => { if (event.detail === 0) select({ anchor: point, end: point }); }}>{point.line}</button>)}
              </div>
              <code>{line.text || ' '}</code>
            </div>
            {current && inlineRow === row && editor(current, false)}
          </Fragment>;
        })}
      </div>}
    {diff.truncated && <p className="pane-note">{t('files.truncatedDiff')}</p>}
    {draft && !current && editor(draft, true)}
  </>;
}
