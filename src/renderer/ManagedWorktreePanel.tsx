import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GitBranch, LoaderCircle, Trash2 } from 'lucide-react';
import type { Workspace } from '../shared/types';
import './RuntimeHealth.css';

export function ManagedWorktreePanel({ workspace, onRemoved }: { workspace: Workspace; onRemoved: () => void }) {
  const { t } = useTranslation('runtime');
  const [confirmedIdentity, setConfirmedIdentity] = useState<string>();
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState('');
  const removingRef = useRef(false);
  const identity = JSON.stringify([workspace.id, workspace.worktree?.path, workspace.worktree?.branch, workspace.worktree?.baseSha, workspace.worktree?.status]);
  const confirming = confirmedIdentity === identity;
  useEffect(() => { setConfirmedIdentity(undefined); setError(''); }, [identity]);
  const worktree = workspace.worktree;
  if (!worktree) return null;
  const remove = async () => {
    if (!confirming || removingRef.current) return;
    removingRef.current = true; setRemoving(true); setError('');
    try { await window.workbench.removeWorktree(workspace.id); onRemoved(); }
    catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      setError(message.includes('WORKBENCH_UNSAVED_FILES') ? t('worktree.unsavedNote') : message);
      setConfirmedIdentity(undefined);
    }
    finally { removingRef.current = false; setRemoving(false); }
  };
  return <section className="managed-worktree-panel" aria-label={t('worktree.title')}>
    <h3><GitBranch size={15} />{t('worktree.title')}</h3>
    <dl><div><dt>{t('worktree.directory')}</dt><dd><code>{worktree.path}</code></dd></div>
      {workspace.cwd !== worktree.path && <div><dt>{t('worktree.executionDirectory')}</dt><dd><code>{workspace.cwd}</code></dd></div>}
      <div><dt>{t('worktree.branch')}</dt><dd><code>{worktree.branch}</code></dd></div>
      <div><dt>{t('worktree.source')}</dt><dd><code>{worktree.repoRoot}</code></dd></div>
      <div><dt>{t('worktree.base')}</dt><dd><code>{worktree.baseSha}</code></dd></div></dl>
    <p className="pane-note">{t('worktree.removeNote')}</p>
    {worktree.status === 'removing' && <p className="pane-note" role="status">{t('worktree.removingNote')}</p>}
    {!confirming ? <button className="button danger small" disabled={removing} onClick={() => setConfirmedIdentity(identity)}><Trash2 size={13} />{t(worktree.status === 'removing' ? 'worktree.resumeRemoval' : 'worktree.reviewRemoval')}</button>
      : <div className="worktree-removal-confirm" role="group" aria-label={t('worktree.confirmTitle')}>
        <p>{t('worktree.confirmNote')}</p><dl><div><dt>{t('worktree.directory')}</dt><dd><code>{worktree.path}</code></dd></div>
          <div><dt>{t('worktree.branch')}</dt><dd><code>{worktree.branch}</code></dd></div></dl>
        <div className="runtime-panel-actions"><button className="button small" disabled={removing} onClick={() => setConfirmedIdentity(undefined)}>{t('worktree.cancel')}</button>
          <button className="button danger small" disabled={removing} onClick={() => void remove()}>{removing ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}{t('worktree.confirmRemove')}</button></div>
      </div>}
    {error && <p className="runtime-panel-error" role="alert">{error}</p>}
  </section>;
}
