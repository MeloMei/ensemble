import { useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Ellipsis } from 'lucide-react';
import { Tooltip } from '../Tooltip';
import './RowActionMenu.css';

export interface RowAction {
  id: string;
  label: string;
  icon?: ReactNode;
  role?: 'menuitemcheckbox' | 'menuitemradio';
  checked?: boolean;
  select(): void;
}

export function RowActionMenu({ label, items, disabled, triggerRef }: {
  label: string;
  items: RowAction[];
  disabled?: boolean;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const id = useId();
  const localTrigger = useRef<HTMLButtonElement>(null);
  const trigger = triggerRef ?? localTrigger;
  const menu = useRef<HTMLDivElement>(null);
  const openFromEnd = useRef(false);
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;
  const menuId = `${id}-menu`;
  const anchor = `--row-actions-${id}`;
  const menuItems = () => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role^=menuitem]:not(:disabled)') ?? []);
  const dismiss = () => {
    menu.current?.hidePopover();
    trigger.current?.focus({ preventScroll: true });
  };
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const { key } = event;
    if (key === 'Escape' || key === 'Tab') {
      if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
      dismiss();
      return;
    }
    if (key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'Home' && key !== 'End') return;
    event.preventDefault();
    const items = menuItems();
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = key === 'Home' ? 0 : key === 'End' ? items.length - 1
      : (current + (key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    items[next]?.focus();
  };

  return <>
    <Tooltip label={label}><button ref={trigger} id={id} type="button" className="row-actions-trigger" disabled={disabled} style={{ anchorName: anchor }}
      aria-label={label} aria-haspopup="menu" aria-controls={menuId} aria-expanded={expanded}
      popoverTarget={menuId}
      onClick={event => {
        if (!menu.current?.matches(':popover-open')) event.currentTarget.focus({ preventScroll: true });
      }}
      onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        openFromEnd.current = event.key === 'ArrowUp';
        if (!menu.current?.matches(':popover-open')) event.currentTarget.click();
        else {
          menuItems().at(openFromEnd.current ? -1 : 0)?.focus();
          openFromEnd.current = false;
        }
      }}><Ellipsis size={16} aria-hidden="true" /></button></Tooltip>
    <div ref={menu} id={menuId} popover="auto" role="menu" aria-labelledby={id} className="row-actions-menu" style={{ positionAnchor: anchor }}
      onToggle={event => {
        const isOpen = event.newState === 'open';
        setExpanded(isOpen);
        if (isOpen) menuItems().at(openFromEnd.current ? -1 : 0)?.focus({ preventScroll: true });
        openFromEnd.current = false;
      }}
      onKeyDown={navigate}>
      {items.map(item => <button key={item.id} type="button" role={item.role ?? 'menuitem'} tabIndex={-1} disabled={disabled}
        data-action={item.id} aria-checked={item.role ? item.checked : undefined}
        onClick={() => { dismiss(); item.select(); }}>
        {item.icon}{item.label}
      </button>)}
    </div>
  </>;
}
