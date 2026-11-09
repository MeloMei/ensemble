import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

const storageKey = 'ensemble.file-pane-width';
const defaultWidth = 320;
const minWidth = 280;
const maxWidth = 640;
const minCenterWidth = 560;
const keyboardStep = 24;

function clampWidth(width: number, limit: number) {
  return Math.round(Math.min(Math.max(width, minWidth), limit));
}

function readWidth(): number | undefined {
  try {
    const value = Number(localStorage.getItem(storageKey));
    return Number.isFinite(value) && value >= minWidth && value <= maxWidth ? value : undefined;
  } catch { return undefined; }
}

export function useWorkspaceFilePane(enabled: boolean) {
  const id = useId();
  const columns = useRef<HTMLDivElement>(null);
  const [requested, setRequested] = useState(true);
  const [preferredWidth, setPreferredWidth] = useState(readWidth);
  const [space, setSpace] = useState({ width: Infinity, defaultWidth });
  useLayoutEffect(() => {
    const element = columns.current;
    if (!enabled || !element) return;
    const measure = (width: number) => {
      const cssWidth = Number.parseFloat(getComputedStyle(element).getPropertyValue('--file-width')) || defaultWidth;
      const measured = Math.floor(width);
      setSpace(current => current.width === measured && current.defaultWidth === cssWidth
        ? current : { width: measured, defaultWidth: cssWidth });
    };
    measure(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled]);

  const available = Math.min(maxWidth, space.width - minCenterWidth);
  const tooNarrow = available < minWidth;
  const limit = Math.max(minWidth, available);
  const rememberWidth = (width: number) => {
    setPreferredWidth(width);
    try { localStorage.setItem(storageKey, String(width)); }
    catch { /* The current window still keeps the preference. */ }
  };
  return { id, columns, requested, setRequested, tooNarrow, visible: requested && !tooNarrow,
    width: clampWidth(preferredWidth ?? space.defaultWidth, limit), limit, rememberWidth };
}

export function WorkspaceFilePane({ id, visible, width, limit, onResize, children }: {
  id: string;
  visible: boolean;
  width: number;
  limit: number;
  onResize: (width: number) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation('shell');
  const pane = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [dragWidth, setDragWidth] = useState<number>();
  const currentWidth = clampWidth(dragWidth ?? width, limit);
  const style = { width: visible ? currentWidth : 0, '--file-width': `${currentWidth}px` } as CSSProperties;

  useLayoutEffect(() => {
    if (visible) return;
    if (pane.current?.contains(document.activeElement)) document.getElementById(`${id}-toggle`)?.focus({ preventScroll: true });
    if (drag.current) {
      drag.current = null;
      setDragWidth(undefined);
    }
  }, [id, visible]);

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || drag.current) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: currentWidth };
    setDragWidth(currentWidth);
  };
  const widthAtPointer = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    return clampWidth(start.startWidth + start.startX - event.clientX, limit);
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const next = widthAtPointer(event);
    if (next !== undefined) setDragWidth(next);
  };
  const finishDrag = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const next = widthAtPointer(event);
    drag.current = null;
    setDragWidth(undefined);
    if (visible && commit && next !== undefined && event.clientX !== start.startX && next !== start.startWidth) onResize(next);
  };
  const resizeByKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (drag.current) return;
    let next: number;
    switch (event.key) {
      case 'ArrowLeft': next = currentWidth + keyboardStep; break;
      case 'ArrowRight': next = currentWidth - keyboardStep; break;
      case 'Home': next = minWidth; break;
      case 'End': next = limit; break;
      default: return;
    }
    event.preventDefault();
    next = clampWidth(next, limit);
    if (next !== currentWidth) onResize(next);
  };

  return <div ref={pane} className="file-panel-transition" style={style} inert={!visible} aria-hidden={!visible}>
    <div id={id} className="file-pane-content">{children}</div>
    <div className="split-handle file-pane-handle" role="separator" aria-label={t('app.resizeFiles')}
      aria-controls={id} aria-orientation="vertical" aria-valuemin={minWidth} aria-valuemax={limit}
      aria-valuenow={currentWidth} aria-valuetext={t('app.fileWidthPixels', { width: currentWidth })}
      tabIndex={visible ? 0 : -1} data-dragging={dragWidth !== undefined}
      onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={event => finishDrag(event, true)}
      onPointerCancel={event => finishDrag(event, false)} onLostPointerCapture={event => finishDrag(event, false)}
      onKeyDown={resizeByKey} />
  </div>;
}
