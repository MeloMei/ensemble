import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { usePaneResize } from './ui-kit/usePaneResize';

const storageKey = 'ensemble.sidebar-layout';
const minWidth = 190;
const maxWidth = 420;
const minMainWidth = 720;
const defaultLayout = { width: 220, collapsed: false };

function readLayout() {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (value && Number.isInteger(value.width) && value.width >= minWidth && value.width <= maxWidth && typeof value.collapsed === 'boolean') {
      return { width: value.width as number, collapsed: value.collapsed as boolean };
    }
  } catch { /* A new window still works without saved preferences. */ }
  return defaultLayout;
}

export function useWorkspaceSidebar() {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState(readLayout);
  const [limit, setLimit] = useState(maxWidth);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = (width: number) => setLimit(Math.max(minWidth, Math.min(maxWidth, Math.floor(width) - minMainWidth)));
    measure(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const save = (value: typeof layout) => {
    setLayout(value);
    try { localStorage.setItem(storageKey, JSON.stringify(value)); }
    catch { /* The current window still keeps the preference. */ }
  };
  const { currentWidth, handle } = usePaneResize({
    width: layout.width, min: minWidth, max: limit, side: 'left', visible: !layout.collapsed,
    onResize: width => save({ ...layout, width }),
  });
  const toggle = () => {
    if (!layout.collapsed && document.getElementById(id)?.contains(document.activeElement)) {
      document.getElementById(`${id}-toggle`)?.focus({ preventScroll: true });
    }
    save({ ...layout, collapsed: !layout.collapsed });
  };
  return { id, container, collapsed: layout.collapsed, toggle, currentWidth, handle };
}

export function WorkspaceSidebar({ layout, children }: { layout: ReturnType<typeof useWorkspaceSidebar>; children: ReactNode }) {
  const { t } = useTranslation('shell');
  return <aside id={layout.id} className="workspace-sidebar" hidden={layout.collapsed} style={{ width: layout.currentWidth }}>
    {children}
    <div {...layout.handle} className="split-handle sidebar-resize-handle" aria-label={t('app.resizeSidebar')}
      aria-controls={layout.id} aria-valuetext={t('app.paneWidthPixels', { width: layout.currentWidth })} />
  </aside>;
}
