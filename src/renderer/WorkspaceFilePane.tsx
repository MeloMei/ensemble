import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { usePaneResize } from './ui-kit/usePaneResize';

const storageKey = 'ensemble.file-pane-width';
const defaultWidth = 320;
const minWidth = 280;
const maxWidth = 640;
const minCenterWidth = 560;

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
    width: preferredWidth ?? space.defaultWidth, limit, rememberWidth };
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
  const { currentWidth, handle } = usePaneResize({ width, min: minWidth, max: limit, side: 'right', visible, onResize });
  const style = { width: visible ? currentWidth : 0, '--file-width': `${currentWidth}px` } as CSSProperties;

  useLayoutEffect(() => {
    if (!visible && pane.current?.contains(document.activeElement)) document.getElementById(`${id}-toggle`)?.focus({ preventScroll: true });
  }, [id, visible]);

  return <div ref={pane} className="file-panel-transition" style={style} inert={!visible} aria-hidden={!visible}>
    <div id={id} className="file-pane-content">{children}</div>
    <div {...handle} className="split-handle file-pane-handle" aria-label={t('app.resizeFiles')}
      aria-controls={id} aria-valuetext={t('app.paneWidthPixels', { width: currentWidth })} />
  </div>;
}
