import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type Visit =
  | { page: 'workspace'; workspaceId: string | null; tabId: string | null; sessionId?: string }
  | { page: 'history'; sessionId: string | null }
  | { page: 'workflows'; workflowId: string | null }
  | { page: 'collaboration'; workspaceId: string | null }
  | { page: 'attention' };

const keyOf = (visit: Visit) => visit.page === 'workspace' && visit.sessionId
  ? JSON.stringify([visit.page, visit.workspaceId, visit.sessionId])
  : JSON.stringify(visit);

interface Trail { visits: Visit[]; cursor: number }
interface Destination { visit: Visit; cursor: number; applied: boolean }
type Direction = -1 | 1;

export function useVisitHistory(current: Visit | undefined, reachable: (visit: Visit) => boolean,
  restore: (visit: Visit) => Promise<boolean>, focus: () => void, enabled: boolean) {
  const [trail, setTrail] = useState<Trail>({ visits: [], cursor: -1 });
  const [destination, setDestination] = useState<Destination>();
  const inFlight = useRef<Destination>(undefined);
  const route = current && keyOf(current);
  const destinationReachable = destination && reachable(destination.visit);

  useLayoutEffect(() => {
    if (!current) return;
    if (destination) {
      if (!enabled || !destinationReachable) {
        inFlight.current = undefined;
        setDestination(undefined);
        return;
      }
      if (!destination.applied || route !== keyOf(destination.visit)) return;
      setTrail(value => ({ ...value, cursor: destination.cursor }));
      inFlight.current = undefined;
      setDestination(undefined);
      focus();
      return;
    }
    setTrail(value => {
      const previous = value.visits[value.cursor];
      if (previous && keyOf(previous) === route) return value;
      const visits = [...value.visits.slice(0, value.cursor + 1), current].slice(-100);
      return { visits, cursor: visits.length - 1 };
    });
  }, [route, destination, destinationReachable, enabled]);

  const next = (direction: Direction) => {
    for (let cursor = trail.cursor + direction; cursor >= 0 && cursor < trail.visits.length; cursor += direction) {
      const visit = trail.visits[cursor];
      if (keyOf(visit) !== route && reachable(visit)) return { visit, cursor, applied: false };
    }
  };
  const move = (direction: Direction) => {
    if (!enabled || inFlight.current) return;
    const target = next(direction);
    if (!target) return;
    inFlight.current = target;
    setDestination(target);
    const clearDestination = () => {
      if (inFlight.current !== target) return;
      inFlight.current = undefined;
      setDestination(undefined);
    };
    void restore(target.visit).then(success => {
      if (!success) clearDestination();
      else if (inFlight.current === target) setDestination({ ...target, applied: true });
    }, clearDestination);
  };
  const canBack = enabled && !destination && Boolean(next(-1));
  const canForward = enabled && !destination && Boolean(next(1));
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing
        || document.querySelector('dialog[open]')) return;
      if (event.key === '[' && canBack) { event.preventDefault(); move(-1); }
      if (event.key === ']' && canForward) { event.preventDefault(); move(1); }
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  });

  return { canBack, canForward, back: () => move(-1), forward: () => move(1) };
}
