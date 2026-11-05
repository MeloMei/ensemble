import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowUpRight, CircleHelp, Clock3, FileCheck2, FileText, GitBranch, Maximize, Minus, Network, Plus, RefreshCw, X } from 'lucide-react';
import { Background, BaseEdge, ControlButton, Controls, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow, getSmoothStepPath, useNodes, useNodesInitialized, useReactFlow, useStore, type Connection, type Edge, type EdgeChange, type EdgeProps, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import ELK from 'elkjs/lib/elk-api.js';
import ELKWorker from 'elkjs/lib/elk-worker.min.js?worker';
import { useAppearance } from './appearance';
import { AgentIcon } from './AgentIcon';
import { Tooltip } from './Tooltip';
import { Status } from './ui';
import { formatNumber } from '../shared/i18n';
import type { ResourceDeliveryCount } from './collaboration-resource-delivery';
import '@xyflow/react/dist/style.css';
import './CollaborationViews.css';
import './ExecutionGraph.css';
import { readGraphView, writeGraphView } from './graph-view-state';

export interface GraphNodeData extends Record<string, unknown> { title: string; subtitle: string; detail?: string; kind: 'participant' | 'task' | 'artifact'; status?: string; external?: boolean; recipientProviderId?: string; executionId?: string; executionActive?: boolean; resourceDelivery?: ResourceDeliveryCount[] }
export type CollaborationNode = Node<GraphNodeData, 'collaboration'>;
export type GraphSelection = { kind: 'participant' | 'task' | 'artifact' | 'event' | 'message' | 'relationship'; id: string } | { kind: 'events'; ids: string[] };
export interface GraphEdgeData extends Record<string, unknown> { selection?: GraphSelection; configured?: boolean; historicalResourceInput?: boolean; handoffSeqs?: number[]; onHandoffEnd?: (seq: number) => void; onLabelSelect?: () => void }
export type CollaborationEdge = Edge<GraphEdgeData>;
const resourceDeliveryIcons = { queued: Clock3, failed: X, injected: FileCheck2, reported: ArrowUpRight, unconfirmed: CircleHelp };
function CollaborationNodeView({ data, selected, isConnectable }: NodeProps<CollaborationNode>) {
  const { t } = useTranslation('collaboration');
  const reducedMotion = useReducedMotion();
  const seenExecutions = useRef(new Set(data.executionId ? [data.executionId] : []));
  const [executionStarted, setExecutionStarted] = useState(false);
  const executing = data.status === 'running' && Boolean(data.executionId) && Boolean(data.executionActive);
  useEffect(() => {
    const started = Boolean(data.executionId) && !seenExecutions.current.has(data.executionId!);
    if (data.executionId && executing) seenExecutions.current.add(data.executionId);
    setExecutionStarted(started && executing && !reducedMotion);
  }, [data.executionId, executing, reducedMotion]);
  return <motion.div className={`collaboration-node node-${data.kind} ${selected ? 'selected' : ''}`} data-status={data.status} data-executing={executing}
    initial={reducedMotion ? false : { opacity: 0, scale: 0.96, y: 5 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ duration: 0.18 }}>
    {executionStarted && !reducedMotion && <span className="collaboration-node-status-feedback" aria-hidden="true" onAnimationEnd={() => setExecutionStarted(false)} />}
    <Handle type="target" position={Position.Left} isConnectable={isConnectable} />
    <div className="collaboration-node-eyebrow">
      {data.recipientProviderId ? <AgentIcon providerId={data.recipientProviderId} size={12} />
        : data.kind === 'artifact' ? <FileText size={12} /> : data.kind === 'task' ? <GitBranch size={12} /> : <Network size={12} />}
      <span title={data.subtitle}>{data.subtitle}</span>
      {!!data.resourceDelivery?.length && <div className="collaboration-resource-deliveries" role="group" aria-label={t('resource.deliverySummary')}>
        {data.resourceDelivery.map(item => {
          const Icon = resourceDeliveryIcons[item.status];
          const total = item.tasks + item.messages;
          const label = [t(`resource.delivery.${item.status}`), item.tasks ? t('resource.taskCount', { count: item.tasks }) : '', item.messages ? t('resource.messageCount', { count: item.messages }) : ''].filter(Boolean).join(' · ');
          return <Tooltip key={item.status} label={label}><span className="collaboration-resource-delivery" role="img" tabIndex={0} aria-label={label} data-resource-delivery={item.status} data-resource-tasks={item.tasks} data-resource-messages={item.messages}><Icon size={10} aria-hidden="true" /><span aria-hidden="true">{total > 99 ? '99+' : total}</span></span></Tooltip>;
        })}
      </div>}
    </div>
    <strong>{data.title}</strong>{data.detail && <p>{data.detail}</p>}
    <footer>{data.status && <Status value={data.status} />}{data.external && <span>{t('participant.externalConnection')}</span>}</footer>
    <Handle type="source" position={Position.Right} isConnectable={isConnectable} />
  </motion.div>;
}
const nodeTypes = { collaboration: CollaborationNodeView };
function CollaborationEdgeView(props: EdgeProps<CollaborationEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath(props);
  return <><BaseEdge id={props.id} path={path} style={props.style} markerEnd={props.markerEnd} markerStart={props.markerStart} interactionWidth={28} />
    {props.label && <EdgeLabelRenderer><button type="button" className="execution-edge-label nodrag nopan" data-selected={props.selected} title={typeof props.label === 'string' ? props.label : undefined}
      style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }} onClick={props.data?.onLabelSelect}>{props.label}</button></EdgeLabelRenderer>}
    {!props.data?.configured && props.data?.handoffSeqs?.map(seq => <path key={seq} className="collaboration-edge-handoff" data-event-seq={seq} d={path} pathLength={1} aria-hidden="true" onAnimationEnd={() => props.data?.onHandoffEnd?.(seq)} />)}</>;
}
const edgeTypes = { collaboration: CollaborationEdgeView };
export const edgeFor = (id: string, source: string, target: string, label: string, selection?: GraphSelection, configured = false, delivered = false): CollaborationEdge => ({ id, source, target, label, className: delivered ? 'collaboration-edge-delivered' : undefined, type: 'collaboration', markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: configured ? 'var(--dim)' : 'var(--muted)' }, style: { stroke: configured ? 'var(--dim)' : delivered ? 'var(--accent)' : 'var(--muted)', strokeWidth: configured ? 1 : 1.25, ...(configured ? { strokeDasharray: '6 5' } : {}) }, labelStyle: { fill: configured ? 'var(--muted)' : 'var(--text)', fontSize: 11 }, labelBgStyle: { fill: 'var(--surface)', fillOpacity: 1 }, labelBgBorderRadius: 3, labelBgPadding: [7, 5], data: { selection, configured } });
export const graphNode = (id: string, data: GraphNodeData): CollaborationNode => ({ id, type: 'collaboration', position: { x: 0, y: 0 }, data, width: 228, height: 118 });

interface CanvasNodeView {
  position?: { x: number; y: number };
  measured?: { width?: number; height?: number };
  selected?: boolean;
  dragging?: boolean;
}
interface CompletedLayout { id: number; key: string; positions: Map<string, { x: number; y: number }> }
interface CanvasView {
  nodes: Map<string, CanvasNodeView>;
  selectedEdgeId?: string;
  layout?: CompletedLayout;
  error: string;
}
function FitCompletedLayout({ layout, onComplete }: { layout?: CompletedLayout; onComplete: (id: number) => void }) {
  const reducedMotion = useReducedMotion();
  const nodes = useNodes<CollaborationNode>();
  const initialized = useNodesInitialized();
  const { fitView, viewportInitialized } = useReactFlow<CollaborationNode, CollaborationEdge>();
  const fitted = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!layout || fitted.current === layout.id || !initialized || !viewportInitialized) return;
    const committed = nodes.length === layout.positions.size && nodes.every(node => {
      const position = layout.positions.get(node.id);
      return position?.x === node.position.x && position.y === node.position.y;
    });
    if (!committed) return;
    fitted.current = layout.id;
    void fitView({ padding: 0.25, maxZoom: 1, duration: reducedMotion ? 0 : 160 }).then(() => onComplete(layout.id));
  }, [layout, nodes, initialized, viewportInitialized, fitView, reducedMotion, onComplete]);
  return null;
}

export function ExecutionGraph({ graph, view, storageKey, selection, connectable = view === 'relationships', onSelect, onConnect, onPaneClick, children }: {
  graph: { nodes: CollaborationNode[]; edges: CollaborationEdge[] };
  view: string; storageKey?: string; selection?: GraphSelection; connectable?: boolean;
  onSelect: (selection: GraphSelection) => void; onConnect?: (connection: Connection) => void;
  onPaneClick?: () => void; children?: ReactNode;
}) {
  const { t } = useTranslation('collaboration');
  const { theme } = useAppearance();
  const initialView = useRef(readGraphView(storageKey));
  const initialSelection = useRef(selection && 'id' in selection ? selection.kind === 'participant' ? selection.id : `${selection.kind}-${selection.id}` : undefined);
  const viewport = useRef(initialView.current.viewport);
  const [canvas, setCanvas] = useState<CanvasView>(() => ({ nodes: new Map(Object.entries(initialView.current.positions).map(([id, position]) => [id, { position }])), error: '' }));
  const finishLayout = useCallback((id: number) => setCanvas(current => current.layout?.id === id ? { ...current, layout: undefined } : current), []);
  const appliedRevision = useRef(0);
  const hasFitted = useRef(Boolean(initialView.current.viewport));
  useEffect(() => {
    const positions = Object.fromEntries([...canvas.nodes].flatMap(([id, node]) => node.position ? [[id, node.position]] : []));
    if (Object.keys(positions).length) writeGraphView(storageKey, { positions, viewport: viewport.current });
  }, [canvas.nodes, storageKey]);
  const [revision, setRevision] = useState(0);
  const layoutId = useRef(0);
  const layoutKey = JSON.stringify([view, revision, graph.nodes.map(node => node.id), graph.edges.map(edge => [edge.id, edge.source, edge.target])]);
  const nodes = useMemo(() => graph.nodes.map(node => {
    const display = canvas.nodes.get(node.id);
    const id = node.data.kind === 'participant' ? node.id : node.id.replace(/^(task|artifact)-/, '');
    return { ...node, ...display, ...(selection ? { selected: 'id' in selection && selection.kind === node.data.kind && selection.id === id } : {}), position: display?.position ?? node.position };
  }), [graph.nodes, canvas.nodes, selection]);
  const edges = graph.edges.map(edge => ({ ...edge, data: { ...edge.data, onLabelSelect: () => edge.data?.selection && onSelect(edge.data.selection) }, selected: selection ? JSON.stringify(edge.data?.selection) === JSON.stringify(selection) : edge.id === canvas.selectedEdgeId }));
  const onNodesChange = (changes: NodeChange<CollaborationNode>[]) => setCanvas(current => {
    const display = new Map(current.nodes);
    for (const change of changes) {
      if (change.type === 'position') display.set(change.id, { ...display.get(change.id),
        ...(change.position ? { position: change.position } : {}), ...(change.dragging !== undefined ? { dragging: change.dragging } : {}) });
      else if (change.type === 'dimensions' && change.dimensions) display.set(change.id, { ...display.get(change.id), measured: change.dimensions });
      else if (change.type === 'select') display.set(change.id, { ...display.get(change.id), selected: change.selected });
    }
    return { ...current, nodes: display };
  });
  const onEdgesChange = (changes: EdgeChange<CollaborationEdge>[]) => setCanvas(current => {
    let selectedEdgeId = current.selectedEdgeId;
    for (const change of changes) if (change.type === 'select') {
      if (change.selected) selectedEdgeId = change.id;
      else if (selectedEdgeId === change.id) selectedEdgeId = undefined;
    }
    return { ...current, selectedEdgeId };
  });
  useEffect(() => {
    let active = true;
    setCanvas(current => ({ ...current, error: '' }));
    if (!graph.nodes.length) return;
    const elk = new ELK({ workerFactory: () => new ELKWorker() });
    void elk.layout({
      id: 'collaboration',
      layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.spacing.nodeNode': '44', 'elk.layered.spacing.nodeNodeBetweenLayers': '180' },
      children: graph.nodes.map(node => ({ id: node.id, width: node.width ?? 228, height: node.height ?? 118 })),
      edges: graph.edges.map(edge => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
    }).then(result => {
      if (!active) return;
      setCanvas(current => {
        const rearrange = revision !== appliedRevision.current;
        appliedRevision.current = revision;
        const known = [...current.nodes.values()].filter(node => node.position);
        let nextY = Math.max(0, ...known.map(node => node.position!.y)) + 162;
        const positions = new Map(result.children?.map(node => {
          const previous = current.nodes.get(node.id)?.position;
          const position = !rearrange && previous ? previous
            : !rearrange && known.length ? { x: Math.min(...known.map(item => item.position!.x)), y: nextY }
            : { x: node.x ?? 0, y: node.y ?? 0 };
          if (!previous) nextY += 162;
          return [node.id, position];
        }));
        const shouldFit = rearrange || !hasFitted.current;
        hasFitted.current = true;
        return { ...current, error: '', layout: shouldFit ? { id: ++layoutId.current, key: layoutKey, positions } : undefined,
          nodes: new Map([...positions].map(([id, position]) => [id, { ...current.nodes.get(id), position }])) };
      });
    }).catch(reason => { if (active) setCanvas(current => ({ ...current, error: reason instanceof Error ? reason.message : String(reason) })); });
    return () => { active = false; elk.terminateWorker(); };
  }, [layoutKey]);
  return <div className="collaboration-canvas execution-graph">
    <ReactFlow<CollaborationNode, CollaborationEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
      onNodeClick={(_, node) => onSelect({ kind: node.data.kind, id: node.data.kind === 'participant' ? node.id : node.id.replace(/^(task|artifact)-/, '') })}
      onEdgeClick={(_, edge) => edge.data?.selection && onSelect(edge.data.selection)}
      onConnect={onConnect} nodesConnectable={connectable} deleteKeyCode={null} onPaneClick={onPaneClick}
      defaultViewport={initialView.current.viewport}
      onMoveEnd={(_, value) => { viewport.current = value; writeGraphView(storageKey, { ...readGraphView(storageKey), viewport: value }); }}
      minZoom={0.05} maxZoom={1.8} colorMode={theme}
      ariaLabelConfig={{
        'node.a11yDescription.default': t('graph.nodeDescription'),
        'node.a11yDescription.keyboardDisabled': t('graph.nodeDescription'),
        'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }) => t('graph.nodeMoved', { direction: t(`graph.direction.${direction}`, { defaultValue: direction }), x: formatNumber(x), y: formatNumber(y) }),
        'edge.a11yDescription.default': t('graph.edgeDescription'),
        'controls.ariaLabel': t('graph.controls'),
        'controls.zoomIn.ariaLabel': t('graph.zoomIn'),
        'controls.zoomOut.ariaLabel': t('graph.zoomOut'),
        'controls.fitView.ariaLabel': t('graph.fitView'),
        'controls.interactive.ariaLabel': t('graph.interactive'),
        'minimap.ariaLabel': t('graph.minimap'),
        'handle.ariaLabel': t('graph.handle'),
      }} aria-label={view === 'relationships' ? t('graph.relationshipsLabel') : t('graph.dataLabel')}>
      <FitCompletedLayout layout={canvas.layout?.key === layoutKey ? canvas.layout : undefined} onComplete={finishLayout} />
      <RevealSelectedNode initialSelection={initialSelection.current} positions={!canvas.layout && graph.nodes.every(node => canvas.nodes.get(node.id)?.position !== undefined) ? canvas.nodes : undefined} />
      <Background color="var(--border-strong)" gap={24} size={1} /><CanvasControls />
    </ReactFlow>
    <div className="collaboration-canvas-tools"><button type="button" className="button small" onClick={() => setRevision(value => value + 1)}><RefreshCw size={12} />{t('graph.relayout')}</button></div>
    {children}
    {!graph.nodes.length && <div className="collaboration-canvas-empty">{t('graph.empty')}</div>}
    {canvas.error && <div className="collaboration-graph-error" role="alert">{t('graph.layoutError', { error: canvas.error })}</div>}
  </div>;
}

function RevealSelectedNode({ positions, initialSelection }: { positions?: Map<string, CanvasNodeView>; initialSelection?: string }) {
  const nodes = useNodes<CollaborationNode>();
  const selected = nodes.find(node => node.selected);
  const revealed = useRef(initialSelection);
  const reducedMotion = useReducedMotion();
  const initialized = useNodesInitialized();
  const { getViewport, setViewport } = useReactFlow();
  const width = useStore(state => state.width);
  const height = useStore(state => state.height);
  useEffect(() => {
    if (!selected) { if (initialized) revealed.current = undefined; return; }
    const position = positions?.get(selected.id)?.position;
    if (!position || position.x !== selected.position.x || position.y !== selected.position.y || !initialized || !width || !height || revealed.current === selected.id) return;
    revealed.current = selected.id;
    const viewport = getViewport();
    const left = selected.position.x * viewport.zoom + viewport.x;
    const top = selected.position.y * viewport.zoom + viewport.y;
    const right = left + (selected.measured?.width ?? 228) * viewport.zoom;
    const bottom = top + (selected.measured?.height ?? 118) * viewport.zoom;
    const dx = left < 24 ? 24 - left : right > width - 24 ? width - 24 - right : 0;
    const dy = top < 24 ? 24 - top : bottom > height - 24 ? height - 24 - bottom : 0;
    if (dx || dy) void setViewport({ ...viewport, x: viewport.x + dx, y: viewport.y + dy }, { duration: reducedMotion ? 0 : 180 });
  }, [selected, positions, initialized, width, height, getViewport, setViewport, reducedMotion]);
  return null;
}

function CanvasControls() {
  const { t } = useTranslation('collaboration');
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const minZoomReached = useStore(state => state.transform[2] <= state.minZoom);
  const maxZoomReached = useStore(state => state.transform[2] >= state.maxZoom);
  return <Controls showZoom={false} showFitView={false} showInteractive={false} aria-label={t('graph.controls')}>
    <Tooltip label={t('graph.zoomIn')}><ControlButton className="react-flow__controls-zoomin" aria-label={t('graph.zoomIn')}
      disabled={maxZoomReached} onClick={() => void zoomIn()}><Plus size={14} /></ControlButton></Tooltip>
    <Tooltip label={t('graph.zoomOut')}><ControlButton className="react-flow__controls-zoomout" aria-label={t('graph.zoomOut')}
      disabled={minZoomReached} onClick={() => void zoomOut()}><Minus size={14} /></ControlButton></Tooltip>
    <Tooltip label={t('graph.fitView')}><ControlButton className="react-flow__controls-fitview" aria-label={t('graph.fitView')}
      onClick={() => void fitView({ padding: 0.25, maxZoom: 1 })}><Maximize size={14} /></ControlButton></Tooltip>
  </Controls>;
}

