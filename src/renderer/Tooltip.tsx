import { cloneElement, useContext, type ReactElement, type ReactNode } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { OverlayContext } from './overlays';
import './Tooltip.css';

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={350} skipDelayDuration={100}>{children}</TooltipPrimitive.Provider>;
}

export function Tooltip({ label, children }: { label: string; children: ReactElement<{ title?: string }> }) {
  const { top } = useContext(OverlayContext);
  return <TooltipPrimitive.Root>
    <TooltipPrimitive.Trigger asChild>{cloneElement(children, { title: undefined })}</TooltipPrimitive.Trigger>
    <TooltipPrimitive.Portal container={top ?? document.body}>
      <TooltipPrimitive.Content className="ensemble-tooltip" sideOffset={7} collisionPadding={8}>
        {label}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  </TooltipPrimitive.Root>;
}
