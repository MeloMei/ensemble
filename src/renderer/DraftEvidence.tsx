import { ArrowUpRight, FileText, Link2, X } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { DraftEvidence, DraftEvidenceSource, Session } from '../shared/types';
import { BusyIcon, IconButton, Modal } from './ui';
import './DraftEvidence.css';

export function DraftTargetDialog({ title, sourceLabel, preview, sessions, onAdd, onClose, submitLabel }: {
  title: string; sourceLabel: string; preview?: ReactNode; sessions: Session[]; onAdd: (sessionId: string) => Promise<void>;
  onClose: () => void; submitLabel?: string;
}) {
  const { t } = useTranslation('workspace');
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const options = sessions.filter(item => !item.archived);
  const labels = new Map<string, number>();
  for (const item of options) {
    const label = `${item.title} · ${item.cwd}`;
    labels.set(label, (labels.get(label) ?? 0) + 1);
  }
  const canSubmit = options.some(item => item.id === target);
  const submit = async () => {
    if (!canSubmit || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try { await onAdd(target); onClose(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <Modal title={title} subtitle={t('evidence.draftOnly')} busy={busy} onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="draft-evidence-review"><strong>{sourceLabel}</strong>{preview}</div>
      <label>{t('evidence.targetSession')}<select autoFocus value={target} disabled={busy || !options.length}
        onChange={event => setTarget(event.target.value)} required>
        <option value="" disabled>{t(options.length ? 'evidence.chooseSession' : 'evidence.noSessions')}</option>
        {options.map(item => {
          const label = `${item.title} · ${item.cwd}`;
          return <option key={item.id} value={item.id}>{(labels.get(label) ?? 0) > 1 ? `${label} · ${item.id.slice(0, 8)}` : label}</option>;
        })}
      </select></label>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
        <button type="submit" className="button primary" disabled={busy || !canSubmit}>
          <BusyIcon busy={busy}><FileText size={14} /></BusyIcon>{submitLabel ?? t('evidence.addToDraft')}
        </button></div>
    </form>
  </Modal>;
}

export function EvidenceTargetDialog({ reference, sessions, onAdd, onClose }: {
  reference: DraftEvidence; sessions: Session[]; onAdd: (sessionId: string, reference: DraftEvidence) => Promise<void>; onClose: () => void;
}) {
  const { t } = useTranslation('workspace');
  const { source } = reference;
  return <DraftTargetDialog title={t('evidence.chooseTarget')} sourceLabel={reference.label} sessions={sessions}
    preview={<><pre>{reference.excerpt}</pre>{source.kind === 'preview' && <pre>{source.url}{'\n'}{source.selector}</pre>}</>}
    onAdd={id => onAdd(id, reference)} onClose={onClose} />;
}

export function DraftEvidenceCards({ evidence, onOpen, onRemove }: {
  evidence?: DraftEvidence[]; onOpen?: (source: DraftEvidenceSource) => void; onRemove?: (id: string) => void;
}) {
  const { t } = useTranslation('workspace');
  if (!evidence?.length) return null;
  return <ul className="draft-evidence-cards" aria-label={t('evidence.references')}>
    {evidence.map(item => <li key={item.id}>
      <div className="draft-evidence-card-heading"><Link2 size={13} aria-hidden="true" /><strong title={item.label}>{item.label}</strong>
        {onOpen && <IconButton label={t('evidence.openSource')} onClick={() => onOpen(item.source)}><ArrowUpRight size={13} /></IconButton>}
        {onRemove && <IconButton label={t('evidence.removeReference', { label: item.label })} onClick={() => onRemove(item.id)}><X size={13} /></IconButton>}
      </div>
      <pre tabIndex={0}>{item.excerpt}</pre>
    </li>)}
  </ul>;
}
