import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { measureElement, type Virtualizer } from '@tanstack/react-virtual';

type ConversationVirtualizer = Virtualizer<HTMLDivElement, HTMLDivElement>;
export interface ReadingAnchor {
  id: string;
  kind: 'message' | 'trace' | 'event';
  offset: number;
  detailsOpen?: boolean;
}

const savedPositions = new Map<string, ReadingAnchor>();
export function useReadingAnchor(sessionId: string) {
  return useState(() => savedPositions.get(sessionId));
}

interface ReadingPositionOptions {
  sessionId: string;
  virtualizer: ConversationVirtualizer;
  anchor: ReadingAnchor | undefined;
  finish: () => void;
  index: number;
  ready: boolean;
  connected: boolean;
  showingHistory: boolean;
  isFollowingOutput: () => boolean;
  identifyRow: (index: number) => Pick<ReadingAnchor, 'id' | 'kind'> | undefined;
  locate: (id: string, reportError?: boolean) => Promise<boolean>;
  cancelLookup: () => void;
  followLatest: () => void;
}

export function useSessionReadingPosition(options: ReadingPositionOptions) {
  const { sessionId, virtualizer, anchor, index, ready, connected, finish, locate, cancelLookup, followLatest } = options;
  const current = useRef(options);
  current.current = options;
  const mounted = useRef(false);
  const lastPosition = useRef<ReadingAnchor | undefined>(undefined);
  const lookup = useRef<ReadingAnchor | undefined>(undefined);
  const requestedRow = useRef<{ anchor: ReadingAnchor; index: number } | undefined>(undefined);

  const cancelRestore = useCallback(() => {
    if (!current.current.anchor) return;
    current.current = { ...current.current, anchor: undefined };
    if (lookup.current) {
      lookup.current = undefined;
      cancelLookup();
    }
    virtualizer.cancelScroll();
    finish();
  }, [cancelLookup, finish, virtualizer]);

  const capture = useCallback((element: HTMLDivElement) => {
    const { anchor, showingHistory, isFollowingOutput, identifyRow } = current.current;
    if (anchor || !element.clientHeight) return;
    if (isFollowingOutput() && !showingHistory) {
      lastPosition.current = undefined;
      return;
    }
    const item = virtualizer.getVirtualItemForOffset(element.scrollTop);
    const row = item && identifyRow(item.index);
    if (!item || !row) return;
    const node = virtualizer.elementsCache.get(item.key);
    lastPosition.current = {
      ...row,
      offset: item.start - element.scrollTop,
      detailsOpen: row.kind === 'event' && Boolean(node?.querySelector('.process-reveal[data-expanded=true]')),
    };
  }, [virtualizer]);

  useLayoutEffect(() => {
    mounted.current = true;
    const element = virtualizer.scrollElement;
    return () => {
      mounted.current = false;
      requestedRow.current = undefined;
      if (current.current.anchor) return;
      if (element?.isConnected) capture(element);
      if (lastPosition.current) savedPositions.set(sessionId, lastPosition.current);
      else savedPositions.delete(sessionId);
    };
  }, [capture, sessionId, virtualizer]);

  useEffect(() => {
    if (!anchor || !ready || !connected || index >= 0 || lookup.current === anchor) return;
    let scheduled = true;
    // Strict Mode can replay the effect before its first history request starts.
    queueMicrotask(() => {
      if (!scheduled || current.current.anchor !== anchor || lookup.current === anchor) return;
      lookup.current = anchor;
      void locate(anchor.id, false).then(found => {
        if (!found && mounted.current && current.current.anchor === anchor) {
          cancelRestore();
          followLatest();
        }
      });
    });
    return () => { scheduled = false; };
  }, [anchor, cancelRestore, connected, followLatest, index, locate, ready]);

  useLayoutEffect(() => {
    if (!anchor || index < 0) return;
    const element = virtualizer.scrollElement;
    const key = virtualizer.options.getItemKey(index);
    const row = virtualizer.elementsCache.get(key);
    if (!element || !row?.isConnected) {
      if (requestedRow.current?.anchor !== anchor || requestedRow.current.index !== index) {
        requestedRow.current = { anchor, index };
        virtualizer.scrollToIndex(index, { align: 'start', behavior: 'auto' });
      }
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (current.current.anchor !== anchor || !row.isConnected || row.dataset.index !== String(index)) return;
      const rowRect = row.getBoundingClientRect();
      const offset = Math.max(anchor.offset, 1 - rowRect.height);
      virtualizer.scrollToOffset(element.scrollTop + rowRect.top - element.getBoundingClientRect().top - offset);
      lastPosition.current = { ...anchor, offset };
      if (lookup.current === anchor) {
        lookup.current = undefined;
        cancelLookup();
      }
      finish();
    });
    return () => cancelAnimationFrame(frame);
  });

  return { cancelRestore, capture };
}

const rowWidths = new WeakMap<Element, number>();
export function measureConversationRow(element: HTMLDivElement, entry: ResizeObserverEntry | undefined, instance: ConversationVirtualizer) {
  const width = entry?.borderBoxSize?.[0]?.inlineSize;
  const previousWidth = rowWidths.get(element);
  if (width !== undefined) rowWidths.set(element, width);
  // The default skips remeasurement while scrolling backwards. Width reflow
  // still needs to compensate rows above the viewport in either direction.
  instance.shouldAdjustScrollPositionOnItemSizeChange = width !== undefined && previousWidth !== undefined && width !== previousWidth
    ? item => item.end <= (instance.scrollOffset ?? 0)
    : undefined;
  return measureElement(element, entry, instance);
}
