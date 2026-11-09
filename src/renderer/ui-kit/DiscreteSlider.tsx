import { useId, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { RollingText } from './RollingText';
import './DiscreteSlider.css';

interface DiscreteSliderProps {
  label: string;
  stops: readonly string[];
  value: number;
  onCommit: (index: number) => void;
  disabled?: boolean;
  animate?: boolean;
}

export function DiscreteSlider({ label, stops, value, onCommit, disabled, animate }: DiscreteSliderProps) {
  const labelId = useId();
  const input = useRef<HTMLInputElement>(null);
  const track = useRef<HTMLSpanElement>(null);
  const pointer = useRef<number | null>(null);
  const [dragPosition, setDragPosition] = useState<number | null>(null);
  const last = Math.max(1, stops.length - 1);
  const dragging = dragPosition !== null && !disabled;
  const position = dragging ? dragPosition : value / last;
  const displayedStop = Math.round(position * last);

  const positionAt = (event: PointerEvent) => {
    const bounds = track.current!.getBoundingClientRect();
    return bounds.width ? Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) : position;
  };
  const clearPointer = () => {
    pointer.current = null;
    setDragPosition(null);
  };
  const commit = (index: number) => {
    if (!disabled) onCommit(index);
  };

  return <div className="discrete-slider" data-disabled={disabled || undefined}>
    <div className="discrete-slider-heading">
      <span id={labelId}>{label}</span>
      <RollingText className="discrete-slider-value" value={stops[displayedStop]} animate={animate || dragging} />
    </div>
    <div className="discrete-slider-control" data-dragging={dragging || undefined}
      style={{ '--slider-position': `${position * 100}%` } as CSSProperties}
      onPointerDown={event => {
        if (disabled || event.button !== 0 || pointer.current !== null) return;
        event.preventDefault();
        input.current?.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        pointer.current = event.pointerId;
        setDragPosition(positionAt(event));
      }}
      onPointerMove={event => {
        if (!disabled && pointer.current === event.pointerId) setDragPosition(positionAt(event));
      }}
      onPointerUp={event => {
        if (pointer.current !== event.pointerId) return;
        clearPointer();
        commit(Math.round(positionAt(event) * last));
      }}
      onPointerCancel={event => { if (pointer.current === event.pointerId) clearPointer(); }}
      onLostPointerCapture={event => { if (pointer.current === event.pointerId) clearPointer(); }}>
      <span className="discrete-slider-track" ref={track} aria-hidden="true">
        <span className="discrete-slider-fill" />
        {stops.map((_, index) => <span key={index} className="discrete-slider-tick"
          data-passed={index <= displayedStop || undefined}
          style={{ insetInlineStart: `${index / last * 100}%` }} />)}
        <span className="discrete-slider-thumb" />
      </span>
      <input ref={input} type="range" min={0} max={last} step={1} value={value}
        aria-labelledby={labelId} aria-valuetext={stops[value]} aria-disabled={disabled || undefined}
        onKeyDown={event => {
          if (disabled && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) event.preventDefault();
        }}
        onChange={event => commit(event.target.valueAsNumber)} />
    </div>
  </div>;
}
