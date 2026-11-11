import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderCog, Keyboard, MessageCircle, Palette, Plug, Search } from 'lucide-react';
import type { Session, Snapshot, Workspace } from '../shared/types';
import { AppearanceSettings } from './AppearanceSettings';
import { LanguageOptions } from './language';
import { ApplicationUpdateSettings, type useApplicationUpdates } from './ApplicationUpdates';
import { AppSelect } from './AppSelect';
import { ProvidersContent } from './WorkflowViews';
import { WorkspaceToolsPanel, type WorkspaceToolsHandle } from './WorkspaceTools';
import { SessionSettingsPanel } from './SessionChat';
import { Modal, type Perform } from './ui';
import { NotificationSettings } from './NotificationSettings';
import { WindowCaptureSettings } from './WindowCapture';
import { ShortcutSettings } from './ShortcutSettings';
import { composingShortcut, useShortcuts } from './app-shortcuts';
import { searchableSettings, type SettingsSection, type SettingsTarget } from './settings-targets';
import './SettingsDialog.css';

export type { SettingsSection } from './settings-targets';

export function SettingsDialog({ snapshot, workspace, sessions, session, perform, pending, updates, initialSection, initialTarget, openSession, openSessionLink, onClose }: {
  snapshot: Snapshot | null;
  workspace?: Workspace;
  sessions: Session[];
  session?: Session;
  perform: Perform;
  pending: Set<string>;
  updates: ReturnType<typeof useApplicationUpdates>;
  initialSection: SettingsSection;
  initialTarget?: SettingsTarget;
  openSession: (id: string) => void;
  openSessionLink?: (sourceId: string, targetId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('shell');
  const shortcuts = useShortcuts();
  const [section, setSection] = useState(initialSection);
  const [visited, setVisited] = useState<Set<SettingsSection>>(() => new Set([initialSection]));
  const [projectId, setProjectId] = useState(workspace?.id);
  const [projectBusy, setProjectBusy] = useState(false);
  const projectTools = useRef<WorkspaceToolsHandle>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  const [target, setTarget] = useState<SettingsTarget | undefined>(initialTarget);
  const id = useId();
  const projects = (snapshot?.workspaces ?? (workspace ? [workspace] : [])).filter(item => !item.archived);
  const projectWorkspace = projects.find(item => item.id === projectId) ?? projects.find(item => item.id === workspace?.id) ?? projects[0];
  if (projectId !== projectWorkspace?.id) setProjectId(projectWorkspace?.id);
  const sections = [
    { id: 'general', label: t('settings.general'), Icon: Palette },
    { id: 'shortcuts', label: t('shortcuts.title'), Icon: Keyboard },
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
  const words = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const results = words.length ? searchableSettings(t, projectWorkspace?.name, session?.title, shortcuts.binding).filter(item => {
    const text = [item.title, item.detail, item.keywords].join(' ').toLocaleLowerCase();
    return words.every(word => text.includes(word));
  }) : [];
  const resultIndex = Math.min(searchIndex, results.length - 1);
  const openTarget = (next: SettingsTarget) => {
    select(next.section);
    setTarget({ ...next });
  };

  useLayoutEffect(() => {
    if (!target || target.section !== section || !content.current) return;
    const id = target.id;
    const row = content.current.querySelector<HTMLElement>(`[data-setting-anchor="${id}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest' });
    row.classList.add('setting-search-highlight');
    const clear = () => row.classList.remove('setting-search-highlight');
    const timer = window.setTimeout(clear, 1400);
    return () => { window.clearTimeout(timer); clear(); };
  }, [target, section, projectWorkspace?.id]);

  useEffect(() => {
    const find = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'f' || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey
        || composingShortcut(event) || (event.target instanceof Element && event.target.closest('[data-shortcut-recording]'))) return;
      if (document.activeElement?.closest('dialog[open]') !== search.current?.closest('dialog[open]')) return;
      event.preventDefault();
      event.stopPropagation();
      search.current?.focus();
      search.current?.select();
    };
    window.addEventListener('keydown', find, true);
    return () => window.removeEventListener('keydown', find, true);
  }, []);


  return <Modal title={t('preferences.title')} subtitle={t('preferences.subtitle')} size="wide" busy={Boolean(projectWorkspace && projectBusy)} onClose={close}>
    <div className="settings-layout">
      <aside className="settings-sidebar">
      <label className="settings-search"><Search size={13} aria-hidden="true" />
        <input ref={search} role="combobox" aria-label={t('settings.search.label')} placeholder={t('settings.search.label')}
          aria-controls={`${id}-settings-results`} aria-expanded={words.length > 0}
          aria-activedescendant={resultIndex >= 0 ? `${id}-setting-${resultIndex}` : undefined}
          value={query} onChange={event => { setQuery(event.target.value); setSearchIndex(0); }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.keyCode === 229 || !results.length) return;
            if (event.key === 'Enter') { event.preventDefault(); openTarget(results[resultIndex]); }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setSearchIndex((resultIndex + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
            }
          }} />
      </label>
      <div hidden={!words.length} className="settings-search-results" role="listbox" id={`${id}-settings-results`}>
        {results.map((item, index) => <div role="option" id={`${id}-setting-${index}`} aria-selected={index === resultIndex}
          key={item.id} onMouseDown={event => event.preventDefault()} onClick={() => { setSearchIndex(index); openTarget(item); }}>
          <strong>{item.title}</strong><small>{item.detail}</small>
        </div>)}
        {words.length > 0 && !results.length && <small role="status">{t('commandPalette.empty')}</small>}
      </div>
      <div hidden={words.length > 0} className="settings-nav" ref={tabs} role="tablist" aria-label={t('preferences.title')} aria-orientation="vertical"
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
      </aside>
      <div className="settings-content" ref={content}>
        <section className="settings-panel" id={`${id}-general`} role="tabpanel" aria-labelledby={`${id}-general-tab`} hidden={section !== 'general'}>
          {visited.has('general') && <>
            <header className="settings-section-heading"><h3>{t('settings.general')}</h3><p>{t('settings.generalDescription')}</p></header>
            <div data-setting-anchor="language"><LanguageOptions /></div>
            <AppearanceSettings />
            <NotificationSettings perform={perform} />
            <WindowCaptureSettings perform={perform} />
            <div data-setting-anchor="updates"><ApplicationUpdateSettings {...updates} /></div>
          </>}
        </section>
        <section className="settings-panel" id={`${id}-shortcuts`} role="tabpanel" aria-labelledby={`${id}-shortcuts-tab`} hidden={section !== 'shortcuts'}>
          {visited.has('shortcuts') && <ShortcutSettings />}
        </section>
        <section className="settings-panel" id={`${id}-providers`} role="tabpanel" aria-labelledby={`${id}-providers-tab`} hidden={section !== 'providers'}>
          {visited.has('providers') && <>
            <header className="settings-section-heading"><h3>{t('app.providers')}</h3><p>{t('provider.refreshAfterSetup')}</p></header>
            {snapshot && <div data-setting-anchor="providers"><ProvidersContent snapshot={snapshot} perform={perform} pending={pending} /></div>}
          </>}
        </section>
        <section className="settings-panel" id={`${id}-project`} role="tabpanel" aria-labelledby={`${id}-project-tab`} hidden={section !== 'project'}>
          {visited.has('project') && <>
            <header className="settings-section-heading"><h3>{t('settings.project')}</h3><p>{t('settings.projectDescription')}</p></header>
            {projectWorkspace ? <>
              <div className="settings-project-picker" data-setting-anchor="project-path">
                <label htmlFor={`${id}-project-scope`}>{t('settings.projectScope')}</label>
                <AppSelect id={`${id}-project-scope`} label={t('settings.projectScope')} aria-describedby={`${id}-project-path`}
                  value={projectWorkspace.id} disabled={projectBusy}
                  options={projects.map(item => ({ value: item.id, label: item.name, description: item.cwd }))}
                  onChange={nextId => { if (nextId !== projectWorkspace.id) guardProjectEdits(() => setProjectId(nextId)); }} />
                <small id={`${id}-project-path`} title={projectWorkspace.cwd}>{projectWorkspace.cwd}</small>
              </div>
              <WorkspaceToolsPanel ref={projectTools} workspace={projectWorkspace} sessions={sessions} perform={perform}
                onBusyChange={setProjectBusy} onRemoved={close} target={target?.section === 'project' ? target : undefined} />
            </> : <p className="settings-project-empty">{t('settings.projectEmpty')}</p>}
          </>}
        </section>
        <section className="settings-panel" id={`${id}-session`} role="tabpanel" aria-labelledby={`${id}-session-tab`} hidden={section !== 'session'}>
          {visited.has('session') && <>
            <header className="settings-section-heading"><h3>{t('settings.session')}</h3><p>{session?.title ?? t('settings.sessionEmpty')}</p></header>
            {session && workspace && <div data-setting-anchor="session-skills"><SessionSettingsPanel key={session.id} session={session} workspaceId={workspace.id}
              visible={section === 'session'} sessions={sessions} providers={snapshot?.providers} perform={perform} openSession={openSession}
              openSessionLink={openSessionLink && ((sourceId, targetId) => guardProjectEdits(() => openSessionLink(sourceId, targetId)))} /></div>}
          </>}
        </section>
      </div>
    </div>
  </Modal>;
}
