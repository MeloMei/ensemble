import type { ReactElement, ReactNode } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import './DetailCard.css';

const useDetailCardScope = Tooltip.createTooltipScope();

export function DetailCardProvider({ children }: { children: ReactNode }) {
  const scope = useDetailCardScope(undefined);
  return <Tooltip.Provider {...scope} delayDuration={550} skipDelayDuration={400}>
    {children}
  </Tooltip.Provider>;
}

export function DetailCard({ children, title, description, details, side }: {
  children: ReactElement;
  title: string;
  description: string;
  details: ReactNode;
  side: 'top' | 'right' | 'bottom' | 'left';
}) {
  const scope = useDetailCardScope(undefined);
  return <Tooltip.Root {...scope}>
    <Tooltip.Trigger {...scope} asChild>{children}</Tooltip.Trigger>
    <Tooltip.Portal {...scope}>
      <Tooltip.Content {...scope} className="ui-detail-card" side={side} align={side === 'right' || side === 'left' ? 'start' : 'center'}
        sideOffset={8} collisionPadding={10} aria-label={description}>
        <strong className="ui-detail-card-title">{title}</strong>
        <dl className="ui-detail-card-fields">{details}</dl>
      </Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>;
}
