import { useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import './RollingText.css';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function splitChange(previous: string, value: string) {
  const graphemes = (text: string) => Array.from(segmenter.segment(text), item => item.segment);
  const oldCharacters = graphemes(previous);
  const newCharacters = graphemes(value);
  const commonLength = Math.min(oldCharacters.length, newCharacters.length);
  let start = 0;
  let end = 0;
  while (start < commonLength && oldCharacters[start] === newCharacters[start]) start++;
  while (start + end < commonLength && oldCharacters.at(-end - 1) === newCharacters.at(-end - 1)) end++;
  return {
    prefix: newCharacters.slice(0, start).join(''),
    suffix: newCharacters.slice(newCharacters.length - end).join(''),
    leaving: oldCharacters.slice(start, oldCharacters.length - end).join(''),
    entering: newCharacters.slice(start, newCharacters.length - end).join(''),
  };
}

export function RollingText({ value, className, animate = true }: { value: string; className?: string; animate?: boolean }) {
  const reducedMotion = useReducedMotion();
  const roll = animate && !reducedMotion;
  const [frame, setFrame] = useState<{ value: string; previous?: string }>({ value });
  if (frame.value !== value) setFrame({ value, previous: roll ? frame.value : undefined });
  else if (!roll && frame.previous !== undefined) setFrame({ value });

  const change = roll && frame.previous !== undefined ? splitChange(frame.previous, value) : undefined;
  return <span className={className ? `ui-rolling-text ${className}` : 'ui-rolling-text'}>
    <span className="ui-rolling-text-accessible">{value}</span>
    <span className="ui-rolling-text-visual" aria-hidden="true">{change
      ? <>{change.prefix}<span className="ui-rolling-text-change" key={frame.previous} onAnimationEnd={event => {
        if (event.animationName === 'ui-roll-enter') setFrame(current => current === frame ? { value } : current);
      }}>
        <span className="ui-rolling-text-leaving">{change.leaving}</span>
        <span className="ui-rolling-text-entering">{change.entering}</span>
      </span>{change.suffix}</>
      : value}</span>
  </span>;
}
