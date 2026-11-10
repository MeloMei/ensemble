import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Workspace, WorkspaceSplitInput, WorkspaceSplitPlacement, WorkspaceTab } from '../shared/types';
import type { Perform } from './ui';
import './WorkspacePanes.css';

export const SESSION_TAB_DRAG_TYPE = 'application/x-ensemble-session-tab';

type Edge = 'left' | 'right' | 'top' | 'bottom';

function edgeAt(bounds: DOMRect, x: number, y: number): Edge | undefined {
  if (x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom) return;
  const horizontal = Math.min(96, bounds.width * 0.22);
  const vertical = Math.min(96, bounds.height * 0.22);
  const candidates: [Edge, number][] = [
    ['left', (x - bounds.left) / horizontal],
    ['right', (bounds.right - x) / horizontal],
    ['top', (y - bounds.top) / vertical],
    ['bottom', (bounds.bottom - y) / vertical],
  ];
  const [edge, distance] = candidates.reduce((nearest, candidate) => candidate[1] < nearest[1] ? candidate : nearest);
  return distance <= 1 ? edge : undefined;
}

function splitAt(edge: Edge) {
  const direction: NonNullable<WorkspaceSplitInput['direction']> = edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical';
  const placement: WorkspaceSplitPlacement = edge === 'left' || edge === 'top' ? 'before' : 'after';
  return { direction, placement };
}

function SplitDropTarget({ workspace, tabId, ratio, onDropTab }: {
  workspace: Workspace;
  tabId: string;
  ratio: number;
  onDropTab: (split: WorkspaceSplitInput) => void;
}) {
  const { t } = useTranslation('shell');
  const [edge, setEdge] = useState<Edge>();
  const target = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(SESSION_TAB_DRAG_TYPE)) return;
    const candidate = edgeAt(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
    if (!candidate) return;
    const split = splitAt(candidate);
    if (workspace.secondaryTabId === tabId && (workspace.splitDirection ?? 'horizontal') === split.direction
      && (workspace.secondaryPlacement ?? 'after') === split.placement) return;
    return candidate;
  };
  const previewRatio = edge && splitAt(edge).placement === 'before' ? ratio : 1 - ratio;
  return <div className="workspace-split-drop" aria-hidden="true"
    onDragOver={event => {
      const candidate = target(event);
      setEdge(candidate);
      if (!candidate) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    }}
    onDragLeave={event => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setEdge(undefined);
    }}
    onDrop={event => {
      const candidate = target(event);
      setEdge(undefined);
      if (!candidate || event.dataTransfer.getData(SESSION_TAB_DRAG_TYPE) !== tabId) return;
      event.preventDefault();
      event.stopPropagation();
      onDropTab({ tabId, ...splitAt(candidate) });
    }}>
    {edge && <div className="workspace-split-preview" data-edge={edge} style={{ '--split-preview-size': `${previewRatio * 100}%` } as CSSProperties}>
      <span>{t(`app.splitDrop.${edge}`)}</span>
    </div>}
  </div>;
}

export function WorkspacePanes({ workspace, active, secondary, renderTab, perform, draggedTabId, onDropTab }: {
  workspace: Workspace;
  active?: WorkspaceTab;
  secondary?: WorkspaceTab;
  renderTab: (tab?: WorkspaceTab) => ReactNode;
  perform: Perform;
  draggedTabId?: string;
  onDropTab: (split: WorkspaceSplitInput) => void;
}) {
  const { t } = useTranslation('shell');
  const [ratio, setRatio] = useState(workspace.splitRatio ?? 0.5);
  const ratioRef = useRef(ratio);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => { ratioRef.current = workspace.splitRatio ?? 0.5; setRatio(ratioRef.current); }, [workspace.id, workspace.splitRatio]);
  const vertical = workspace.splitDirection === 'vertical';
  const [first, second] = secondary && workspace.secondaryPlacement === 'before' ? [secondary, active] : [active, secondary];
  const saveRatio = (value: number) => {
    void perform('split-ratio', () => window.workbench.splitWorkspace(workspace.id, { tabId: workspace.secondaryTabId, direction: workspace.splitDirection, ratio: value }));
  };

  return <div className={`workspace-dual ${vertical ? 'vertical' : ''}`} ref={container}>
    <div key={`pane:${first?.id ?? ''}`} className="tab-content" data-workspace-pane={first?.id} style={second ? { flex: `0 0 ${ratio * 100}%` } : undefined}>{renderTab(first)}</div>
    {second && <div key="divider" className="split-handle" role="separator" aria-label={t('app.resizeSplit')} aria-valuemin={20} aria-valuemax={80}
      aria-valuenow={Math.round(ratio * 100)} aria-orientation={vertical ? 'horizontal' : 'vertical'} tabIndex={0}
      onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)}
      onPointerMove={event => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId) || !container.current) return;
        const rect = container.current.getBoundingClientRect();
        const next = Math.min(0.8, Math.max(0.2, vertical ? (event.clientY - rect.top) / rect.height : (event.clientX - rect.left) / rect.width));
        ratioRef.current = next;
        setRatio(next);
      }}
      onPointerUp={event => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        saveRatio(ratioRef.current);
      }}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -0.05 : 0.05;
        saveRatio(Math.max(0.2, Math.min(0.8, ratio + step)));
      }} />}
    {second && <div key={`pane:${second.id}`} className="tab-content" data-workspace-pane={second.id}>{renderTab(second)}</div>}
    {draggedTabId && <SplitDropTarget key={`drag:${draggedTabId}`} workspace={workspace} tabId={draggedTabId} ratio={ratio} onDropTab={onDropTab} />}
  </div>;
}
