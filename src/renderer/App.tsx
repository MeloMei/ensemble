import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Aperture, ArrowUpRight, CheckCircle2, Circle, CircleAlert, CircleDot,
  Folder, GitBranch, Globe, History, Layers2, LoaderCircle, MessageSquare,
  Network, PanelsTopLeft, PanelRight, Pin, Plus, Search, Settings2, Sparkles, TerminalSquare, X, LayoutGrid, Moon, Sun, Palette, FolderOpen,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useAppearance, ThemeOptions } from './appearance';
import { SPRING_SNAPPY, motionPopover } from './vendor/open-claude-ui/ClaudeMotionPresets';
import type { ProviderInfo, Session, Snapshot, Workspace, WorkspaceTab } from '../shared/types';
import { searchableMessageText } from '../shared/message-text';
import { PRODUCT_NAME } from '../shared/app-identity';
import { FileReviewPanel } from './FileReviewPanel';
import { WorkspaceTools } from './WorkspaceTools';
import './features.css';
import { SessionChat } from './SessionChat';
import { TerminalPane } from './TerminalPane';
import { ProvidersView, WorkflowEditor, WorkflowView } from './WorkflowViews';
import { BusyIcon, DirectoryField, EmptyState, ErrorToast, IconButton, Modal, ModelField, ProviderSelect, Status, labels, defaultModelId, pathName, relativeTime, validModelSelection, type Perform } from './ui';

type Page = 'workspace' | 'history' | 'workflows' | 'providers' | 'collaboration';
type Dialog = 'workspace' | 'agent' | 'preview' | 'codex' | 'tools' | 'appearance' | null;
const CollaborationViews = lazy(() => import('./CollaborationViews').then(module => ({ default: module.CollaborationViews })));

function AgentIcon({ providerId, size = 16 }: { providerId: string; size?: number }) {
  return providerId === 'claude' ? <Sparkles size={size} /> : providerId === 'codex' ? <Aperture size={size} /> : <TerminalSquare size={size} />;
}

function workspaceGroup(workspace: Workspace, sessions: Session[]) {
  const relevant = sessions.filter(session => session.cwd === workspace.cwd);
  if (relevant.some(session => session.status === 'waiting_approval')) return 'attention';
  if (relevant.some(session => ['running', 'waiting_children', 'queued'].includes(session.status))) return 'working';
  const latest = relevant.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (latest?.status === 'completed') return 'review';
  if (latest?.status === 'failed' || latest?.status === 'interrupted') return 'attention';
  if (latest?.status === 'cancelled') return 'done';
  return 'new';
}

export function App() {
  const { theme, setPreference } = useAppearance();
  const reducedMotion = useReducedMotion();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState('');
  const [page, setPage] = useState<Page>('workspace');
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [newWorkflow, setNewWorkflow] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [tabMenu, setTabMenu] = useState(false);
  const tabMenuContainer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (tabMenu) tabMenuContainer.current?.querySelector<HTMLButtonElement>('[role=menuitem]:not(:disabled)')?.focus({ preventScroll: true });
  }, [tabMenu]);
  const [rightPane, setRightPane] = useState(true);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
  const visibleWorkspaces = workspaces.filter(item => `${item.name} ${item.cwd}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const refreshKey = sessions.filter(session => session.cwd === workspace?.cwd).map(session => `${session.id}:${session.status}`).join('|');

  const selectWorkspace = useCallback((id: string) => { setWorkspaceId(id); setPage('workspace'); setTabMenu(false); }, []);
  const openSession = useCallback((id: string) => {
    void perform(`open-session-${id}`, async () => {
      const current = await window.workbench.snapshot();
      const session = current.sessions.find(item => item.id === id);
      if (!session) throw new Error('会话不存在。');
      let destination = current.workspaces.find(item => item.cwd === session.cwd)?.id;
      if (!destination) destination = await window.workbench.createWorkspace({ name: pathName(session.cwd), cwd: session.cwd });
      await window.workbench.openSessionTab(destination, id);
      selectWorkspace(destination);
      setDialog(null);
    });
  }, [perform, selectWorkspace]);
  useEffect(() => window.workbench.onFocusSession(openSession), [openSession]);
  const renderTab = (tab?: WorkspaceTab) => {
    const tabSession = tab?.kind === 'agent' ? sessions.find(item => item.id === tab.sessionId) : undefined;
    const tabTerminal = tab?.kind === 'terminal' ? snapshot?.terminals.find(item => item.id === tab.terminalId) : undefined;
    if (tabSession && workspace) return <SessionChat key={tabSession.id} session={tabSession} workspaceId={workspace.id} sessions={sessions} openSession={openSession} provider={providers.find(item => item.id === tabSession.providerId)} perform={perform} pending={pending} draft={drafts[tabSession.id] ?? tabSession.draft?.text ?? ''} onDraftChange={value => setDrafts(current => ({ ...current, [tabSession.id]: value }))} />;
    if (tabTerminal && workspace) return <TerminalPane key={tabTerminal.id} info={tabTerminal} cwd={workspace.cwd} perform={perform} />;
    if (tab?.kind === 'preview') return <PreviewPane key={tab.id} tab={tab} />;
    return <EmptyState icon={<Layers2 size={28} />} title="这个项目准备好了" action={<div className="empty-actions"><button className="button" onClick={() => setDialog('agent')}><Plus size={14} />添加智能体</button><button className="button subtle" disabled={pending.has('create-terminal')} onClick={() => workspace && void perform('create-terminal', () => window.workbench.createTerminal(workspace.id))}><TerminalSquare size={14} />打开终端</button></div>}>在同一工作区打开 Codex、Claude、终端和本地预览。</EmptyState>;
  };

  const workspaceRow = (item: Workspace) => {
    const related = sessions.filter(session => session.cwd === item.cwd).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const current = related.find(session => session.status === 'waiting_approval')
      ?? related.find(session => ['running', 'waiting_children', 'queued'].includes(session.status)) ?? related[0];
    return <button key={item.id} className={`workspace-row ${page === 'workspace' && workspace?.id === item.id ? 'selected' : ''}`} onClick={() => selectWorkspace(item.id)}>
      <span className="workspace-glyph">{current ? <AgentIcon providerId={current.providerId} size={15} /> : <Layers2 size={15} />}{current?.status === 'running' && <i />}</span>
      <span className="workspace-row-body"><span className="workspace-row-title">{item.name}</span>{current && <span className="workspace-row-meta"><Status value={current.status} /></span>}</span><time>{relativeTime(item.updatedAt)}</time>
    </button>;
  };

  const groups = [
    { id: 'working', label: '进行中', icon: <CircleDot size={15} /> },
    { id: 'review', label: '待查看', icon: <CheckCircle2 size={15} /> },
    { id: 'attention', label: '需要处理', icon: <CircleAlert size={15} /> },
    { id: 'new', label: '项目', icon: <Layers2 size={15} /> },
    { id: 'done', label: '已结束', icon: <Circle size={15} /> },
  ];

  return <div className="workbench">
    <aside className="workspace-sidebar"><div className="sidebar-titlebar"><span className="brand-symbol"><PanelsTopLeft /></span><span>{PRODUCT_NAME}<span className="brand-period">.</span></span></div>
      <nav className="sidebar-navigation" aria-label="主导航"><button className="new-workspace-button" onClick={() => setDialog('workspace')}><Plus size={17} /><span>新建工作区</span></button><button className={page === 'workspace' ? 'selected' : ''} aria-current={page === 'workspace' ? 'page' : undefined} onClick={() => setPage('workspace')}><LayoutGrid size={17} /><span>工作区</span><small>{workspaces.length || ''}</small></button><button className={page === 'history' ? 'selected' : ''} aria-current={page === 'history' ? 'page' : undefined} onClick={() => setPage('history')}><History size={17} />历史记录</button><button className={page === 'collaboration' ? 'selected' : ''} aria-current={page === 'collaboration' ? 'page' : undefined} onClick={() => setPage('collaboration')}><Network size={17} />协作</button><button className={page === 'workflows' ? 'selected' : ''} aria-current={page === 'workflows' ? 'page' : undefined} onClick={() => setPage('workflows')}><GitBranch size={17} />编排</button></nav>
      <div className="workspace-sidebar-scroll">{visibleWorkspaces.some(item => item.pinned) && <section className="sidebar-section pinned-section"><div className="sidebar-section-title">已置顶</div>{visibleWorkspaces.filter(item => item.pinned).map(workspaceRow)}</section>}
        <div className="sidebar-section-title workspace-section-heading"><span>本地项目</span><IconButton label="搜索工作区" onClick={() => { setSearching(value => !value); setQuery(''); }}><Search size={13} /></IconButton></div>{searching && <div className="workspace-search"><Search size={13} /><input aria-label="搜索工作区" autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称或目录…" /></div>}
        {groups.map(group => {
          const items = visibleWorkspaces.filter(item => !item.pinned && workspaceGroup(item, sessions) === group.id);
          return items.length ? <section className={`sidebar-section group-${group.id}`} key={group.id}><div className="workspace-group-label">{group.icon}<span>{group.label}</span></div>{items.map(workspaceRow)}</section> : null;
        })}
        {!workspaces.length && <div className="sidebar-placeholder">选择本地项目目录，<br />添加 Codex、Claude 或终端。</div>}{workspaces.length > 0 && !visibleWorkspaces.length && <div className="sidebar-placeholder">没有匹配的工作区。</div>}
      </div>
      <div className="sidebar-connection"><i /><span>{snapshot ? '本地环境已连接' : loadError ? '未连接' : '连接中'}</span><small>本机</small></div><footer className="sidebar-footer"><button onClick={() => setDialog('workspace')}><Plus size={15} />添加项目</button><IconButton label="外观设置" onClick={() => setDialog('appearance')}><Palette size={16} /></IconButton><IconButton label="接入与插件" onClick={() => setPage('providers')}><Settings2 size={16} /></IconButton></footer>
    </aside>

    <main className={`main-workspace ${page === 'workspace' && workspace && rightPane ? 'with-file-panel' : ''}`}><header className="workspace-header"><div className="workspace-heading">{page === 'workspace' && workspace ? <><FolderOpen size={16} /><h1 title={workspace.name}>{workspace.name}</h1><span title={workspace.cwd}>{pathName(workspace.cwd)}</span><IconButton label={workspace.pinned ? '取消置顶' : '置顶工作区'} aria-pressed={workspace.pinned} onClick={() => void perform('pin-workspace', () => window.workbench.updateWorkspace(workspace.id, { pinned: !workspace.pinned }))}><Pin size={13} fill={workspace.pinned ? 'currentColor' : 'none'} /></IconButton></> : <h1>{{ workspace: PRODUCT_NAME, history: '历史记录', workflows: '编排', providers: '接入与插件', collaboration: 'Agent 协作' }[page]}</h1>}</div>
      <div className="workspace-header-actions">{page === 'workspace' && workspace && <><button className="header-button" onClick={() => setPage('collaboration')}><Network size={14} /><span>协作</span></button><IconButton label="项目 Skills、MCP 与用量" onClick={() => setDialog('tools')}><Settings2 size={15} /></IconButton><button className="header-button" disabled={workspace.tabs.length < 2} onClick={() => void perform('split', () => window.workbench.splitWorkspace(workspace.id, secondaryTab ? {} : { tabId: workspace.tabs.find(tab => tab.id !== activeTab?.id)?.id, direction: 'horizontal' }))}>{secondaryTab ? '合并' : '分屏'}</button>{secondaryTab && <button className="header-button" onClick={() => void perform('split-direction', () => window.workbench.splitWorkspace(workspace.id, { tabId: secondaryTab.id, direction: workspace.splitDirection === 'vertical' ? 'horizontal' : 'vertical' }))}>切换方向</button>}</>}<span className="local-indicator"><i />本地</span><IconButton label={theme === 'light' ? '切换到深色模式' : '切换到浅色模式'} onClick={() => setPreference(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}</IconButton>{page === 'workspace' && <button className="header-button" onClick={() => setDialog('codex')} title="打开官方 Codex App 并预填任务"><ArrowUpRight size={13} /><span>Codex App</span></button>}{page === 'workspace' && workspace && <IconButton label={rightPane ? '收起文件面板' : '显示文件面板'} aria-pressed={rightPane} onClick={() => setRightPane(value => !value)}><PanelRight size={16} /></IconButton>}</div>
    </header>
      {!snapshot ? <div className="loading-view">{loadError ? <><CircleAlert size={23} /><p>{loadError}</p><button className="button" onClick={() => void perform('reload', async () => { setSnapshot(await window.workbench.snapshot()); setLoadError(''); })}>重新加载</button></> : <><LoaderCircle className="spin" size={23} /><p>正在读取本地工作区</p></>}</div> : <>
        {page === 'workspace' && (workspace ? <div className="workspace-columns"><div className="workspace-center"><div className="tabbar"><div className="workspace-tabs">{workspace.tabs.map(tab => {
          const tabSession = tab.kind === 'agent' ? sessions.find(item => item.id === tab.sessionId) : undefined;
          const tabTerminal = tab.kind === 'terminal' ? snapshot.terminals.find(item => item.id === tab.terminalId) : undefined;
          const label = tab.kind === 'agent' ? providers.find(provider => provider.id === tabSession?.providerId)?.name ?? tabSession?.providerId ?? 'Agent' : tab.kind === 'terminal' ? tabTerminal?.title ?? 'Terminal' : tab.url;
          return <div key={tab.id} className={`workspace-tab ${activeTab?.id === tab.id ? 'active' : ''}`}>{activeTab?.id === tab.id && <motion.span className="workspace-tab-active" layoutId={`workspace-tab-${workspace.id}`} transition={reducedMotion ? { duration: 0 } : SPRING_SNAPPY} />}<button className="tab-select" title={tab.kind === 'agent' ? tabSession?.title : label} onClick={() => void perform('activate-tab', () => window.workbench.activateTab(workspace.id, tab.id))}>{tab.kind === 'agent' ? <AgentIcon providerId={tabSession?.providerId ?? ''} size={14} /> : tab.kind === 'terminal' ? <TerminalSquare size={14} /> : <Globe size={14} />}<span>{label}</span>{tabSession && ['running', 'waiting_approval', 'waiting_children', 'failed'].includes(tabSession.status) && <i className={`tab-state tab-state-${tabSession.status}`} aria-label={labels[tabSession.status]} title={labels[tabSession.status]} />}</button><button className="tab-close" aria-label={`关闭 ${label} 标签`} title={tab.kind === 'terminal' ? '关闭标签并停止终端' : '关闭标签'} onClick={() => void perform(`close-tab-${tab.id}`, () => window.workbench.closeTab(workspace.id, tab.id))}><X size={11} /></button></div>;
        })}</div><div className="tab-add" ref={tabMenuContainer} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setTabMenu(false); }} onKeyDown={event => {
            if (!tabMenu) return;
            if (event.key === 'Escape') { event.preventDefault(); setTabMenu(false); tabMenuContainer.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus({ preventScroll: true }); return; }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const items = Array.from(tabMenuContainer.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)') ?? []);
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
            items[next]?.focus({ preventScroll: true });
          }}><IconButton label="添加 Agent、终端或预览" aria-haspopup="menu" aria-expanded={tabMenu} onClick={() => setTabMenu(value => !value)}><Plus size={17} /></IconButton><AnimatePresence>{tabMenu && <><button key="dismiss" className="menu-dismiss" tabIndex={-1} aria-label="关闭添加菜单" onClick={() => setTabMenu(false)} /><motion.div key="menu" className="tab-menu" role="menu" aria-label="添加标签" initial={reducedMotion ? false : "initial"} animate="animate" exit={reducedMotion ? undefined : "exit"} variants={motionPopover}><button role="menuitem" onClick={() => { setDialog('agent'); setTabMenu(false); }}><MessageSquare size={15} />新建 Agent 会话</button><button role="menuitem" disabled={pending.has('create-terminal')} onClick={() => { setTabMenu(false); void perform('create-terminal', () => window.workbench.createTerminal(workspace.id)); }}><TerminalSquare size={15} />打开本机终端</button><button role="menuitem" onClick={() => { setDialog('preview'); setTabMenu(false); }}><Globe size={15} />添加本地预览</button></motion.div></>}</AnimatePresence></div></div>
          <WorkspacePanes workspace={workspace} secondary={!!secondaryTab} perform={perform} primary={renderTab(activeTab)} other={renderTab(secondaryTab)} />
        </div><motion.div className="file-panel-transition" initial={false} animate={{ width: rightPane ? 'var(--file-width)' : 0, opacity: rightPane ? 1 : 0 }} transition={reducedMotion ? { duration: 0 } : SPRING_SNAPPY} inert={!rightPane} aria-hidden={!rightPane}><FileReviewPanel key={workspace.id} workspace={workspace} refreshKey={refreshKey} perform={perform} sessions={sessions} onFeedback={activeSession ? text => { if (activeSession) setDrafts(current => ({ ...current, [activeSession.id]: [current[activeSession.id] ?? '', text].filter(Boolean).join('\n\n') })); } : undefined} /></motion.div></div> : <EmptyState icon={<Layers2 size={30} />} title="从一个本地项目开始" action={<button className="button primary" onClick={() => setDialog('workspace')}><Plus size={15} />新建工作区</button>}>把智能体、终端和预览放在一起。选择项目目录后开始工作。</EmptyState>)}
        {page === 'history' && <HistoryView sessions={sessions} providers={providers} openSession={openSession} perform={perform} />}
        {page === 'collaboration' && <Suspense fallback={<div className="loading-view"><LoaderCircle className="spin" size={23} /><p>正在打开协作视图</p></div>}><CollaborationViews snapshot={snapshot} perform={perform} pending={pending} openSession={openSession} initialCwd={workspace?.cwd} /></Suspense>}
        {page === 'workflows' && <div className="split-page"><aside className="item-sidebar"><div className="sidebar-heading"><h2>编排</h2><IconButton label="新建编排" onClick={() => setNewWorkflow(true)}><Plus size={17} /></IconButton></div><p className="sidebar-subtitle">为多个步骤安排依赖</p><div className="item-list">{workflows.map(item => <button key={item.id} className={`list-item ${item.id === workflow?.id && !newWorkflow ? 'selected' : ''}`} onClick={() => { setWorkflowId(item.id); setNewWorkflow(false); }}><strong>{item.name}</strong><div><span>{item.steps.length} 个步骤</span><Status value={item.status} /></div></button>)}</div><button className="sidebar-action" onClick={() => setNewWorkflow(true)}><Plus size={14} />新建编排</button></aside>{newWorkflow ? <WorkflowEditor providers={providers} perform={perform} pending={pending} onClose={() => setNewWorkflow(false)} onCreated={id => { setWorkflowId(id); setNewWorkflow(false); }} /> : workflow ? <WorkflowView workflow={workflow} providers={providers} sessions={sessions} perform={perform} pending={pending} openSession={openSession} openWorkflow={id => { setWorkflowId(id); setNewWorkflow(false); }} /> : <EmptyState icon={<GitBranch size={28} />} title="让多个步骤接力完成" action={<button className="button" onClick={() => setNewWorkflow(true)}><Plus size={14} />新建编排</button>}>为每一步选择智能体和任务，保存后手动开始。前序结果会交给依赖它的步骤。</EmptyState>}</div>}
        {page === 'providers' && <ProvidersView snapshot={snapshot} perform={perform} pending={pending} />}
      </>}
    </main>
    {dialog === 'appearance' && <Modal title="外观" subtitle="让工作区适合你的阅读习惯。" onClose={() => setDialog(null)}><ThemeOptions /><p className="appearance-note">主题会保存在本机。动效遵循系统的“减少动态效果”设置。</p></Modal>}
    {dialog === 'tools' && workspace && <WorkspaceTools workspace={workspace} sessions={sessions} perform={perform} onClose={() => setDialog(null)} />}
    {dialog === 'workspace' && <NewWorkspaceDialog perform={perform} pending={pending} onClose={() => setDialog(null)} onCreated={id => { setDialog(null); selectWorkspace(id); }} />}
    {dialog === 'agent' && workspace && <NewAgentDialog workspace={workspace} providers={providers} pending={pending} perform={perform} onClose={() => setDialog(null)} />}
    {dialog === 'preview' && workspace && <PreviewDialog workspace={workspace} pending={pending} perform={perform} onClose={() => setDialog(null)} />}
    {dialog === 'codex' && <CodexDialog initialCwd={workspace?.cwd ?? ''} pending={pending} perform={perform} onClose={() => setDialog(null)} />}
    {toast && <ErrorToast message={toast} onDismiss={() => setToast('')} />}
  </div>;
}

function NewWorkspaceDialog({ pending, perform, onClose, onCreated }: { pending: Set<string>; perform: Perform; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const busy = pending.has('create-workspace');
  const submit = (event: FormEvent) => { event.preventDefault(); if (!cwd.trim() || busy) return; void perform('create-workspace', async () => onCreated(await window.workbench.createWorkspace({ name: name.trim() || pathName(cwd.trim()), cwd: cwd.trim() }))); };
  return <Modal title="新建工作区" subtitle="选择本地项目，将会话、终端和预览放在一起。" busy={busy} onClose={onClose}><form onSubmit={submit}><label>项目目录<DirectoryField value={cwd} onChange={setCwd} perform={perform} /></label><label>工作区名称 <span className="optional">可选</span><input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder={cwd ? pathName(cwd) : '使用项目目录名'} maxLength={200} /></label><div className="modal-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={!cwd.trim() || busy}><BusyIcon busy={busy}><Plus size={14} /></BusyIcon>创建工作区</button></div></form></Modal>;
}

function NewAgentDialog({ workspace, providers, pending, perform, onClose }: { workspace: Workspace; providers: ProviderInfo[]; pending: Set<string>; perform: Perform; onClose: () => void }) {
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
    void perform('create-agent', async () => { await window.workbench.createSession({ cwd: workspace.cwd, providerId, ...(modelId ? { modelId } : {}), title: title.trim() || `${provider?.name ?? providerId} 会话` }); onClose(); });
  };
  return <Modal title="新建 Agent 会话" subtitle={workspace.name} busy={busy} onClose={onClose}><form onSubmit={submit}><label>智能体<ProviderSelect providers={providers} value={providerId} onChange={id => setSelection({ providerId: id, modelId: defaultModelId(providers.find(item => item.id === id)) })} /></label><ModelField provider={provider} value={modelId} disabled={busy} onChange={value => setSelection(current => ({ ...current, modelId: value }))} /><label>会话名称 <span className="optional">可选</span><input autoFocus value={title} maxLength={200} onChange={event => setTitle(event.target.value)} placeholder="例如：梳理项目结构" /></label><div className="form-note"><Folder size={14} /><span>{workspace.cwd}</span></div><div className="modal-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={!valid || busy}><BusyIcon busy={busy}><Plus size={14} /></BusyIcon>创建会话</button></div></form></Modal>;
}

function localPreviewUrl(value: string) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password; }
  catch { return false; }
}

function PreviewDialog({ workspace, pending, perform, onClose }: { workspace: Workspace; pending: Set<string>; perform: Perform; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const busy = pending.has('create-preview');
  return <Modal title="添加本地预览" subtitle="先在终端启动项目服务，再填写 localhost 地址。" busy={busy} onClose={onClose}><form onSubmit={event => { event.preventDefault(); if (!localPreviewUrl(url.trim()) || busy) return; void perform('create-preview', async () => { await window.workbench.createPreview(workspace.id, url.trim()); onClose(); }); }}><label>本地地址<input autoFocus type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="http://localhost:3000" required /></label>{url && !localPreviewUrl(url.trim()) && <p className="field-error">只支持 localhost、127.0.0.1 或 [::1] 的 HTTP / HTTPS 地址。</p>}<div className="modal-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={busy || !localPreviewUrl(url.trim())}><BusyIcon busy={busy}><Globe size={14} /></BusyIcon>打开预览</button></div></form></Modal>;
}

function PreviewPane({ tab }: { tab: Extract<WorkspaceTab, { kind: 'preview' }> }) {
  const [revision, setRevision] = useState(0);
  if (!localPreviewUrl(tab.url)) return <div className="pane-note error-text">预览地址不属于本机，已阻止加载。</div>;
  return <section className="preview-pane"><div className="preview-toolbar"><Globe size={13} /><span>{tab.url}</span><button className="text-button" onClick={() => setRevision(value => value + 1)}>重新加载</button></div><iframe title={`本地预览 ${tab.url}`} key={revision} src={tab.url} sandbox="allow-scripts allow-same-origin allow-forms" referrerPolicy="no-referrer" /></section>;
}

function CodexDialog({ initialCwd, pending, perform, onClose }: { initialCwd: string; pending: Set<string>; perform: Perform; onClose: () => void }) {
  const [cwd, setCwd] = useState(initialCwd);
  const [prompt, setPrompt] = useState('');
  const busy = pending.has('launch-codex');
  return <Modal title="在 Codex App 新建" subtitle="打开官方 Codex App 的新会话。" busy={busy} onClose={onClose}><form onSubmit={event => { event.preventDefault(); if (!cwd.trim() || busy) return; void perform('launch-codex', async () => { await window.workbench.launchCodex({ cwd: cwd.trim(), prompt }); onClose(); }); }}><label>项目目录<DirectoryField value={cwd} onChange={setCwd} perform={perform} /></label><label>预填任务 <span className="optional">可选</span><textarea value={prompt} onChange={event => setPrompt(event.target.value)} rows={4} placeholder="想让 Codex 做什么？" /></label><div className="form-note"><ArrowUpRight size={14} /><span>只预填，不自动发送。请在 Codex App 中确认并发送；输出不会回传到这个工作区。</span></div><div className="modal-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={!cwd.trim() || busy}><BusyIcon busy={busy}><ArrowUpRight size={14} /></BusyIcon>打开 Codex App</button></div></form></Modal>;
}

function WorkspacePanes({ workspace, primary, other, secondary, perform }: { workspace: Workspace; primary: ReactNode; other: ReactNode; secondary: boolean; perform: Perform }) {
  const [ratio, setRatio] = useState(workspace.splitRatio ?? 0.5);
  const ratioRef = useRef(ratio);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => { ratioRef.current = workspace.splitRatio ?? 0.5; setRatio(ratioRef.current); }, [workspace.id, workspace.splitRatio]);
  const vertical = workspace.splitDirection === 'vertical';
  return <div className={`workspace-dual ${vertical ? 'vertical' : ''}`} ref={container}><div className="tab-content" style={secondary ? { flex: `0 0 ${ratio * 100}%` } : undefined}>{primary}</div>{secondary && <><div className="split-handle" role="separator" aria-label="调整分屏比例" aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(ratio * 100)} aria-orientation={vertical ? 'horizontal' : 'vertical'} tabIndex={0} onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)} onPointerMove={event => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId) || !container.current) return;
    const rect = container.current.getBoundingClientRect();
    const next = Math.min(0.8, Math.max(0.2, vertical ? (event.clientY - rect.top) / rect.height : (event.clientX - rect.left) / rect.width));
    ratioRef.current = next; setRatio(next);
  }} onPointerUp={event => { event.currentTarget.releasePointerCapture(event.pointerId); void perform('split-ratio', () => window.workbench.splitWorkspace(workspace.id, { tabId: workspace.secondaryTabId, direction: workspace.splitDirection, ratio: ratioRef.current })); }} onKeyDown={event => { if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) { event.preventDefault(); const next = Math.max(0.2, Math.min(0.8, ratio + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -0.05 : 0.05))); void perform('split-ratio', () => window.workbench.splitWorkspace(workspace.id, { tabId: workspace.secondaryTabId, direction: workspace.splitDirection, ratio: next })); } }} /><div className="tab-content">{other}</div></>}</div>;
}

function HistoryView({ sessions, providers, openSession, perform }: { sessions: Session[]; providers: ProviderInfo[]; openSession: (id: string) => void; perform: Perform }) {
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const matching = sessions.filter(session => (archived || !session.archived) && `${session.title} ${session.cwd} ${session.messages.map(searchableMessageText).join(' ')}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return <section className="history-page"><div className="history-intro"><div><h2>会话历史</h2><p>搜索标题、目录和完整对话正文。</p></div><div className="history-search"><Search size={14} /><input aria-label="搜索会话历史" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索消息内容…" /></div></div><label className="history-archive"><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)} />包含已归档会话</label><div className="history-list">{matching.length ? matching.map(session => <div className="history-row" key={session.id}><button className="history-open" onClick={() => openSession(session.id)}><span className="history-icon"><AgentIcon providerId={session.providerId} size={19} /></span><span className="history-row-title"><strong>{session.title}{session.archived ? ' · 已归档' : ''}</strong><small title={session.cwd}>{providers.find(provider => provider.id === session.providerId)?.name ?? session.providerId}<span>·</span>{session.cwd}</small></span></button><Status value={session.status} /><time>{relativeTime(session.updatedAt)}</time><button className="text-button" disabled={['running', 'waiting_approval', 'waiting_children', 'queued'].includes(session.status)} onClick={() => void perform('archive-session', () => window.workbench.updateSession(session.id, { archived: !session.archived }))}>{session.archived ? '恢复' : '归档'}</button></div>) : <EmptyState icon={<History size={25} />} title={query ? '没有匹配的会话' : '还没有会话历史'}>从工作区添加智能体，然后发送第一条任务。</EmptyState>}</div></section>;
}
