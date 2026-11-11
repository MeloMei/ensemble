import { useId, type HTMLAttributes, type ReactNode } from 'react';
import { CircleAlert, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import './OperationFeedback.css';

export interface OperationRetry {
  run(button: HTMLButtonElement): void;
  pending?: boolean;
  label?: string;
}

export function OperationFeedback({ children, state = 'status', className, retry, messageId, ...attributes }: HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  state?: 'status' | 'progress' | 'error';
  retry?: OperationRetry;
  messageId?: string;
}) {
  const { t } = useTranslation('shell');
  const generatedId = useId();
  const id = messageId ?? generatedId;
  const progress = state === 'progress';
  const error = state === 'error';
  return <div {...attributes} className={`operation-feedback${className ? ` ${className}` : ''}`} data-state={state}>
    <div className="operation-feedback-message" id={id} role={error ? 'alert' : 'status'}>
      {progress && <LoaderCircle size={13} className="spin" aria-hidden="true" />}
      {error && <CircleAlert size={14} aria-hidden="true" />}
      <span>{children}</span>
    </div>
    {retry && <button type="button" className="button small subtle operation-feedback-retry"
      aria-disabled={retry.pending || undefined} aria-busy={retry.pending || undefined} aria-describedby={id}
      onClick={event => { if (!retry.pending) retry.run(event.currentTarget); }}>
      {retry.pending && <LoaderCircle size={12} className="spin" aria-hidden="true" />}
      {retry.label ?? t('feedback.retry')}
    </button>}
  </div>;
}
