import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

export function usePaneResize({ width, min, max, side, visible, onResize }: {
  width: number;
  min: number;
  max: number;
  side: 'left' | 'right';
  visible: boolean;
  onResize: (width: number) => void;
}) {
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const [dragWidth, setDragWidth] = useState<number>();
  const clamp = (value: number) => Math.round(Math.min(Math.max(value, min), max));
  const currentWidth = clamp(dragWidth ?? width);
  const direction = side === 'left' ? 1 : -1;

  useLayoutEffect(() => {
    if (visible || !drag.current) return;
    drag.current = null;
    setDragWidth(undefined);
  }, [visible]);

  const widthAtPointer = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start?.pointerId === event.pointerId) return clamp(start.width + direction * (event.clientX - start.x));
  };
  const finishDrag = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const start = drag.current;
    if (start?.pointerId !== event.pointerId) return;
    const next = widthAtPointer(event);
    drag.current = null;
    setDragWidth(undefined);
    if (visible && commit && next !== undefined && event.clientX !== start.x && next !== start.width) onResize(next);
  };

  return {
    currentWidth,
    handle: {
      role: 'separator' as const,
      'aria-orientation': 'vertical' as const,
      'aria-valuemin': min,
      'aria-valuemax': max,
      'aria-valuenow': currentWidth,
      tabIndex: visible ? 0 : -1,
      'data-dragging': dragWidth !== undefined,
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (!visible || event.button !== 0 || !event.isPrimary || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, x: event.clientX, width: currentWidth };
        setDragWidth(currentWidth);
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        const next = widthAtPointer(event);
        if (next !== undefined) setDragWidth(next);
      },
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => finishDrag(event, true),
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) => finishDrag(event, false),
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => finishDrag(event, false),
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        if (!visible || drag.current) return;
        let next: number;
        switch (event.key) {
          case 'ArrowLeft': next = currentWidth - direction * 24; break;
          case 'ArrowRight': next = currentWidth + direction * 24; break;
          case 'Home': next = min; break;
          case 'End': next = max; break;
          default: return;
        }
        event.preventDefault();
        next = clamp(next);
        if (next !== currentWidth) onResize(next);
      },
    },
  };
}
