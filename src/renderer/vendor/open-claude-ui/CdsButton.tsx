// Adapted from Caho1/open-claude-ui@4045ce76afdcb7dccef1b7e6417b04c4c6046e9c.
// Copyright (c) 2026 Caho1. MIT: licenses/Open-Claude-UI-MIT.txt.
// Replaces Tailwind classes with Ensemble tokens; retains separate paint and content layers.
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';

export interface CdsButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg' | 'icon';
  icon?: ReactNode;
  iconPosition?: 'left' | 'right';
  isLoading?: boolean;
  indicator?: ReactNode;
}

export const CdsButton = forwardRef<HTMLButtonElement, CdsButtonProps>(function CdsButton({
  variant = 'secondary', size = 'md', icon, iconPosition = 'left', isLoading = false,
  indicator, disabled = false, className = '', children, type = 'button', ...props
}, ref) {
  return <button {...props} ref={ref} type={type} disabled={disabled || isLoading}
    data-cds="Button" className={`cds-control cds-control-${variant} cds-control-${size} ${className}`}>
    <span aria-hidden="true" data-cds-part="paint" />
    {isLoading ? <LoaderCircle size={15} className="spin" /> : icon && iconPosition === 'left' ? icon : null}
    {children}
    {!isLoading && icon && iconPosition === 'right' && icon}
    {indicator && <span className="cds-control-indicator">{indicator}</span>}
  </button>;
});
