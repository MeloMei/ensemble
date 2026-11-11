import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GitSyncRequest, GitSyncState } from '../shared/types';
import { AppSelect } from './AppSelect';
import { Modal } from './ui';

export function GitSyncControl({ workspaceId, pullBlocked, onPull }: { workspaceId: string; pullBlocked: boolean; onPull(): void }) {
  const { t } = useTranslation('workspace');
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="review-text-button" onClick={() => setOpen(true)}>{t('files.gitSync')}</button>
    {open && <SyncDialog workspaceId={workspaceId} pullBlocked={pullBlocked} onPull={onPull} onClose={() => setOpen(false)} />}
  </>;
}

function SyncDialog({ workspaceId, pullBlocked, onPull, onClose }: { workspaceId: string; pullBlocked: boolean; onPull(): void; onClose(): void }) {
  const { t } = useTranslation('workspace');
  const [state, setState] = useState<GitSyncState>();
  const [choice, setChoice] = useState('');
  const [working, setWorking] = useState<GitSyncRequest['action']>();
  const [completed, setCompleted] = useState<GitSyncRequest['action']>();
  const [error, setError] = useState('');
  const pending = useRef(false);
  useEffect(() => {
    let current = true;
    void window.workbench.gitSyncState(workspaceId).then(value => {
      if (!current) return;
      setState(value);
      setChoice(value.remotes.includes('origin') ? 'origin' : value.remotes[0] ?? '');
    }, failure => { if (current) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => { current = false; };
  }, [workspaceId]);

  const branch = state?.branch;
  const upstream = state?.upstream;
  const remote = upstream?.remote ?? choice;
  const target = upstream?.ref.slice('refs/heads/'.length) ?? branch;
  const sync = async (action: GitSyncRequest['action']) => {
    if (pending.current || !branch || !remote || (action === 'pull' && (pullBlocked || !upstream))) return;
    pending.current = true; setWorking(action); setCompleted(undefined); setError('');
    try {
      const value = await window.workbench.syncGit(workspaceId, { action, remote, expectedBranch: branch });
      setState(value); setCompleted(action);
      if (action === 'pull') onPull();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { pending.current = false; setWorking(undefined); }
  };

  return <Modal title={t('files.gitSync')} busy={Boolean(working)} onClose={onClose}>
    <div className="git-sync-dialog">
      {error && <p className="error-text" role="alert">{error}</p>}
      {!state && !error && <p role="status">{t('files.gitSyncReading')}</p>}
      {state && (!branch ? <p>{t('files.gitSyncBranchRequired')}</p> : !state.remotes.length ? <p>{t('files.gitSyncNoRemote')}</p> : <>
        <p>{t('files.gitSyncTarget', { branch, remote, target })}</p>
        {!upstream && <AppSelect label={t('files.gitSyncRemote')} value={choice} disabled={Boolean(working)}
          options={state.remotes.map(value => ({ value, label: value }))} onChange={setChoice} />}
        {upstream?.ahead !== undefined && upstream.behind !== undefined
          ? <p>{t('files.gitSyncCounts', { ahead: upstream.ahead, behind: upstream.behind })}</p>
          : <p>{t(upstream ? 'files.gitSyncFetchForCounts' : 'files.gitSyncNoUpstream')}</p>}
        {pullBlocked && <p>{t('files.gitSyncPullBlocked')}</p>}
        {working && <p role="status">{t(`files.gitSyncWorking.${working}`)}</p>}
        {completed && <p role="status">{t(`files.gitSyncDone.${completed}`)}</p>}
        <div className="git-sync-actions">
          <button type="button" className="button" disabled={Boolean(working) || !remote} onClick={() => void sync('fetch')}>{t('files.gitSyncFetch')}</button>
          <button type="button" className="button" disabled={Boolean(working) || !upstream || pullBlocked} onClick={() => void sync('pull')}>{t('files.gitSyncPull')}</button>
          <button type="button" className="button primary" disabled={Boolean(working) || !remote} onClick={() => void sync('push')}>{t(upstream ? 'files.gitSyncPush' : 'files.gitSyncPublish')}</button>
        </div>
      </>)}
    </div>
  </Modal>;
}
