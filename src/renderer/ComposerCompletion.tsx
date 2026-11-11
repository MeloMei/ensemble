import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface ComposerToken { start: number; end: number; query: string }

export function useComposerCompletion(tokenAt: (input: HTMLTextAreaElement) => ComposerToken | undefined) {
  const [token, setToken] = useState<ComposerToken>();
  const [index, setIndex] = useState(0);
  const dismissed = useRef<{ value: string; start: number }>(undefined);
  const id = useId();
  const selected = (count: number) => Math.min(index, Math.max(0, count - 1));
  const close = (input: HTMLTextAreaElement, remember = true) => {
    const current = remember ? tokenAt(input) : undefined;
    if (current) dismissed.current = { value: input.value, start: current.start };
    setToken(undefined);
  };
  const update = (input: HTMLTextAreaElement) => {
    const next = tokenAt(input);
    if (dismissed.current?.value !== input.value) dismissed.current = undefined;
    if (next && dismissed.current?.start === next.start) return;
    if (next?.start !== token?.start || next?.query !== token?.query) setIndex(0);
    setToken(next);
  };
  const keyDown = <T,>(event: KeyboardEvent<HTMLTextAreaElement>, items: T[], pick: (input: HTMLTextAreaElement, item: T) => void) => {
    if (!token || event.nativeEvent.isComposing || event.keyCode === 229) return false;
    if (!['Escape', 'ArrowUp', 'ArrowDown', 'Enter'].includes(event.key) || (event.key === 'Enter' && event.shiftKey)) return false;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') close(event.currentTarget);
    else if (event.key === 'Enter') {
      const item = items[selected(items.length)];
      if (item !== undefined) pick(event.currentTarget, item);
    } else if (items.length) {
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = (selected(items.length) + delta + items.length) % items.length;
      setIndex(next);
      document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: 'nearest' });
    }
    return true;
  };
  const attributes = (count: number) => ({
    'aria-controls': id, 'aria-activedescendant': count ? `${id}-${selected(count)}` : undefined,
  });
  return { token, id, selected, close, update, keyDown, attributes };
}

export function restoreComposerCursor(input: HTMLTextAreaElement, value: string, cursor: number) {
  requestAnimationFrame(() => { if (input.isConnected && input.value === value) input.setSelectionRange(cursor, cursor); });
}

export function ComposerCompletionList<T>({ id, selected, items, label, status, className, itemKey, onPick, children }: {
  id: string;
  selected: number;
  items: T[];
  label: string;
  status: string;
  className: string;
  itemKey: (item: T) => string;
  onPick: (item: T) => void;
  children: (item: T) => ReactNode;
}) {
  return <div className={`composer-completion ${className}`}>
    {status && <p role="status">{status}</p>}
    <ul id={id} role="listbox" aria-label={label}>
      {items.map((item, index) => <li id={`${id}-${index}`} key={itemKey(item)} role="option" aria-selected={selected === index}
        onMouseDown={event => event.preventDefault()} onClick={() => onPick(item)}>{children(item)}</li>)}
    </ul>
  </div>;
}
