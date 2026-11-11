import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, GitBranch, Plus } from 'lucide-react';
import type { CreateSessionInput, ProviderInfo, SessionLocations, Workspace } from '../shared/types';
import { PROMPT_TEXT_LIMIT } from '../shared/types';
import { providerForDirectory } from '../shared/provider-models';
import { AppSelect } from './AppSelect';
import { runSessionCommand } from './session-command';
import { BusyIcon, Modal, ModelField, ProviderSelect, defaultModelId, validModelSelection } from './ui';

const localBranchName = (ref: string) => ref.slice('refs/heads/'.length);

export function NewAgentDialog({ workspace, providers, running, onClose, onCreated }: {
  workspace: Workspace;
  providers: ProviderInfo[];
  running: number;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation('shell');
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [selection, setSelection] = useState(() => {
    const provider = providers.find(item => item.available);
    return { providerId: provider?.id ?? '', modelId: defaultModelId(provider) };
  });
  const { providerId, modelId } = selection;
  const [title, setTitle] = useState('');
  const [draft, setDraft] = useState('');
  const [locations, setLocations] = useState<SessionLocations>();
  const [locationMode, setLocationMode] = useState<'current' | 'registered' | 'managed'>('current');
  const [worktree, setWorktree] = useState('');
  const [fromRef, setFromRef] = useState('');
  const [locationError, setLocationError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [working, setWorking] = useState(false);
  const submitLock = useRef(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setLocations(undefined);
    setLocationError('');
    void window.workbench.sessionLocations(workspace.id).then(result => {
      if (!active) return;
      setLocations(result);
      setWorktree(result.worktrees[0]?.cwd ?? '');
      setFromRef(result.branches.find(ref => localBranchName(ref) === result.current.branch) ?? result.branches[0] ?? '');
      setLocationMode('current');
    }, error => { if (active) setLocationError(String(error instanceof Error ? error.message : error)); });
    return () => { active = false; };
  }, [workspace.id, workspace.cwd, reload]);

  const directory = locationMode === 'registered' ? locations?.worktrees.find(item => item.cwd === worktree)
    : locationMode === 'managed' ? locations?.managed : locations?.current;
  const provider = providerForDirectory(providers.find(item => item.id === providerId), directory?.cwd);
  const valid = Boolean(directory && validModelSelection(provider, modelId) && draft.length <= PROMPT_TEXT_LIMIT);
  const busyNote = locationMode === 'current' && running > 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!directory || !locations || !valid || working || submitLock.current) return;
    const choice = locationMode === 'current' ? { kind: 'current' as const, branch: directory.branch }
      : locationMode === 'registered' ? { kind: 'registered' as const, cwd: directory.cwd, branch: directory.branch }
      : locations.managed && { kind: 'managed' as const, ...locations.managed, fromRef };
    if (!choice) return;
    const input: CreateSessionInput = { cwd: workspace.cwd, providerId, ...(modelId ? { modelId } : {}),
      title: title.trim() || t('app.defaultSessionName', { provider: provider?.name ?? providerId }),
      ...(draft ? { initialDraft: draft } : {}),
      location: { workspaceId: workspace.id, choice } };
    submitLock.current = true;
    setWorking(true);
    setSubmitError('');
    void runSessionCommand(`create-session:${workspace.id}`, input, commandId => window.workbench.createSession({ ...input, commandId }))
      .then(id => { if (live.current) onCreated(id); }, error => {
        if (live.current) {
          const detail = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
          setSubmitError([error instanceof Error ? error.message : String(error), detail].filter(Boolean).join(' '));
        }
      }).finally(() => { submitLock.current = false; if (live.current) setWorking(false); });
  };

  return <Modal title={t('app.newAgentSession')} subtitle={workspace.name} busy={working} onClose={onClose}>
    <form onSubmit={submit}>
      <label>{t('common.agent')}<ProviderSelect providers={providers} value={providerId} disabled={working}
        onChange={id => setSelection({ providerId: id, modelId: defaultModelId(providers.find(item => item.id === id)) })} /></label>
      <ModelField provider={provider} value={modelId} disabled={working} onChange={value => setSelection(current => ({ ...current, modelId: value }))} />
      <label>{t('app.sessionName')}<span className="optional">{t('common.optional')}</span>
        <input value={title} maxLength={200} disabled={working} onChange={event => setTitle(event.target.value)} placeholder={t('app.sessionExample')} />
      </label>
      <label>{t('firstTask.draft')}<span className="optional">{t('common.optional')}</span>
        <textarea autoFocus value={draft} rows={3} maxLength={PROMPT_TEXT_LIMIT} disabled={working}
          onChange={event => setDraft(event.target.value)} placeholder={t('firstTask.draftHint')} />
      </label>
      <label>{t('app.sessionDirectory')}
        <AppSelect label={t('app.sessionDirectory')} value={locationMode} disabled={!locations || working}
          onChange={value => { setLocationMode(value as typeof locationMode); setSubmitError(''); }} options={[
            { value: 'current', label: t('app.sessionCurrentDirectory') },
            { value: 'registered', label: t('app.sessionExistingWorktree'), disabled: !locations?.worktrees.length },
            { value: 'managed', label: t('app.sessionNewWorktree'), disabled: !locations?.managed },
          ]} />
      </label>
      {locationMode === 'registered' && <label>{t('app.sessionExistingWorktree')}
        <AppSelect label={t('app.sessionExistingWorktree')} value={worktree} disabled={working} onChange={setWorktree}
          options={(locations?.worktrees ?? []).map(item => ({ value: item.cwd, label: item.cwd, description: item.branch ?? t('app.sessionDetached') }))} />
      </label>}
      {locationMode === 'managed' && <label>{t('app.sessionBaseBranch')}
        <AppSelect label={t('app.sessionBaseBranch')} value={fromRef} disabled={working} onChange={setFromRef}
          options={(locations?.branches ?? []).map(ref => ({ value: ref, label: localBranchName(ref) }))} />
      </label>}
      {directory && <>
        <div className="form-note"><Folder size={14} /><span>{directory.cwd}</span></div>
        {locations?.repository && <div className="form-note"><GitBranch size={14} /><span>{directory.branch ?? t('app.sessionDetached')}</span></div>}
      </>}
      {busyNote && <p className="form-note">{t(locations?.managed || locations?.worktrees.length ? 'app.sessionBusyWorktrees' : 'app.sessionBusy', { count: running })}</p>}
      {draft && <p className="form-note">{t('firstTask.openNote')}</p>}
      {!locations && !locationError && <p className="form-note" role="status">{t('app.sessionLocationsLoading')}</p>}
      {locationError && <p className="field-error" role="alert">{locationError}</p>}
      {submitError && <p className="field-error" role="alert">{submitError}</p>}
      <div className="modal-actions">
        {(locationError || submitError) && <button type="button" className="button subtle" disabled={working}
          onClick={() => { setSubmitError(''); setReload(value => value + 1); }}>{t('common.reload')}</button>}
        <button type="button" className="button subtle" disabled={working} onClick={onClose}>{t('common.cancel')}</button>
        <button className="button primary" disabled={!valid || working}><BusyIcon busy={working}><Plus size={14} /></BusyIcon>{t('app.createSession')}</button>
      </div>
    </form>
  </Modal>;
}
