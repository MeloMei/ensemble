import { useContext, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { OverlayContext } from '../overlays';
import { IconButton } from '../ui';
import { OperationFeedback } from './OperationFeedback';
import type { OperationNotice, useOperationFeedback } from './useOperationFeedback';

export function NotificationQueue({ feedback: { notices, pending, retry, dismiss }, fallbackFocus }: {
  feedback: ReturnType<typeof useOperationFeedback>;
  fallbackFocus: () => HTMLElement | null | undefined;
}) {
  const { t } = useTranslation('shell');
  const { top } = useContext(OverlayContext);
  const id = useId();
  const region = useRef<HTMLElement>(null);
  const priorFocus = useRef<HTMLElement>(null);
  useEffect(() => {
    const remember = (target: EventTarget | null) => {
      if (target instanceof HTMLElement && target !== document.body && !region.current?.contains(target)) priorFocus.current = target;
    };
    const onFocus = (event: FocusEvent) => remember(event.target);
    remember(document.activeElement);
    document.addEventListener('focusin', onFocus, true);
    return () => document.removeEventListener('focusin', onFocus, true);
  }, []);
  const close = (notice: OperationNotice, retried = false) => {
    const row = region.current?.querySelector<HTMLElement>(`[data-notification-id="${notice.id}"]`);
    if (row?.contains(document.activeElement)) {
      const neighbor = row.nextElementSibling ?? row.previousElementSibling;
      const next = neighbor?.querySelector<HTMLButtonElement>('[data-notification-dismiss]');
      if (next) next.focus();
      else {
        const targets = [retried ? notice.retry?.origin?.deref() : undefined, priorFocus.current];
        const restored = targets.some(target => {
          if (!target?.isConnected || (top && !top.contains(target))) return false;
          target.focus({ preventScroll: true });
          return document.activeElement === target;
        });
        if (!restored) {
          (top?.querySelector<HTMLElement>('.modal-heading button') ?? fallbackFocus())?.focus({ preventScroll: true });
        }
      }
    }
    dismiss(notice.id);
  };
  if (!notices.length) return null;
  return createPortal(<section ref={region} className="notification-queue" aria-label={t('feedback.notifications')}>
    <ol>{notices.map(notice => <li key={notice.id} data-notification-id={notice.id}
      onKeyDown={event => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.defaultPrevented) return;
        event.preventDefault(); event.stopPropagation(); close(notice);
      }}>
      <OperationFeedback state="error" messageId={`${id}-${notice.id}`} retry={notice.retry ? {
        pending: pending.has(notice.retry.key),
        run: () => { void retry(notice).then(success => { if (success) close(notice, true); }); },
      } : undefined}>{notice.message}</OperationFeedback>
      <IconButton data-notification-dismiss aria-describedby={`${id}-${notice.id}`} label={t('common.dismissNotice')}
        onClick={() => close(notice)}><X size={14} aria-hidden="true" /></IconButton>
    </li>)}</ol>
  </section>, top ?? document.body);
}
