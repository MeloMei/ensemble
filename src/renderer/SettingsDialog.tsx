import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderCog, MessageCircle, Palette, Plug } from 'lucide-react';
import type { Session, Snapshot, Workspace } from '../shared/types';
import { ThemeOptions } from './appearance';
import { LanguageOptions } from './language';
import { ApplicationUpdateSettings, type useApplicationUpdates } from './ApplicationUpdates';
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
  const [projectBusy, setProjectBusy] = useState(false);
  const project = useRef<WorkspaceToolsHandle>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const id = useId();
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
  const close = () => { if (project.current) project.current.requestClose(onClose); else onClose(); };

  return <Modal title={t('preferences.title')} subtitle={t('preferences.subtitle')} size="wide" busy={projectBusy} onClose={close}>
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
            <header className="settings-section-heading"><h3>{t('settings.project')}</h3><p>{workspace?.name ?? t('settings.projectEmpty')}</p></header>
            {workspace && <WorkspaceToolsPanel ref={project} workspace={workspace} sessions={sessions} perform={perform}
              onBusyChange={setProjectBusy} onRemoved={onClose} />}
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
