import { Check, Search } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import './SearchPicker.css';

export interface SearchPickerItem {
  id: string;
  label: string;
  detail?: string;
  keywords?: string;
  icon?: ReactNode;
}

export interface SearchPickerSection {
  id: string;
  label?: string;
  items: readonly SearchPickerItem[];
  prefiltered?: boolean;
  initialLimit?: number;
}

export interface SearchPickerProps {
  sections: readonly SearchPickerSection[];
  inputLabel: string;
  resultsLabel: string;
  showLabel?: boolean;
  placeholder?: string;
  emptyText: string;
  loading?: boolean;
  loadingText?: string;
  query?: string;
  onQueryChange?: (query: string) => void;
  selectedId?: string;
  onSelect: (id: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  readOnly?: boolean;
}

export function SearchPicker({
  sections, inputLabel, resultsLabel, showLabel, placeholder, emptyText, loading, loadingText,
  query: controlledQuery, onQueryChange, selectedId, onSelect, inputRef, readOnly,
}: SearchPickerProps) {
  const id = useId();
  const inputId = `${id}-input`;
  const listId = `${id}-list`;
  const list = useRef<HTMLDivElement>(null);
  const activeRow = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const [localQuery, setLocalQuery] = useState('');
  const [activeId, setActiveId] = useState<string>();
  const query = controlledQuery ?? localQuery;
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const results = sections.map(section => {
    let items = section.items;
    if (!section.prefiltered && tokens.length) {
      items = items.filter(item => {
        const searchable = [item.label, item.detail, item.keywords].filter(Boolean).join(' ').toLocaleLowerCase();
        return tokens.every(token => searchable.includes(token));
      });
    } else if (!tokens.length && section.initialLimit !== undefined) {
      items = items.slice(0, section.initialLimit);
    }
    return { ...section, items };
  }).filter(section => section.items.length > 0);
  const items = results.flatMap(section => section.items);
  const highlightedIndex = items.findIndex(item => item.id === activeId);
  const selectedIndex = selectedId ? items.findIndex(item => item.id === selectedId) : -1;
  const activeIndex = Math.max(0, highlightedIndex >= 0 ? highlightedIndex : selectedIndex);
  const active = items[activeIndex];
  const optionId = (item: SearchPickerItem) => `${listId}-${encodeURIComponent(item.id)}`;

  useLayoutEffect(() => {
    const viewport = list.current;
    const row = activeRow.current;
    if (!viewport || !row) return;
    const bounds = viewport.getBoundingClientRect();
    const option = row.getBoundingClientRect();
    if (option.top < bounds.top) viewport.scrollTop += option.top - bounds.top;
    else if (option.bottom > bounds.bottom) viewport.scrollTop += option.bottom - bounds.bottom;
  }, [active?.id, activeIndex, query]);

  function select(item: SearchPickerItem) {
    if (readOnly) return;
    setActiveId(item.id);
    onSelect(item.id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (active && !event.repeat) select(active);
    } else if (!readOnly && active && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveId(items[(activeIndex + step + items.length) % items.length].id);
    }
  }

  return <div className="search-picker">
    {showLabel && <label className="search-picker-label" htmlFor={inputId}>{inputLabel}</label>}
    <div className="search-picker-field">
      <Search size={17} aria-hidden="true" />
      <input id={inputId} ref={inputRef} role="combobox" aria-label={showLabel ? undefined : inputLabel}
        aria-autocomplete="list" aria-expanded="true" aria-controls={listId}
        aria-activedescendant={active && optionId(active)} autoComplete="off" spellCheck={false}
        placeholder={placeholder} value={query} readOnly={readOnly} onKeyDown={onKeyDown}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onChange={event => {
          if (controlledQuery === undefined) setLocalQuery(event.target.value);
          onQueryChange?.(event.target.value);
        }} />
    </div>
    <div className="search-picker-results">
      <div id={listId} ref={list} role="listbox" aria-label={resultsLabel} aria-busy={loading || undefined}
        aria-readonly={readOnly || undefined} className="search-picker-list">
        {results.map(section => <div key={section.id} role={section.label ? 'group' : 'presentation'} aria-label={section.label}>
          {section.label && <div className="search-picker-section" aria-hidden="true">{section.label}</div>}
          {section.items.map(item => {
            const selected = selectedId === undefined ? item === active : item.id === selectedId;
            return <div key={item.id} ref={item === active ? activeRow : undefined} id={optionId(item)}
              role="option" aria-selected={selected} data-active={item === active || undefined} className="search-picker-option"
              onMouseDown={event => event.preventDefault()} onClick={() => select(item)}>
              {item.icon && <span className="search-picker-icon" aria-hidden="true">{item.icon}</span>}
              <div className="search-picker-copy">
                <span title={item.label}>{item.label}</span>
                {item.detail && <small title={item.detail}>{item.detail}</small>}
              </div>
              {selectedId !== undefined && selected && <Check className="search-picker-check" size={15} aria-hidden="true" />}
            </div>;
          })}
        </div>)}
      </div>
      <p role="status" className="search-picker-status" data-has-options={active !== undefined || undefined}>
        {loading && loadingText ? loadingText : !active ? emptyText : ''}
      </p>
    </div>
  </div>;
}
