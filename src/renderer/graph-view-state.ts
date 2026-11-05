import type { Viewport, XYPosition } from '@xyflow/react';

export interface GraphViewState {
  positions: Record<string, XYPosition>;
  viewport?: Viewport;
}

const prefix = 'ensemble.graph-view.';
const memory = new Map<string, GraphViewState>();
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function readGraphView(key?: string): GraphViewState {
  if (!key) return { positions: {} };
  if (memory.has(key)) return memory.get(key)!;
  try {
    const saved = JSON.parse(localStorage.getItem(prefix + key) ?? 'null');
    const positions: Record<string, XYPosition> = Object.create(null);
    for (const [id, value] of Object.entries(saved?.positions ?? {})) {
      const point = value as XYPosition | null;
      if (point && finite(point.x) && finite(point.y)) positions[id] = { x: point.x, y: point.y };
    }
    const view = saved?.viewport;
    return { positions, ...(view && finite(view.x) && finite(view.y) && finite(view.zoom) && view.zoom > 0 ? { viewport: view } : {}) };
  } catch { return { positions: {} }; }
}

export function writeGraphView(key: string | undefined, state: GraphViewState): void {
  if (!key) return;
  memory.set(key, state);
  if (memory.size > 100) memory.delete(memory.keys().next().value!);
  try { localStorage.setItem(prefix + key, JSON.stringify(state)); } catch { /* The current window still retains its layout. */ }
}

export function copyGraphView(from: string, to: string, idMap?: Record<string, string>): void {
  const saved = readGraphView(from);
  const positions = idMap ? Object.fromEntries(Object.entries(saved.positions).flatMap(([id, point]) => idMap[id] ? [[idMap[id], point]] : [])) : saved.positions;
  writeGraphView(to, { ...saved, positions });
}
