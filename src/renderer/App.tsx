import { useTranslation } from 'react-i18next';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowUpRight, CheckCircle2, Circle, CircleAlert, CircleDot,
  Folder, GitBranch, Globe, History, Layers2, LoaderCircle, MessageSquare,
  Network, PanelRight, Pin, Plus, Search, Settings2, TerminalSquare, X, LayoutGrid, Moon, Sun, Palette, FolderOpen,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useAppearance, ThemeOptions } from './appearance';
import { LanguageOptions } from './language';
import { SPRING_SNAPPY, motionPopover } from './vendor/open-claude-ui/ClaudeMotionPresets';
import type { PromptInput, ProviderInfo, Session, Snapshot, Workspace, WorkspaceTab } from '../shared/types';
import type { BackendConnectionState } from '../shared/backend';
import { recoverSessionCommands, runSessionCommand } from './session-command';
import { sessionAttentionReason, sessionIsUnread } from './session-attention';
import { PRODUCT_NAME } from '../shared/app-identity';
import ensembleLogo from '../../docs/brand/ensemble-avatar.png';
import { AgentIcon } from './AgentIcon';
import { FileReviewPanel } from './FileReviewPanel';
import { WorkspaceTools } from './WorkspaceTools';
import './features.css';
import { SessionChat } from './SessionChat';
import { TerminalPane } from './TerminalPane';
import { ProvidersDialog, ProvidersView, WorkflowEditor, WorkflowView } from './WorkflowViews';
import { BusyIcon, DirectoryField, EmptyState, ErrorToast, IconButton, Modal, ModelField, ProviderSelect, Status, statusLabel, defaultModelId, pathName, relativeTime, validModelSelection, type Perform } from './ui';

type Page = 'workspace' | 'history' | 'workflows' | 'providers' | 'collaboration';
type Dialog = 'workspace' | 'agent' | 'preview' | 'codex' | 'tools' | 'appearance' | 'providers' | null;
const CollaborationViews = lazy(() => import('./CollaborationViews').then(module => ({ default: module.CollaborationViews })));

function workspaceGroup(workspace: Workspace, sessions: Session[]) {
  const relevant = sessions.filter(session => session.cwd === workspace.cwd);
  if (relevant.some(session => ['approval', 'failure'].includes(sessionAttentionReason(session) ?? ''))) return 'attention';
  if (relevant.some(session => ['running', 'waiting_children', 'queued'].includes(session.status))) return 'working';
  if (relevant.some(session => sessionAttentionReason(session) === 'result')) return 'review';
  if (relevant.some(session => ['completed', 'failed', 'interrupted', 'cancelled'].includes(session.status))) return 'done';
  return 'new';
}

function AttentionBadge({ session }: { session: Session }) {
  const { t } = useTranslation('shell');
  const reason = sessionAttentionReason(session);
  if (!reason) return null;
  const unread = sessionIsUnread(session);
  return <span className={`session-attention attention-${reason}${unread ? ' is-unread' : ''}`}
    title={t(`attention.${reason}`)} aria-label={`${t(`attention.${reason}`)}${unread ? ` · ${t('attention.unread')}` : ''}`}>
    {unread && <i aria-hidden="true" />}{t(`attention.${reason}`)}
  </span>;
}

export function App() {
  const { t } = useTranslation('shell');
  const { theme, setPreference } = useAppearance();
  const reducedMotion = useReducedMotion();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connection, setConnection] = useState<BackendConnectionState>({ status: 'connecting', synced: false });
  const [loadError, setLoadError] = useState('');
  const [page, setPage] = useState<Page>('workspace');
  const [readingSessionId, setReadingSessionId] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [newWorkflow, setNewWorkflow] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [tabMenu, setTabMenu] = useState(false);
  const tabMenuContainer = useRef<HTMLDivElement>(null);
  const activeTabElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (tabMenu) tabMenuContainer.current?.querySelector<HTMLButtonElement>('[role=menuitem]:not(:disabled)')?.focus({ preventScroll: true });
  }, [tabMenu]);
  const [rightPane, setRightPane] = useState(true);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, PromptInput>>({});
  const currentDrafts = useRef<Record<string, PromptInput>>({});
  const draftReady = useRef(new Set<string>());
  draftReady.current = new Set((snapshot?.sessions ?? []).filter(session => session.historyLoaded !== false).map(session => session.id));
  const [draftErrors, setDraftErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const updateDraft = useCallback((id: string, value: PromptInput, expected?: PromptInput) => {
    if (!expected && !draftReady.current.has(id)) return;
    if (expected && currentDrafts.current[id] && currentDrafts.current[id] !== expected) return;
    currentDrafts.current[id] = value;
    setDrafts(current => ({ ...current, [id]: value }));
    setDraftErrors(current => ({ ...current, [id]: '' }));
    void window.workbench.saveSessionDraft(id, value).catch(error => {
      if (currentDrafts.current[id] !== value) return;
      setDraftErrors(current => ({ ...current, [id]: error instanceof Error ? error.message : String(error) }));
    });
  }, []);
  useEffect(() => {
    let active = true;
    let updated = false;
    const unsubscribe = window.workbench.onConnectionChanged(state => {
      updated = true;
      if (active) setConnection(state);
    });
    void window.workbench.getConnection().then(state => { if (active && !updated) setConnection(state); }, error => {
      if (active && !updated) setConnection({ status: 'failed', synced: false, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  const perform = useCallback<Perform>(async (key, action) => {
    setPending(current => new Set(current).add(key));
    try { await action(); }
    catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
      clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(''), 7000);
    } finally { setPending(current => { const next = new Set(current); next.delete(key); return next; }); }
  }, []);

  useEffect(() => {
    let active = true;
    let updated = false;
    const unsubscribe = window.workbench.subscribe(next => {
      updated = true;
      if (active) { setSnapshot(next); setLoadError(''); }
    });
    window.workbench.snapshot().then(next => { if (active && !updated) setSnapshot(next); })
      .catch(error => { if (active && !updated) setLoadError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; unsubscribe(); };
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const workspaces = snapshot?.workspaces ?? [];
  const sessions = snapshot?.sessions ?? [];
  const workflows = snapshot?.workflows ?? [];
  const providers = snapshot?.providers ?? [];
  const workspace = workspaces.find(item => item.id === workspaceId) ?? workspaces[0];
  const workflow = workflows.find(item => item.id === workflowId) ?? workflows[0];
  const activeTab = workspace?.tabs.find(tab => tab.id === workspace.activeTabId) ?? workspace?.tabs[0];
  const secondaryTab = workspace?.tabs.find(tab => tab.id === workspace.secondaryTabId && tab.id !== activeTab?.id);
  const activeSession = activeTab?.kind === 'agent' ? sessions.find(session => session.id === activeTab.sessionId) : undefined;
  useLayoutEffect(() => {
    const element = activeTabElement.current;
    const strip = element?.parentElement;
    if (!element || !strip) return;
    const reveal = () => {
      const tab = element.getBoundingClientRect(), viewport = strip.getBoundingClientRect();
      if (tab.left < viewport.left) strip.scrollLeft += tab.left - viewport.left;
      else if (tab.right > viewport.right) strip.scrollLeft += tab.right - viewport.right;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    observer.observe(element);
    return () => observer.disconnect();
  }, [workspace?.id, activeTab?.id, workspace?.tabs.length, page]);
  const readingSession = page === 'history' ? sessions.find(session => session.id === readingSessionId) : undefined;
  const connected = connection.status === 'connected' && connection.synced;
  useEffect(() => {
    if (connected && snapshot) void recoverSessionCommands();
  }, [connected, snapshot]);
  const watchedIds = JSON.stringify(page === 'workspace' ? [activeTab, secondaryTab].flatMap(tab => tab?.kind === 'agent' ? [tab.sessionId] : [])
    : readingSession ? [readingSession.id] : []);
  useEffect(() => {
    void window.workbench.watchSessions(JSON.parse(watchedIds) as string[]).catch(error => {
      if (connected) setToast(error instanceof Error ? error.message : String(error));
    });
  }, [watchedIds, connected]);
  useEffect(() => () => { void window.workbench.watchSessions([]).catch(() => {}); }, []);
  const visibleWorkspaces = workspaces.filter(item => `${item.name} ${item.cwd}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const refreshKey = sessions.filter(session => session.cwd === workspace?.cwd).map(session => `${session.id}:${session.status}`).join('|');

  const selectWorkspace = useCallback((id: string) => { setReadingSessionId(null); setWorkspaceId(id); setPage('workspace'); setTabMenu(false); }, []);
  const openSession = useCallback((id: string, readOnly = false) => {
    void perform(`open-session-${id}`, async () => {
      const current = await window.workbench.snapshot();
      const session = current.sessions.find(item => item.id === id);
      if (!session) throw new Error(t('app.sessionMissing'));
      const destination = current.workspaces.find(item => item.cwd === session.cwd)?.id;
      if (readOnly || !destination) {
        setReadingSessionId(id); setPage('history'); setDialog(null); return;
      }
      await window.workbench.openSessionTab(destination, id);
      selectWorkspace(destination);
      setDialog(null);
    });
  }, [perform, selectWorkspace, t]);
  useEffect(() => window.workbench.onFocusSession(openSession), [openSession]);
  const renderTab = (tab?: WorkspaceTab) => {
    const tabSession = tab?.kind === 'agent' ? sessions.find(item => item.id === tab.sessionId) : undefined;
    const tabTerminal = tab?.kind === 'terminal' ? snapshot?.terminals.find(item => item.id === tab.terminalId) : undefined;
    if (tabSession && workspace) return <SessionChat key={tabSession.id} session={tabSession} workspaceId={workspace.id} sessions={sessions} openSession={openSession} connected={connected} provider={providers.find(item => item.id === tabSession.providerId)} perform={perform} pending={pending} draft={drafts[tabSession.id] ?? tabSession.draft ?? { text: '' }} draftError={draftErrors[tabSession.id]} onDraftChange={(value, expected) => updateDraft(tabSession.id, value, expected)} />;
    if (tabTerminal && workspace) return <TerminalPane key={tabTerminal.id} info={tabTerminal} cwd={workspace.cwd} perform={perform} />;
    if (tab?.kind === 'preview') return <PreviewPane key={tab.id} tab={tab} />;
    return <EmptyState icon={<Layers2 size={28} />} title={t('app.projectReady')} action={<div className="empty-actions"><button className="button" onClick={() => setDialog('agent')}><Plus size={14} />{t('app.addAgent')}</button><button className="button subtle" disabled={pending.has('create-terminal')} onClick={() => workspace && void perform('create-terminal', () => window.workbench.createTerminal(workspace.id))}><TerminalSquare size={14} />{t('app.openTerminal')}</button></div>}>{t('app.projectReadyNote')}</EmptyState>;
  };

  const workspaceRow = (item: Workspace) => {
    const related = sessions.filter(session => session.cwd === item.cwd).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const current = related.find(session => sessionAttentionReason(session) === 'approval')
      ?? related.find(session => sessionAttentionReason(session) === 'failure')
      ?? related.find(session => ['running', 'waiting_children', 'queued'].includes(session.status))
      ?? related.find(session => sessionAttentionReason(session) === 'result') ?? related[0];
    const unread = related.filter(sessionIsUnread).length;
    return <button key={item.id} className={`workspace-row ${page === 'workspace' && workspace?.id === item.id ? 'selected' : ''}`} onClick={() => selectWorkspace(item.id)}>
      <span className="workspace-glyph">{current ? <AgentIcon providerId={current.providerId} size={15} /> : <Layers2 size={15} />}{current?.status === 'running' && <i />}</span>
      <span className="workspace-row-body"><span className="workspace-row-title">{item.name}</span>{current && <span className="workspace-row-meta"><Status value={current.status} /><AttentionBadge session={current} /></span>}</span>{unread > 0 && <span className="workspace-unread" aria-label={t('attention.unreadSessions', { count: unread })}>{unread}</span>}<time>{relativeTime(item.updatedAt)}</time>
    </button>;
  };

  const groups = [
    { id: 'working', label: t('app.working'), icon: <CircleDot size={15} /> },
    { id: 'review', label: t('app.review'), icon: <CheckCircle2 size={15} /> },
    { id: 'attention', label: t('app.attention'), icon: <CircleAlert size={15} /> },
    { id: 'new', label: t('app.projects'), icon: <Layers2 size={15} /> },
    { id: 'done', label: t('app.done'), icon: <Circle size={15} /> },
  ];

  return <div className="workbench">
    <aside className="workspace-sidebar"><div className="sidebar-titlebar"><img className="brand-symbol" src={ensembleLogo} alt="" /><span>{PRODUCT_NAME}<span className="brand-period">.</span></span></div>
      <nav className="sidebar-navigation" aria-label={t('app.navigation')}><button className="new-workspace-button" onClick={() => setDialog('workspace')}><Plus size={17} /><span>{t('app.newWorkspace')}</span></button><button className={page === 'workspace' ? 'selected' : ''} aria-current={page === 'workspace' ? 'page' : undefined} onClick={() => setPage('workspace')}><LayoutGrid size={17} /><span>{t('app.workspace')}</span><small>{workspaces.length || ''}</small></button><button className={page === 'history' ? 'selected' : ''} aria-current={page === 'history' ? 'page' : undefined} onClick={() => setPage('history')}><History size={17} />{t('app.history')}</button><button className={page === 'collaboration' ? 'selected' : ''} aria-current={page === 'collaboration' ? 'page' : undefined} onClick={() => setPage('collaboration')}><Network size={17} />{t('app.collaboration')}</button><button className={page === 'workflows' ? 'selected' : ''} aria-current={page === 'workflows' ? 'page' : undefined} onClick={() => setPage('workflows')}><GitBranch size={17} />{t('app.workflows')}</button></nav>
      <div className="workspace-sidebar-scroll">{visibleWorkspaces.some(item => item.pinned) && <section className="sidebar-section pinned-section"><div className="sidebar-section-title">{t('app.pinned')}</div>{visibleWorkspaces.filter(item => item.pinned).map(workspaceRow)}</section>}
        <div className="sidebar-section-title workspace-section-heading"><span>{t('app.localProjects')}</span><IconButton label={t('app.searchWorkspaces')} onClick={() => { setSearching(value => !value); setQuery(''); }}><Search size={13} /></IconButton></div>{searching && <div className="workspace-search"><Search size={13} /><input aria-label={t('app.searchWorkspaces')} autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder={t('app.searchPlaceholder')} /></div>}
        {groups.map(group => {
          const items = visibleWorkspaces.filter(item => !item.pinned && workspaceGroup(item, sessions) === group.id);
          return items.length ? <section className={`sidebar-section group-${group.id}`} key={group.id}><div className="workspace-group-label">{group.icon}<span>{group.label}</span></div>{items.map(workspaceRow)}</section> : null;
        })}
        {!workspaces.length && <div className="sidebar-placeholder">{t('app.chooseLocalProject')}<br />{t('app.addRuntimeNote')}</div>}{workspaces.length > 0 && !visibleWorkspaces.length && <div className="sidebar-placeholder">{t('app.noWorkspaceMatch')}</div>}
      </div>
      <div className={`sidebar-connection connection-${connected ? 'connected' : connection.status}`}><i /><span>{connected ? t('app.connected') : t(`connection.${connection.status}`)}</span><small>{t('app.thisMachine')}</small></div><footer className="sidebar-footer"><button onClick={() => setDialog('workspace')}><Plus size={15} />{t('app.addProject')}</button><IconButton label={t('preferences.open')} onClick={() => setDialog('appearance')}><Palette size={16} /></IconButton><IconButton label={t('app.providers')} onClick={() => setPage('providers')}><Settings2 size={16} /></IconButton></footer>
    </aside>

    <main className={`main-workspace ${page === 'workspace' && workspace && rightPane ? 'with-file-panel' : ''}`}><header className="workspace-header"><div className="workspace-heading">{page === 'workspace' && workspace ? <><FolderOpen size={16} /><h1 title={workspace.name}>{workspace.name}</h1><span title={workspace.cwd}>{pathName(workspace.cwd)}</span><IconButton label={workspace.pinned ? t('app.unpin') : t('app.pin')} aria-pressed={workspace.pinned} onClick={() => void perform('pin-workspace', () => window.workbench.updateWorkspace(workspace.id, { pinned: !workspace.pinned }))}><Pin size={13} fill={workspace.pinned ? 'currentColor' : 'none'} /></IconButton></> : <h1>{{ workspace: PRODUCT_NAME, history: t('app.history'), workflows: t('app.workflows'), providers: t('app.providers'), collaboration: t('app.agentCollaboration') }[page]}</h1>}</div>
      <div className="workspace-header-actions">{page === 'workspace' && workspace && <><button className="header-button" aria-label={t('app.collaboration')} title={t('app.collaboration')} onClick={() => setPage('collaboration')}><Network size={14} /><span>{t('app.collaboration')}</span></button><IconButton label={t('app.projectTools')} onClick={() => setDialog('tools')}><Settings2 size={15} /></IconButton><button className="header-button" disabled={workspace.tabs.length < 2} onClick={() => void perform('split', () => window.workbench.splitWorkspace(workspace.id, secondaryTab ? {} : { tabId: workspace.tabs.find(tab => tab.id !== activeTab?.id)?.id, direction: 'horizontal' }))}>{secondaryTab ? t('app.mergePanes') : t('app.splitPanes')}</button>{secondaryTab && <button className="header-button" onClick={() => void perform('split-direction', () => window.workbench.splitWorkspace(workspace.id, { tabId: secondaryTab.id, direction: workspace.splitDirection === 'vertical' ? 'horizontal' : 'vertical' }))}>{t('app.changeDirection')}</button>}</>}<span className="local-indicator"><i />{t('app.local')}</span><IconButton label={theme === 'light' ? t('app.switchDark') : t('app.switchLight')} onClick={() => setPreference(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}</IconButton>{page === 'workspace' && <button className="header-button" onClick={() => setDialog('codex')} aria-label={t('app.openCodex')} title={t('app.openCodexHint')}><ArrowUpRight size={13} /><span>Codex App</span></button>}{page === 'workspace' && workspace && <IconButton label={rightPane ? t('app.hideFiles') : t('app.showFiles')} aria-pressed={rightPane} onClick={() => setRightPane(value => !value)}><PanelRight size={16} /></IconButton>}</div>
    </header>
      {snapshot && !connected && <div className="connection-banner" role="status"><CircleAlert size={14} /><span>{t('connection.stale')}{connection.lastReceivedAt && ` · ${t('connection.lastUpdate', { time: relativeTime(connection.lastReceivedAt) })}`}</span>{connection.error && <small>{connection.error}</small>}</div>}
      {!snapshot ? <div className="loading-view">{loadError ? <><CircleAlert size={23} /><p>{loadError}</p><button className="button" onClick={() => void perform('reload', async () => { setSnapshot(await window.workbench.snapshot()); setLoadError(''); })}>{t('common.reload')}</button></> : <><LoaderCircle className="spin" size={23} /><p>{t('app.loading')}</p></>}</div> : <>
        {page === 'workspace' && (workspace ? <div className="workspace-columns"><div className="workspace-center"><div className="tabbar"><div className="workspace-tabs">{workspace.tabs.map(tab => {
          const tabSession = tab.kind === 'agent' ? sessions.find(item => item.id === tab.sessionId) : undefined;
          const tabTerminal = tab.kind === 'terminal' ? snapshot.terminals.find(item => item.id === tab.terminalId) : undefined;
          const label = tab.kind === 'agent' ? tabSession?.title || providers.find(provider => provider.id === tabSession?.providerId)?.name || tabSession?.providerId || 'Agent' : tab.kind === 'terminal' ? tabTerminal?.title ?? 'Terminal' : tab.url;
          return <div key={tab.id} ref={activeTab?.id === tab.id ? activeTabElement : undefined} className={`workspace-tab ${activeTab?.id === tab.id ? 'active' : ''}`}>{activeTab?.id === tab.id && <motion.span className="workspace-tab-active" layoutId={`workspace-tab-${workspace.id}`} transition={reducedMotion ? { duration: 0 } : SPRING_SNAPPY} />}<button className="tab-select" aria-current={activeTab?.id === tab.id ? 'page' : undefined} title={tab.kind === 'agent' ? tabSession?.title : label} onClick={() => void perform('activate-tab', () => window.workbench.activateTab(workspace.id, tab.id))}>{tab.kind === 'agent' ? <AgentIcon providerId={tabSession?.providerId ?? ''} size={14} /> : tab.kind === 'terminal' ? <TerminalSquare size={14} /> : <Globe size={14} />}<span>{label}</span>{tabSession && <AttentionBadge session={tabSession} />}{tabSession && ['running', 'waiting_approval', 'waiting_children', 'failed'].includes(tabSession.status) && <i className={`tab-state tab-state-${tabSession.status}`} aria-label={statusLabel(tabSession.status)} title={statusLabel(tabSession.status)} />}</button><button className="tab-close" aria-label={t('app.closeNamedTab', { label })} title={tab.kind === 'terminal' ? t('app.closeTerminalTab') : t('app.closeTab')} onClick={() => void perform(`close-tab-${tab.id}`, () => window.workbench.closeTab(workspace.id, tab.id))}><X size={11} /></button></div>;
        })}</div><div className="tab-add" ref={tabMenuContainer} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setTabMenu(false); }} onKeyDown={event => {
            if (!tabMenu) return;
            if (event.key === 'Escape') { event.preventDefault(); setTabMenu(false); tabMenuContainer.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus({ preventScroll: true }); return; }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const items = Array.from(tabMenuContainer.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)') ?? []);
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
            items[next]?.focus({ preventScroll: true });
          }}><IconButton label={t('app.addTab')} aria-haspopup="menu" aria-expanded={tabMenu} onClick={() => setTabMenu(value => !value)}><Plus size={17} /></IconButton><AnimatePresence>{tabMenu && <><button key="dismiss" className="menu-dismiss" tabIndex={-1} aria-label={t('app.dismissAddMenu')} onClick={() => setTabMenu(false)} /><motion.div key="menu" className="tab-menu" role="menu" aria-label={t('app.addTabMenu')} initial={reducedMotion ? false : "initial"} animate="animate" exit={reducedMotion ? undefined : "exit"} variants={motionPopover}><button role="menuitem" onClick={() => { setDialog('agent'); setTabMenu(false); }}><MessageSquare size={15} />{t('app.newAgentSession')}</button><button role="menuitem" disabled={pending.has('create-terminal')} onClick={() => { setTabMenu(false); void perform('create-terminal', () => window.workbench.createTerminal(workspace.id)); }}><TerminalSquare size={15} />{t('app.openLocalTerminal')}</button><button role="menuitem" onClick={() => { setDialog('preview'); setTabMenu(false); }}><Globe size={15} />{t('app.addPreview')}</button></motion.div></>}</AnimatePresence></div></div>
          <WorkspacePanes workspace={workspace} secondary={!!secondaryTab} perform={perform} primary={renderTab(activeTab)} other={renderTab(secondaryTab)} />
        </div><motion.div className="file-panel-transition" initial={false} animate={{ width: rightPane ? 'var(--file-width)' : 0, opacity: rightPane ? 1 : 0 }} transition={reducedMotion ? { duration: 0 } : SPRING_SNAPPY} inert={!rightPane} aria-hidden={!rightPane}><FileReviewPanel key={workspace.id} workspace={workspace} refreshKey={refreshKey} perform={perform} sessions={sessions} onFeedback={activeSession ? text => { const draft = currentDrafts.current[activeSession.id] ?? activeSession.draft ?? { text: '' }; updateDraft(activeSession.id, { ...draft, text: [draft.text, text].filter(Boolean).join('\n\n') }); } : undefined} /></motion.div></div> : <EmptyState icon={<Layers2 size={30} />} title={t('app.startLocal')} action={<button className="button primary" onClick={() => setDialog('workspace')}><Plus size={15} />{t('app.newWorkspace')}</button>}>{t('app.startLocalNote')}</EmptyState>)}
        {page === 'history' && (readingSession ? <section className="history-session-view">
          <header className="history-session-toolbar"><span>{t('history.readOnly')}</span><button className="header-button" onClick={() => setReadingSessionId(null)}><X size={13} />{t('history.closeSession')}</button></header>
          <SessionChat key={readingSession.id} session={readingSession} readOnly connected={connected} sessions={sessions}
            provider={providers.find(provider => provider.id === readingSession.providerId)} perform={perform} pending={pending}
            draft={{ text: '' }} onDraftChange={() => {}} openSession={id => openSession(id, true)} />
        </section> : <HistoryView sessions={sessions} providers={providers} openSession={openSession} perform={perform} />)}
        {page === 'collaboration' && <Suspense fallback={<div className="loading-view"><LoaderCircle className="spin" size={23} /><p>{t('app.loadingCollaboration')}</p></div>}><CollaborationViews snapshot={snapshot} perform={perform} pending={pending} openSession={openSession} initialCwd={workspace?.cwd} openProviderSettings={() => setDialog('providers')} /></Suspense>}
        {page === 'workflows' && <div className="split-page"><aside className="item-sidebar"><div className="sidebar-heading"><h2>{t('app.workflows')}</h2><IconButton label={t('workflow.new')} onClick={() => setNewWorkflow(true)}><Plus size={17} /></IconButton></div><p className="sidebar-subtitle">{t('workflow.dependenciesNote')}</p><div className="item-list">{workflows.map(item => <button key={item.id} className={`list-item ${item.id === workflow?.id && !newWorkflow ? 'selected' : ''}`} onClick={() => { setWorkflowId(item.id); setNewWorkflow(false); }}><strong>{item.name}</strong><div><span>{t('workflow.stepCount', { count: item.steps.length })}</span><Status value={item.status} /></div></button>)}</div><button className="sidebar-action" onClick={() => setNewWorkflow(true)}><Plus size={14} />{t('workflow.new')}</button></aside>{newWorkflow ? <WorkflowEditor providers={providers} perform={perform} pending={pending} onClose={() => setNewWorkflow(false)} onCreated={id => { setWorkflowId(id); setNewWorkflow(false); }} /> : workflow ? <WorkflowView workflow={workflow} providers={providers} sessions={sessions} perform={perform} pending={pending} openSession={openSession} openWorkflow={id => { setWorkflowId(id); setNewWorkflow(false); }} /> : <EmptyState icon={<GitBranch size={28} />} title={t('workflow.empty')} action={<button className="button" onClick={() => setNewWorkflow(true)}><Plus size={14} />{t('workflow.new')}</button>}>{t('workflow.emptyNote')}</EmptyState>}</div>}
        {page === 'providers' && <ProvidersView snapshot={snapshot} perform={perform} pending={pending} />}
      </>}
    </main>
    {dialog === 'appearance' && <Modal title={t('preferences.title')} subtitle={t('preferences.subtitle')} onClose={() => setDialog(null)}><LanguageOptions /><h3 className="preferences-heading">{t('preferences.theme')}</h3><ThemeOptions /><p className="appearance-note">{t('preferences.themeNote')}</p></Modal>}
    {dialog === 'providers' && snapshot && <ProvidersDialog snapshot={snapshot} perform={perform} pending={pending} onClose={() => setDialog(null)} />}
    {dialog === 'tools' && workspace && <WorkspaceTools key={workspace.id} workspace={workspace} sessions={sessions} perform={perform} onClose={() => setDialog(null)} />}
    {dialog === 'workspace' && <NewWorkspaceDialog perform={perform} pending={pending} onClose={() => setDialog(null)} onCreated={id => { setDialog(null); selectWorkspace(id); }} />}
    {dialog === 'agent' && workspace && <NewAgentDialog workspace={workspace} providers={providers} pending={pending} perform={perform} onClose={() => setDialog(null)} />}
    {dialog === 'preview' && workspace && <PreviewDialog workspace={workspace} pending={pending} perform={perform} onClose={() => setDialog(null)} />}
    {dialog === 'codex' && <CodexDialog initialCwd={workspace?.cwd ?? ''} pending={pending} perform={perform} onClose={() => setDialog(null)} />}
    {toast && <ErrorToast message={toast} onDismiss={() => setToast('')} />}
  </div>;
}

function NewWorkspaceDialog({ pending, perform, onClose, onCreated }: { pending: Set<string>; perform: Perform; onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation('shell');
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [mode, setMode] = useState<'directory' | 'worktree'>('directory');
  const [branch, setBranch] = useState('');
  const busy = pending.has('create-workspace');
  const submit = (event: FormEvent) => {
    event.preventDefault(); if (!cwd.trim() || busy) return;
    const input = { name: name.trim() || pathName(cwd.trim()), cwd: cwd.trim(), mode, ...(mode === 'worktree' && branch.trim() ? { branch: branch.trim() } : {}) };
    void perform('create-workspace', () => runSessionCommand('create-workspace', input, async commandId => {
      const id = await window.workbench.createWorkspace({ ...input, commandId });
      if (live.current) onCreated(id);
      return id;
    }));
  };
  return <Modal title={t('app.newWorkspace')} subtitle={t('app.newWorkspaceNote')} busy={busy} onClose={onClose}><form onSubmit={submit}>
    <label>{t('common.projectDirectory')}<DirectoryField value={cwd} onChange={setCwd} perform={perform} /></label>
    <label>{t('app.workspaceMode')}<select value={mode} disabled={busy} onChange={event => setMode(event.target.value as typeof mode)}>
      <option value="directory">{t('app.currentDirectory')}</option><option value="worktree">{t('app.independentWorktree')}</option>
    </select></label>
    {mode === 'worktree' && <><p className="form-note">{t('app.worktreeNote')}</p><label>{t('app.worktreeBranch')}<span className="optional">{t('common.optional')}</span><input value={branch} onChange={event => setBranch(event.target.value)} disabled={busy} placeholder={t('app.worktreeBranchDefault')} /></label></>}
    <label>{t('app.workspaceName')}<span className="optional">{t('common.optional')}</span><input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder={cwd ? pathName(cwd) : t('app.directoryNameDefault')} maxLength={200} /></label>
    <div className="modal-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>{t('common.cancel')}</button><button className="button primary" disabled={!cwd.trim() || busy}><BusyIcon busy={busy}><Plus size={14} /></BusyIcon>{t('app.createWorkspace')}</button></div></form></Modal>;
}

function NewAgentDialog({ workspace, providers, pending, perform, onClose }: { workspace: Workspace; providers: ProviderInfo[]; pending: Set<string>; perform: Perform; onClose: () => void }) {
  const { t } = useTranslation('shell');
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [selection, setSelection] = useState(() => {
    const provider = providers.find(item => item.available);
    return { providerId: provider?.id ?? '', modelId: defaultModelId(provider) };
  });
  const { providerId, modelId } = selection;
  const provider = providers.find(item => item.id === providerId);
  const [title, setTitle] = useState('');
  const busy = pending.has('create-agent');
  const valid = validModelSelection(provider, modelId);
  const submit = (event: FormEvent) => {
    event.preventDefault(); if (!valid || busy) return;
    const input = { cwd: workspace.cwd, providerId, ...(modelId ? { modelId } : {}), title: title.trim() || t('app.defaultSessionName', { provider: provider?.name ?? providerId }) };
    void perform('create-agent', () => runSessionCommand(`create-session:${workspace.id}`, input, async commandId => {
      const id = await window.workbench.createSession({ ...input, commandId });
      if (live.current) onClose();
      return id;
    }));
  };
  return <Modal title={t('app.newAgentSession')} subtitle={workspace.name} busy={busy} onClose={onClose}><form onSubmit={submit}><label>{t('common.agent')}<ProviderSelect providers={providers} value={providerId} onChange={id => setSelection({ providerId: id, modelId: defaultModelId(providers.find(item => item.id === id)) })} /></label><ModelField provider={provider} value={modelId} disabled={busy} onChange={value => setSelection(current => ({ ...current, modelId: value }))} /><label>{t('app.sessionName')}<span className="optional">{t('common.optional')}</span><input autoFocus value={title} maxLength={200} onChange={event => setTitle(event.target.value)} placeholder={t('app.sessionExample')} /></label><div className="form-note"><Folder size={14} /><span>{workspace.cwd}</span></div><div className="modal-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>{t('common.cancel')}</button><button className="button primary" disabled={!valid || busy}><BusyIcon busy={busy}><Plus size={14} /></BusyIcon>{t('app.createSession')}</button></div></form></Modal>;
}

function localPreviewUrl(value: string) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password; }
  catch { return false; }
}

function PreviewDialog({ workspace, pending, perform, onClose }: { workspace: Workspace; pending: Set<string>; perform: Perform; onClose: () => void }) {
  const { t } = useTranslation('shell');
  const [url, setUrl] = useState('');
  const busy = pending.has('create-preview');
  return <Modal title={t('app.addPreview')} subtitle={t('app.previewNote')} busy={busy} onClose={onClose}><form onSubmit={event => { event.preventDefault(); if (!localPreviewUrl(url.trim()) || busy) return; void perform('create-preview', async () => { await window.workbench.createPreview(workspace.id, url.trim()); onClose(); }); }}><label>{t('app.localUrl')}<input autoFocus type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="http://localhost:3000" required /></label>{url && !localPreviewUrl(url.trim()) && <p className="field-error">{t('app.localUrlOnly')}</p>}<div className="modal-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>{t('common.cancel')}</button><button className="button primary" disabled={busy || !localPreviewUrl(url.trim())}><BusyIcon busy={busy}><Globe size={14} /></BusyIcon>{t('app.openPreview')}</button></div></form></Modal>;
}

function PreviewPane({ tab }: { tab: Extract<WorkspaceTab, { kind: 'preview' }> }) {
  const { t } = useTranslation('shell');
  const [revision, setRevision] = useState(0);
  if (!localPreviewUrl(tab.url)) return <div className="pane-note error-text">{t('app.previewBlocked')}</div>;
  return <section className="preview-pane"><div className="preview-toolbar"><Globe size={13} /><span>{tab.url}</span><button className="text-button" onClick={() => setRevision(value => value + 1)}>{t('common.reload')}</button></div><iframe title={t('app.namedPreview', { url: tab.url })} key={revision} src={tab.url} sandbox="allow-scripts allow-same-origin allow-forms" referrerPolicy="no-referrer" /></section>;
}

function CodexDialog({ initialCwd, pending, perform, onClose }: { initialCwd: string; pending: Set<string>; perform: Perform; onClose: () => void }) {
  const { t } = useTranslation('shell');
  const [cwd, setCwd] = useState(initialCwd);
  const [prompt, setPrompt] = useState('');
  const busy = pending.has('launch-codex');
  return <Modal title={t('app.codexNew')} subtitle={t('app.codexNewNote')} busy={busy} onClose={onClose}><form onSubmit={event => { event.preventDefault(); if (!cwd.trim() || busy) return; void perform('launch-codex', async () => { await window.workbench.launchCodex({ cwd: cwd.trim(), prompt }); onClose(); }); }}><label>{t('common.projectDirectory')}<DirectoryField value={cwd} onChange={setCwd} perform={perform} /></label><label>{t('app.prefilledTask')}<span className="optional">{t('common.optional')}</span><textarea value={prompt} onChange={event => setPrompt(event.target.value)} rows={4} placeholder={t('app.codexPrompt')} /></label><div className="form-note"><ArrowUpRight size={14} /><span>{t('app.codexHandoffNote')}</span></div><div className="modal-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>{t('common.cancel')}</button><button className="button primary" disabled={!cwd.trim() || busy}><BusyIcon busy={busy}><ArrowUpRight size={14} /></BusyIcon>{t('app.openCodex')}</button></div></form></Modal>;
}

function WorkspacePanes({ workspace, primary, other, secondary, perform }: { workspace: Workspace; primary: ReactNode; other: ReactNode; secondary: boolean; perform: Perform }) {
  const { t } = useTranslation('shell');
  const [ratio, setRatio] = useState(workspace.splitRatio ?? 0.5);
  const ratioRef = useRef(ratio);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => { ratioRef.current = workspace.splitRatio ?? 0.5; setRatio(ratioRef.current); }, [workspace.id, workspace.splitRatio]);
  const vertical = workspace.splitDirection === 'vertical';
  return <div className={`workspace-dual ${vertical ? 'vertical' : ''}`} ref={container}><div className="tab-content" style={secondary ? { flex: `0 0 ${ratio * 100}%` } : undefined}>{primary}</div>{secondary && <><div className="split-handle" role="separator" aria-label={t('app.resizeSplit')} aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(ratio * 100)} aria-orientation={vertical ? 'horizontal' : 'vertical'} tabIndex={0} onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)} onPointerMove={event => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId) || !container.current) return;
    const rect = container.current.getBoundingClientRect();
    const next = Math.min(0.8, Math.max(0.2, vertical ? (event.clientY - rect.top) / rect.height : (event.clientX - rect.left) / rect.width));
    ratioRef.current = next; setRatio(next);
  }} onPointerUp={event => { event.currentTarget.releasePointerCapture(event.pointerId); void perform('split-ratio', () => window.workbench.splitWorkspace(workspace.id, { tabId: workspace.secondaryTabId, direction: workspace.splitDirection, ratio: ratioRef.current })); }} onKeyDown={event => { if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) { event.preventDefault(); const next = Math.max(0.2, Math.min(0.8, ratio + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -0.05 : 0.05))); void perform('split-ratio', () => window.workbench.splitWorkspace(workspace.id, { tabId: workspace.secondaryTabId, direction: workspace.splitDirection, ratio: next })); } }} /><div className="tab-content">{other}</div></>}</div>;
}

function HistoryView({ sessions, providers, openSession, perform }: { sessions: Session[]; providers: ProviderInfo[]; openSession: (id: string) => void; perform: Perform }) {
  const { t } = useTranslation('shell');
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [result, setResult] = useState<{ query: string; archived: boolean; ids: Set<string> }>();
  const [error, setError] = useState('');
  const searchQuery = query.trim();
  useEffect(() => {
    if (!searchQuery) { setError(''); return; }
    let active = true;
    setError('');
    const timer = setTimeout(() => {
      void window.workbench.searchSessions(searchQuery, archived).then(value => {
        if (active) setResult({ query: searchQuery, archived, ids: new Set(value.sessionIds) });
      }, error => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [searchQuery, archived]);
  const ready = !searchQuery || (result?.query === searchQuery && result.archived === archived);
  const matching = sessions.filter(session => (archived || !session.archived) && (!searchQuery || (ready && result?.ids.has(session.id)))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return <section className="history-page"><div className="history-intro"><div><h2>{t('history.title')}</h2><p>{t('history.note')}</p></div><div className="history-search"><Search size={14} /><input aria-label={t('history.search')} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('history.placeholder')} /></div></div><label className="history-archive"><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)} />{t('history.archivedFilter')}</label>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="history-list">{!ready && !error ? <p className="pane-note" role="status">{t('history.searching')}</p> : matching.length ? matching.map(session => <div className="history-row" key={session.id}><button className="history-open" onClick={() => openSession(session.id)}><span className="history-icon"><AgentIcon providerId={session.providerId} size={19} /></span><span className="history-row-title"><strong>{session.title}{session.archived ? t('history.archivedSuffix') : ''}</strong><small title={session.cwd}>{providers.find(provider => provider.id === session.providerId)?.name ?? session.providerId}<span>·</span>{session.cwd}</small></span></button><AttentionBadge session={session} /><Status value={session.status} /><time>{relativeTime(session.updatedAt)}</time><button className="text-button" disabled={['running', 'waiting_approval', 'waiting_children', 'queued'].includes(session.status)} onClick={() => void perform('archive-session', () => window.workbench.updateSession(session.id, { archived: !session.archived }))}>{session.archived ? t('history.restore') : t('history.archive')}</button></div>) : !error && <EmptyState icon={<History size={25} />} title={query ? t('history.noMatches') : t('history.empty')}>{t('history.emptyNote')}</EmptyState>}</div></section>;
}
