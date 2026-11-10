import { ArrowUpRight, FileText, Link2, X } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { DraftEvidence, DraftEvidenceSource, Session, Workspace } from '../shared/types';
import { AgentIcon } from './AgentIcon';
import { BusyIcon, IconButton, Modal } from './ui';
import { SearchPicker } from './ui-kit';
import './DraftEvidence.css';

export function DraftTargetDialog({ title, sourceLabel, preview, sessions, workspaces = [], onAdd, onClose, submitLabel }: {
  title: string; sourceLabel: string; preview?: ReactNode; sessions: readonly Session[]; workspaces?: readonly Workspace[];
  onAdd: (sessionId: string) => Promise<void>;
  onClose: () => void; submitLabel?: string;
}) {
  const { t } = useTranslation('workspace');
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const search = useRef<HTMLInputElement>(null);
  const activeSessions = sessions.filter(item => !item.archived);
  const projectNames = new Map(workspaces.map(project => [project.cwd, project.name]));
  const counts = new Map<string, number>();
  const labelKey = (item: Session) => JSON.stringify([item.title, item.cwd]);
  for (const item of activeSessions) {
    const key = labelKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const items = activeSessions.map(item => ({
    id: item.id,
    label: item.title,
    detail: [(counts.get(labelKey(item)) ?? 0) > 1 ? item.id : undefined, projectNames.get(item.cwd), item.cwd].filter(Boolean).join(' · '),
    icon: <AgentIcon providerId={item.providerId} />,
  }));
  const canSubmit = activeSessions.some(item => item.id === target);
  const submit = async () => {
    if (!canSubmit || pending.current) return;
    pending.current = true;
    search.current?.focus({ preventScroll: true });
    setBusy(true);
    setError('');
    try { await onAdd(target); onClose(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <Modal title={title} subtitle={t('evidence.draftOnly')} className="draft-target-dialog" initialFocus={search} busy={busy} onClose={onClose}>
    <div className="draft-evidence-review"><strong>{sourceLabel}</strong>{preview}</div>
    <SearchPicker sections={[{ id: 'sessions', items }]} inputRef={search} showLabel
      inputLabel={t('evidence.targetSession')} resultsLabel={t('evidence.targetSession')} placeholder={t('evidence.chooseSession')}
      emptyText={t(items.length ? 'evidence.noMatchingSessions' : 'evidence.noSessions')}
      readOnly={busy || !items.length} selectedId={target} onQueryChange={() => setTarget('')} onSelect={setTarget} />
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
      <button type="button" className="button primary" disabled={busy || !canSubmit} onClick={() => void submit()}>
        <BusyIcon busy={busy}><FileText size={14} /></BusyIcon>{submitLabel ?? t('evidence.addToDraft')}
      </button></div>
  </Modal>;
}

export function EvidenceTargetDialog({ reference, sessions, workspaces, onAdd, onClose }: {
  reference: DraftEvidence; sessions: readonly Session[]; workspaces?: readonly Workspace[];
  onAdd: (sessionId: string, reference: DraftEvidence) => Promise<void>; onClose: () => void;
}) {
  const { t } = useTranslation('workspace');
  const { source } = reference;
  return <DraftTargetDialog title={t('evidence.chooseTarget')} sourceLabel={reference.label} sessions={sessions} workspaces={workspaces}
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
