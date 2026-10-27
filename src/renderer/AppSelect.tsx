import { useContext, useEffect, useId, useState, type AriaAttributes, type ReactNode } from 'react';
import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { OverlayContext } from './overlays';
import './AppSelect.css';

export interface AppSelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

interface AppSelectProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: AppSelectOption[];
  disabled?: boolean;
  required?: boolean;
  id?: string;
  name?: string;
  className?: string;
  menuClassName?: string;
  icon?: ReactNode;
  display?: string;
  hint?: string;
  compact?: boolean;
  side?: 'top' | 'bottom';
  'aria-invalid'?: AriaAttributes['aria-invalid'];
  'aria-describedby'?: string;
}

export function AppSelect({ label, value, onChange, options, disabled, required, id, name, className = '', menuClassName = '', icon,
  display, hint, compact = false, side = 'bottom', ...aria }: AppSelectProps) {
  const [open, setOpen] = useState(false);
  const descriptionId = useId();
  const { top } = useContext(OverlayContext);
  const selectedLabel = display ?? options.find(option => option.value === value)?.label ?? value;
  const selectedValue = required && value === '' ? '' : `choice:${value}`;
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  return <><Select.Root value={selectedValue} disabled={disabled} required={required}
    open={open && !disabled} onOpenChange={setOpen}
    onValueChange={next => { if (!disabled) onChange(next.slice('choice:'.length)); }}>
    <Select.Trigger id={id} className={`${compact ? 'composer-select' : 'app-select'} ${className}`} aria-label={label}
      title={disabled && hint ? hint : undefined} {...aria}>
      {icon}<span className={compact ? 'composer-select-value' : 'app-select-value'}><Select.Value>{selectedLabel}</Select.Value></span>
      <Select.Icon asChild><ChevronDown size={compact ? 11 : 13} aria-hidden="true" /></Select.Icon>
    </Select.Trigger>
    <Select.Portal container={top ?? document.body}>
      <Select.Content className={`app-select-menu ${compact ? 'app-select-menu-compact' : ''} ${menuClassName}`}
        position="popper" side={side} align="start" sideOffset={6} collisionPadding={10} aria-label={label}>
        <Select.ScrollUpButton className="app-select-scroll"><ChevronUp size={12} /></Select.ScrollUpButton>
        <Select.Viewport className="app-select-viewport">
          <Select.Group>
            <Select.Label className="app-select-heading">{label}</Select.Label>
            {options.map((option, index) => <Select.Item key={option.value} value={`choice:${option.value}`} data-value={option.value}
              aria-describedby={option.description ? `${descriptionId}-${index}` : undefined}
              className="app-select-option" disabled={option.disabled} textValue={option.label}>
              <span className="app-select-option-copy"><Select.ItemText>{option.label}</Select.ItemText>
                {option.description && <small id={`${descriptionId}-${index}`}>{option.description}</small>}</span>
              <Select.ItemIndicator className="app-select-check"><Check size={13} /></Select.ItemIndicator>
            </Select.Item>)}
          </Select.Group>
        </Select.Viewport>
        <Select.ScrollDownButton className="app-select-scroll"><ChevronDown size={12} /></Select.ScrollDownButton>
      </Select.Content>
    </Select.Portal>
  </Select.Root>{name && <input type="hidden" name={name} value={value} disabled={disabled} />}</>;
}
