import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderCog, MessageCircle, Palette, Plug } from 'lucide-react';
import type { Session, Snapshot, Workspace } from '../shared/types';
import { ThemeOptions } from './appearance';
import { LanguageOptions } from './language';
import { ApplicationUpdateSettings, type useApplicationUpdates } from './ApplicationUpdates';
import { AppSelect } from './AppSelect';
import { ProvidersContent } from './WorkflowViews';
import { WorkspaceToolsPanel, type WorkspaceToolsHandle } from './WorkspaceTools';
import { SessionSettingsPanel } from './SessionChat';
import { Modal, type Perform } from './ui';
import './SettingsDialog.css';

export type SettingsSection = 'general' | 'providers' | 'project' | 'session';

export function SettingsDialog({ snapshot, workspace, sessions, session, perform, pending, updates, initialSection, openSession, onClose }: {
  snapshot: Snapshot | null;
  workspace?: Workspace;
  sessions: Session[];
  session?: Session;
  perform: Perform;
  pending: Set<string>;
  updates: ReturnType<typeof useApplicationUpdates>;
  initialSection: SettingsSection;
  openSession: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('shell');
  const [section, setSection] = useState(initialSection);
  const [visited, setVisited] = useState<Set<SettingsSection>>(() => new Set([initialSection]));
  const [projectId, setProjectId] = useState(workspace?.id);
  const [projectBusy, setProjectBusy] = useState(false);
  const projectTools = useRef<WorkspaceToolsHandle>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const id = useId();
  const projects = (snapshot?.workspaces ?? (workspace ? [workspace] : [])).filter(item => !item.archived);
  const projectWorkspace = projects.find(item => item.id === projectId) ?? projects.find(item => item.id === workspace?.id) ?? projects[0];
  if (projectId !== projectWorkspace?.id) setProjectId(projectWorkspace?.id);
  const sections = [
    { id: 'general', label: t('settings.general'), Icon: Palette },
    { id: 'providers', label: t('app.providers'), Icon: Plug },
    { id: 'project', label: t('settings.project'), Icon: FolderCog },
    { id: 'session', label: t('settings.session'), Icon: MessageCircle },
  ] as const;
  const select = (next: SettingsSection) => {
    setVisited(current => current.has(next) ? current : new Set([...current, next]));
    setSection(next);
  };
  const guardProjectEdits = (action: () => void) => {
    if (projectTools.current) projectTools.current.requestClose(action); else action();
  };
  const close = () => guardProjectEdits(onClose);

  return <Modal title={t('preferences.title')} subtitle={t('preferences.subtitle')} size="wide" busy={Boolean(projectWorkspace && projectBusy)} onClose={close}>
    <div className="settings-layout">
      <div className="settings-nav" ref={tabs} role="tablist" aria-label={t('preferences.title')} aria-orientation="vertical"
        onKeyDown={event => {
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const items = Array.from(tabs.current?.querySelectorAll<HTMLButtonElement>('[role=tab]') ?? []);
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
          items[next]?.focus(); select(sections[next].id);
        }}>
        {sections.map(item => <button key={item.id} type="button" role="tab" id={`${id}-${item.id}-tab`}
          aria-selected={section === item.id} aria-controls={`${id}-${item.id}`} tabIndex={section === item.id ? 0 : -1}
          onClick={() => select(item.id)}><item.Icon size={15} /><span>{item.label}</span></button>)}
        {workspace && <span className="settings-workspace" title={workspace.cwd}>{workspace.name}</span>}
      </div>
      <div className="settings-content">
        <section className="settings-panel" id={`${id}-general`} role="tabpanel" aria-labelledby={`${id}-general-tab`} hidden={section !== 'general'}>
          {visited.has('general') && <>
            <header className="settings-section-heading"><h3>{t('settings.general')}</h3><p>{t('settings.generalDescription')}</p></header>
            <LanguageOptions />
            <section className="settings-appearance"><h3 className="preferences-heading">{t('preferences.theme')}</h3><ThemeOptions /><p className="appearance-note">{t('preferences.themeNote')}</p></section>
            <ApplicationUpdateSettings {...updates} />
          </>}
        </section>
        <section className="settings-panel" id={`${id}-providers`} role="tabpanel" aria-labelledby={`${id}-providers-tab`} hidden={section !== 'providers'}>
          {visited.has('providers') && <>
            <header className="settings-section-heading"><h3>{t('app.providers')}</h3><p>{t('provider.refreshAfterSetup')}</p></header>
            {snapshot && <ProvidersContent snapshot={snapshot} perform={perform} pending={pending} />}
          </>}
        </section>
        <section className="settings-panel" id={`${id}-project`} role="tabpanel" aria-labelledby={`${id}-project-tab`} hidden={section !== 'project'}>
          {visited.has('project') && <>
            <header className="settings-section-heading"><h3>{t('settings.project')}</h3><p>{t('settings.projectDescription')}</p></header>
            {projectWorkspace ? <>
              <div className="settings-project-picker">
                <label htmlFor={`${id}-project-scope`}>{t('settings.projectScope')}</label>
                <AppSelect id={`${id}-project-scope`} label={t('settings.projectScope')} aria-describedby={`${id}-project-path`}
                  value={projectWorkspace.id} disabled={projectBusy}
                  options={projects.map(item => ({ value: item.id, label: item.name, description: item.cwd }))}
                  onChange={nextId => { if (nextId !== projectWorkspace.id) guardProjectEdits(() => setProjectId(nextId)); }} />
                <small id={`${id}-project-path`} title={projectWorkspace.cwd}>{projectWorkspace.cwd}</small>
              </div>
              <WorkspaceToolsPanel ref={projectTools} workspace={projectWorkspace} sessions={sessions} perform={perform}
                onBusyChange={setProjectBusy} onRemoved={close} />
            </> : <p className="settings-project-empty">{t('settings.projectEmpty')}</p>}
          </>}
        </section>
        <section className="settings-panel" id={`${id}-session`} role="tabpanel" aria-labelledby={`${id}-session-tab`} hidden={section !== 'session'}>
          {visited.has('session') && <>
            <header className="settings-section-heading"><h3>{t('settings.session')}</h3><p>{session?.title ?? t('settings.sessionEmpty')}</p></header>
            {session && workspace && <SessionSettingsPanel key={session.id} session={session} workspaceId={workspace.id}
              visible={section === 'session'} perform={perform} openSession={openSession} />}
          </>}
        </section>
      </div>
    </div>
  </Modal>;
}
