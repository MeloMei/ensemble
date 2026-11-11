import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import type { GitState } from '../shared/types';
import { AppSelect } from './AppSelect';
import { Modal } from './ui';

const branchPrefix = 'refs/heads/';

export function GitBranchControl({ workspaceId, branch, blocked, onChanged }: {
  workspaceId: string; branch: string; blocked?: string; onChanged(state: GitState): void;
}) {
  const { t } = useTranslation('workspace');
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="review-text-button git-branch-control" disabled={Boolean(blocked)} title={blocked || branch}
      aria-label={t('files.gitBranchControl', { branch })} aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <span>{branch}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    {open && <BranchDialog workspaceId={workspaceId} current={branch} blocked={blocked} onChanged={onChanged} onClose={() => setOpen(false)} />}
  </>;
}

function BranchDialog({ workspaceId, current, blocked, onChanged, onClose }: {
  workspaceId: string; current: string; blocked?: string; onChanged(state: GitState): void; onClose(): void;
}) {
  const { t } = useTranslation('workspace');
  const [refs, setRefs] = useState<string[]>();
  const [choice, setChoice] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    let active = true;
    void window.workbench.gitBranchRefs(workspaceId).then(value => {
      if (active) setRefs(value.filter(ref => ref.startsWith(branchPrefix)).map(ref => ref.slice(branchPrefix.length)));
    }, failure => { if (active) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => { active = false; };
  }, [workspaceId]);

  const change = async (action: 'switch' | 'create', target: string) => {
    if (pending.current || blocked || !target || target === current) return;
    pending.current = true; setWorking(true); setError('');
    try {
      const state = await window.workbench.changeGitBranch(workspaceId, { action, name: target, expectedBranch: current });
      onChanged(state);
      onClose();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { pending.current = false; setWorking(false); }
  };

  return <Modal title={t('files.gitBranchTitle')} subtitle={t('files.gitBranchCurrent', { branch: current })} busy={working} onClose={onClose}>
    <div className="git-branch-dialog">
      {(blocked || error) && <p className="error-text" role="alert">{blocked || error}</p>}
      {!refs && !error && <p role="status">{t('files.branchCompareLoadingRefs')}</p>}
      <form onSubmit={event => { event.preventDefault(); void change('switch', choice); }}>
        <AppSelect label={t('files.gitBranchSelect')} value={choice} display={choice || t('files.gitBranchChoose')}
          disabled={working || Boolean(blocked) || !refs?.some(ref => ref !== current)} options={(refs ?? []).filter(ref => ref !== current).map(ref => ({ value: ref, label: ref }))} onChange={setChoice} />
        <button type="submit" className="button" disabled={working || Boolean(blocked) || !choice}>{t('files.gitBranchSwitch')}</button>
      </form>
      <form onSubmit={event => { event.preventDefault(); void change('create', name.trim()); }}>
        <input aria-label={t('files.gitBranchName')} placeholder={t('files.gitBranchName')} maxLength={256} value={name}
          disabled={working || Boolean(blocked)} onChange={event => setName(event.target.value)} />
        <button type="submit" className="button primary" disabled={working || Boolean(blocked) || !name.trim()}>{t('files.gitBranchCreate')}</button>
      </form>
    </div>
  </Modal>;
}
