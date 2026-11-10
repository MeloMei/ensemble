import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import './FoldableText.css';

export interface FoldableTextProps {
  text: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  expandLabel: string;
  collapseLabel: string;
  lines?: number;
}

export function FoldableText({ text, expanded, onExpandedChange, expandLabel, collapseLabel, lines = 5 }: FoldableTextProps) {
  const id = useId();
  const body = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const visibleLines = Number.isInteger(lines) && lines > 0 ? lines : 5;

  useLayoutEffect(() => {
    const element = body.current;
    if (!element || typeof ResizeObserver === 'undefined') return;

    const measure = () => {
      const { height, lineHeight } = getComputedStyle(element);
      const foldedHeight = Number.parseFloat(lineHeight) * visibleLines;
      setOverflows(element.clientWidth > 0 && Number.parseFloat(height) > foldedHeight + 1);
    };

    measure();
    // Observe the natural height, which stays measurable inside the clipped wrapper.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, visibleLines]);

  return <div className="ui-foldable-text" style={{ '--ui-foldable-text-lines': visibleLines } as CSSProperties}>
    {overflows && <button type="button" className="ui-foldable-text-toggle" aria-expanded={expanded} aria-controls={id}
      onClick={() => onExpandedChange(!expanded)}>
      {expanded ? collapseLabel : expandLabel}
    </button>}
    <div id={id} className="ui-foldable-text-viewport" data-collapsed={overflows && !expanded || undefined}>
      <div ref={body} className="ui-foldable-text-body">{text}</div>
    </div>
  </div>;
}
