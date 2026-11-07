import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, FolderOpen, RotateCcw, Trash2 } from 'lucide-react';
import type { Workspace, WorkspaceManagement } from '../shared/types';
import { Modal } from './ui';

export function ProjectManagement({ workspace, archived, disabled, guardProjectEdits, onBusyChange, onRestored }: {
  workspace?: Workspace;
  archived: Workspace[];
  disabled: boolean;
  guardProjectEdits(action: () => void): void;
  onBusyChange(busy: boolean): void;
  onRestored(id: string): void;
}) {
  const { t } = useTranslation('shell');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [removal, setRemoval] = useState<Workspace>();
  const [relocation, setRelocation] = useState<{ workspace: Workspace; cwd: string }>();

  const run = async (action: () => Promise<void>) => {
    if (busyRef.current || disabled) return;
    busyRef.current = true; setBusy(true); onBusyChange(true); setError('');
    try { await action(); }
    catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      setError(message.includes('WORKBENCH_UNSAVED_FILES') ? t('projectManagement.unsaved') : message);
    }
    finally { busyRef.current = false; setBusy(false); onBusyChange(false); }
  };
  const manage = (target: Workspace, input: WorkspaceManagement) => {
    const apply = () => void run(async () => {
      await window.workbench.manageWorkspace(target.id, input);
      setRemoval(undefined); setRelocation(undefined);
      if (input.action === 'restore') onRestored(target.id);
    });
    if (input.action === 'restore' || target.id === workspace?.id) guardProjectEdits(apply);
    else apply();
  };

  return <section className="project-management">
    {workspace && !workspace.worktree && !workspace.managedWorktreeAlias && <>
      <form className="project-management-name" onSubmit={event => {
        event.preventDefault();
        const name = String(new FormData(event.currentTarget).get('project-name') ?? '').trim();
        if (!name || name === workspace.name) return;
        void run(() => window.workbench.updateWorkspace(workspace.id, { name }));
      }}>
        <label>{t('projectManagement.name')}<input key={JSON.stringify([workspace.id, workspace.name])} name="project-name" maxLength={200} required defaultValue={workspace.name} disabled={busy || disabled} /></label>
        <button className="button small" disabled={busy || disabled}>{t('projectManagement.rename')}</button>
      </form>
      <div className="project-management-row">
        <div><strong>{t('common.projectDirectory')}</strong><code>{workspace.cwd}</code></div>
        <button className="button small" disabled={busy || disabled} onClick={() => void run(async () => {
          const cwd = await window.workbench.chooseDirectory();
          if (cwd && cwd !== workspace.cwd) setRelocation({ workspace, cwd });
        })}><FolderOpen size={14} />{t('projectManagement.relocate')}</button>
      </div>
      <div className="project-management-actions">
        <button className="button small" disabled={busy || disabled} onClick={() => void manage(workspace, { action: 'archive' })}><Archive size={14} />{t('projectManagement.archive')}</button>
        <button className="button small danger" disabled={busy || disabled} onClick={() => { setError(''); setRemoval(workspace); }}><Trash2 size={14} />{t('projectManagement.remove')}</button>
      </div>
    </>}
    <div className="project-management-archived">
      <h4>{t('projectManagement.archived')}</h4>
      {archived.length === 0 ? <p className="pane-note">{t('projectManagement.noArchived')}</p> : archived.map(item => <div key={item.id} className="project-management-row">
        <div><strong>{item.name}</strong><code>{item.cwd}</code></div>
        <div className="project-management-actions">
          <button className="button small" disabled={busy || disabled} aria-label={t('projectManagement.restoreNamed', { name: item.name })} onClick={() => void manage(item, { action: 'restore' })}><RotateCcw size={14} />{t('projectManagement.restore')}</button>
          <button className="button small danger" disabled={busy || disabled} aria-label={t('projectManagement.removeNamed', { name: item.name })} onClick={() => { setError(''); setRemoval(item); }}><Trash2 size={14} />{t('projectManagement.remove')}</button>
        </div>
      </div>)}
    </div>
    {error && !removal && !relocation && <p className="error-text" role="alert">{error}</p>}
    {relocation && <Modal title={t('projectManagement.relocate')} subtitle={t('projectManagement.relocateNote')} busy={busy} onClose={() => { setRelocation(undefined); setError(''); }}>
      <code className="project-management-path">{relocation.cwd}</code>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="modal-actions"><button className="button subtle" disabled={busy} onClick={() => { setRelocation(undefined); setError(''); }}>{t('common.cancel')}</button>
        <button className="button primary" disabled={busy} onClick={() => void manage(relocation.workspace, { action: 'relocate', cwd: relocation.cwd })}>{t('projectManagement.confirmRelocate')}</button></div>
    </Modal>}
    {removal && <Modal title={t('projectManagement.remove')} subtitle={t('projectManagement.removeNote', { name: removal.name })} busy={busy} onClose={() => { setRemoval(undefined); setError(''); }}>
      <code className="project-management-path">{removal.cwd}</code>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="modal-actions"><button className="button subtle" disabled={busy} onClick={() => { setRemoval(undefined); setError(''); }}>{t('common.cancel')}</button>
        <button className="button danger" disabled={busy} onClick={() => void manage(removal, { action: 'remove' })}>{t('projectManagement.confirmRemove')}</button></div>
    </Modal>}
  </section>;
}
