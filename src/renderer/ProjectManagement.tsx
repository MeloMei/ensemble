import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, Ellipsis, FolderOpen, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import type { Workspace } from '../shared/types';
import { Tooltip } from './Tooltip';
import { Modal, type Perform } from './ui';
import './ProjectManagement.css';

const actionIcons = { edit: Pencil, archive: Archive, restore: RotateCcw, remove: Trash2 };
export type ProjectAction = keyof typeof actionIcons;

function isOrdinaryProject(workspace: Workspace) {
  return !workspace.worktree && !workspace.managedWorktreeAlias;
}

function projectActions(workspace: Workspace): ProjectAction[] {
  const ordinary = isOrdinaryProject(workspace);
  if (workspace.archived) return ordinary ? ['restore', 'remove'] : [];
  return ordinary ? ['edit', 'archive', 'remove'] : ['edit'];
}

export function ProjectRowActions({ workspace, disabled, onAction }: {
  workspace: Workspace;
  disabled?: boolean;
  onAction(action: ProjectAction): void;
}) {
  const { t } = useTranslation('shell');
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const openFromEnd = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const actions = projectActions(workspace);
  if (!actions.length) return null;
  const label = t('projectManagement.actions', { name: workspace.name });
  const menuId = `${id}-menu`;
  const anchor = `--project-actions-${id}`;
  const menuItems = () => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)') ?? []);
  const dismiss = () => {
    menu.current?.hidePopover();
    trigger.current?.focus({ preventScroll: true });
  };
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const { key } = event;
    if (key === 'Escape' || key === 'Tab') {
      if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
      dismiss();
      return;
    }
    if (key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'Home' && key !== 'End') return;
    event.preventDefault();
    const items = menuItems();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = key === 'Home' ? 0 : key === 'End' ? items.length - 1
      : (current + (key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    items[next]?.focus();
  };

  return <>
    <Tooltip label={label}><button ref={trigger} id={id} type="button" className="project-actions-trigger" disabled={disabled} style={{ anchorName: anchor }}
      aria-label={label} aria-haspopup="menu" aria-controls={menuId} aria-expanded={expanded}
      popoverTarget={menuId}
      onClick={event => {
        if (!menu.current?.matches(':popover-open')) event.currentTarget.focus({ preventScroll: true });
      }}
      onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        openFromEnd.current = event.key === 'ArrowUp';
        if (!menu.current?.matches(':popover-open')) event.currentTarget.click();
        else {
          const items = menuItems();
          items.at(openFromEnd.current ? -1 : 0)?.focus();
          openFromEnd.current = false;
        }
      }}><Ellipsis size={16} aria-hidden="true" /></button></Tooltip>
    <div ref={menu} id={menuId} popover="auto" role="menu" aria-labelledby={id} className="project-actions-menu" style={{ positionAnchor: anchor }}
      onToggle={event => {
        const isOpen = event.newState === 'open';
        setExpanded(isOpen);
        if (isOpen) menuItems().at(openFromEnd.current ? -1 : 0)?.focus({ preventScroll: true });
        openFromEnd.current = false;
      }}
      onKeyDown={navigate}>
      {actions.map(action => {
        const Icon = actionIcons[action];
        return <button key={action} type="button" role="menuitem" tabIndex={-1} disabled={disabled} data-action={action}
          onClick={() => { dismiss(); onAction(action); }}>
          <Icon size={14} aria-hidden="true" />{t(`projectManagement.${action}`)}
        </button>;
      })}
    </div>
  </>;
}

type Dialog = { workspace: Workspace; action: 'edit' | 'remove' };
type Run = (key: string, operation: () => Promise<unknown>, inline?: boolean) => Promise<void>;

export function useProjectManagement(perform: Perform): {
  open(workspace: Workspace, action: ProjectAction): void;
  busy: boolean;
  dialog: ReactNode;
} {
  const { t } = useTranslation('shell');
  const [target, setTarget] = useState<Dialog>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const run: Run = async (key, operation, inline = true) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await perform(key, async () => {
        try { await operation(); }
        catch (failure) {
          const raw = failure instanceof Error ? failure.message : String(failure);
          const message = raw.includes('WORKBENCH_UNSAVED_FILES') ? t('projectManagement.unsaved') : raw;
          if (!inline) throw new Error(message);
          setError(message);
        }
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const close = () => {
    if (busyRef.current) return;
    setTarget(undefined);
    setError('');
  };
  const open = (workspace: Workspace, action: ProjectAction) => {
    if (busyRef.current || target || !projectActions(workspace).includes(action)) return;
    if (action === 'edit' || action === 'remove') {
      setTarget({ workspace, action });
      return;
    }
    void run(`project-${action}`, () => window.workbench.manageWorkspace(workspace.id, { action }), false);
  };

  let dialog: ReactNode = null;
  if (target?.action === 'edit') {
    dialog = <ProjectEdit key={target.workspace.id} workspace={target.workspace} busy={busy} error={error} run={run} onClose={close} />;
  } else if (target?.action === 'remove') {
    const { workspace } = target;
    dialog = <Modal title={t('projectManagement.remove')} subtitle={t('projectManagement.removeNote', { name: workspace.name })} busy={busy} onClose={close}>
      <code className="project-management-path">{workspace.cwd}</code>
      {error && <p className="error-text project-management-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="button subtle" disabled={busy} onClick={close}>{t('common.cancel')}</button>
        <button type="button" className="button danger" disabled={busy} onClick={() => void run('project-remove', async () => {
          await window.workbench.manageWorkspace(workspace.id, { action: 'remove' });
          setTarget(undefined);
        })}>{t('projectManagement.confirmRemove')}</button>
      </div>
    </Modal>;
  }

  return { open, busy, dialog };
}

function ProjectEdit({ workspace, busy, error, run, onClose }: {
  workspace: Workspace;
  busy: boolean;
  error: string;
  run: Run;
  onClose(): void;
}) {
  const { t } = useTranslation('shell');
  const [name, setName] = useState(workspace.name);
  const [savedName, setSavedName] = useState(workspace.name);
  const [cwd, setCwd] = useState(workspace.cwd);
  const [destination, setDestination] = useState<string>();
  const nextName = name.trim();
  const canRename = nextName && nextName !== savedName;

  return <Modal title={t('projectManagement.edit')} busy={busy} onClose={onClose}>
    <form className="project-management-name" onSubmit={event => {
      event.preventDefault();
      if (!canRename) return;
      void run('project-rename', async () => {
        await window.workbench.updateWorkspace(workspace.id, { name: nextName });
        setSavedName(nextName);
        setName(nextName);
      });
    }}>
      <label>{t('projectManagement.name')}<input name="project-name" maxLength={200} required value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <button type="submit" className="button" disabled={busy || !canRename}>{t('projectManagement.rename')}</button>
    </form>
    <div className="project-management-directory">
      <div>
        <strong>{t('common.projectDirectory')}</strong>
        <code className="project-management-path">{cwd}</code>
      </div>
      {isOrdinaryProject(workspace) && <button type="button" className="button" disabled={busy} onClick={() => void run('project-choose-directory', async () => {
        const chosen = await window.workbench.chooseDirectory();
        if (chosen) setDestination(chosen === cwd ? undefined : chosen);
      })}><FolderOpen size={14} aria-hidden="true" />{t('projectManagement.relocate')}</button>}
    </div>
    {destination && <div className="project-management-destination">
      <strong>{t('projectManagement.newDirectory')}</strong>
      <code className="project-management-path">{destination}</code>
      <p className="form-note">{t('projectManagement.relocateNote')}</p>
      <button type="button" className="button primary" disabled={busy} onClick={() => void run('project-relocate', async () => {
        await window.workbench.manageWorkspace(workspace.id, { action: 'relocate', cwd: destination });
        setCwd(destination);
        setDestination(undefined);
      })}>{t('projectManagement.confirmRelocate')}</button>
    </div>}
    {error && <p className="error-text project-management-error" role="alert">{error}</p>}
  </Modal>;
}
