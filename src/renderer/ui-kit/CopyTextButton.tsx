import { Check, CircleAlert, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { IconButton } from '../ui';
import './CopyTextButton.css';

export interface CopyTextLabels {
  copy: string;
  copied: string;
  failed: string;
}

export function CopyTextButton({ text, labels, iconOnly }: { text: string; labels: CopyTextLabels; iconOnly?: boolean }) {
  const [feedback, setFeedback] = useState<{ outcome: 'copied' | 'failed' }>();
  const copying = useRef(false);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(undefined), 2000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  async function copyText() {
    if (copying.current) return;
    copying.current = true;
    setFeedback(undefined);
    try {
      await navigator.clipboard.writeText(text);
      setFeedback({ outcome: 'copied' });
    } catch {
      setFeedback({ outcome: 'failed' });
    } finally {
      copying.current = false;
    }
  }

  const outcome = feedback?.outcome;
  const label = outcome ? labels[outcome] : labels.copy;
  const Glyph = outcome === 'copied' ? Check : outcome === 'failed' ? CircleAlert : Copy;

  return <>
    {iconOnly
      ? <IconButton label={labels.copy} title={label} onClick={() => void copyText()}><Glyph size={14} aria-hidden="true" /></IconButton>
      : <button type="button" className="ui-copy-text-button" aria-label={labels.copy} onClick={() => void copyText()}>
        <Glyph size={13} aria-hidden="true" />{label}
      </button>}
    <span className="ui-copy-text-status" role="status">{outcome && label}</span>
  </>;
}
