import { useTranslation } from 'react-i18next';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Archive, ArrowLeft, ArrowRight, ArrowUpRight, CheckCircle2, ChevronRight, Circle, CircleAlert, CircleDot,
  Camera, GitBranch, Globe, History, Inbox, Layers2, LoaderCircle, MessageSquare,
  Network, PanelRight, Pin, Plus, Search, Settings2, TerminalSquare, X, LayoutGrid, FolderOpen,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { SPRING_SNAPPY, motionPopover } from './vendor/open-claude-ui/ClaudeMotionPresets';
import type { DraftEvidence, PromptAttachment, PromptInput, ProviderInfo, Session, Snapshot, Workspace, WorkspaceTab } from '../shared/types';
import type { BackendConnectionState } from '../shared/backend';
import { recoverSessionCommands, runSessionCommand } from './session-command';
import { sessionAttentionReason, sessionIsUnread, type SessionAttentionOpen } from './session-attention';
import { PRODUCT_NAME } from '../shared/app-identity';
import ensembleLogo from '../../docs/brand/ensemble-avatar.png';
import { AgentIcon } from './AgentIcon';
import { ApplicationUpdateNotice, useApplicationUpdates } from './ApplicationUpdates';
import { CommandPalette } from './CommandPalette';
import { FileReviewPanel } from './FileReviewPanel';
import { WorkspaceFilePane, useWorkspaceFilePane } from './WorkspaceFilePane';
import { SESSION_TAB_DRAG_TYPE, WorkspacePanes } from './WorkspacePanes';
import { ProjectRowActions, useProjectManagement } from './ProjectManagement';
import { NewAgentDialog } from './NewAgentDialog';
import { useVisitHistory, type Visit } from './visit-history';
import { SettingsDialog, type SettingsSection } from './SettingsDialog';
import { searchableSettings, type SettingsTarget } from './settings-targets';
import { AppSelect } from './AppSelect';
import { Tooltip } from './Tooltip';
import './features.css';
import { SessionChat } from './SessionChat';
import { SessionAttentionInbox } from './SessionAttentionInbox';
import { SessionDetailCard } from './SessionDetailCard';
import { WorkspaceFileNavigation, type WorkspaceFileRequest } from './workspace-file-reference';
import { FirstTask } from './FirstTask';
import { addDraftEvidence, localPreviewUrl } from '../shared/draft-evidence';
import { DraftTargetDialog, EvidenceTargetDialog } from './DraftEvidence';
import { PreviewPane } from './PreviewPane';
import { supportsPromptAttachment } from '../shared/prompt-attachments';
import { supportsWindowCapture, WindowCapturePreview } from './WindowCapture';
import { TerminalPane } from './TerminalPane';
import { WorkflowEditor, WorkflowView } from './WorkflowViews';
import { BusyIcon, DirectoryField, EmptyState, ErrorToast, IconButton, Modal, Status, statusLabel, pathName, relativeTime, type Perform } from './ui';

type Page = 'workspace' | 'attention' | 'history' | 'workflows' | 'collaboration';
type Dialog = 'workspace' | 'agent' | 'preview' | 'codex' | 'settings' | null;
interface TerminalAction { workspaceId: string; tabId: string; terminalId: string; kind: 'close' | 'stop' }
const CollaborationViews = lazy(() => import('./CollaborationViews').then(module => ({ default: module.CollaborationViews })));
const projectWorkStatuses: readonly Session['status'][] = ['waiting_approval', 'running', 'waiting_children', 'queued'];

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
  const applicationUpdates = useApplicationUpdates();
  const reducedMotion = useReducedMotion();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connection, setConnection] = useState<BackendConnectionState>({ status: 'connecting', synced: false });
  const [loadError, setLoadError] = useState('');
  const applicationReady = useRef(false);
  const [page, setPage] = useState<Page>('workspace');
  const [attentionOpen, setAttentionOpen] = useState<SessionAttentionOpen>();
  const onAttentionOpened = useCallback((request: SessionAttentionOpen) => {
    setAttentionOpen(current => current === request ? undefined : current);
  }, []);
  const [messageOpen, setMessageOpen] = useState<{ sessionId: string; messageId: string }>();
  const onMessageOpened = useCallback((request: NonNullable<typeof messageOpen>) => {
    setMessageOpen(current => current === request ? undefined : current);
  }, []);
  const [readingSessionId, setReadingSessionId] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [createdSessionId, setCreatedSessionId] = useState<string>();
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [newWorkflow, setNewWorkflow] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [settingsTarget, setSettingsTarget] = useState<SettingsTarget>();
  const openSettings = useCallback((section: SettingsSection = 'general', target?: SettingsTarget) => {
    setSettingsTarget(target);
    setSettingsSection(section);
    setDialog('settings');
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== ',' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey
        || event.isComposing || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      openSettings();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openSettings]);
  const [tabMenu, setTabMenu] = useState(false);
  const [draggedTab, setDraggedTab] = useState<{ workspaceId: string; tabId: string; activeTabId: string | null; secondaryTabId: string | null }>();
  const tabMenuContainer = useRef<HTMLDivElement>(null);
  const activeTabElement = useRef<HTMLDivElement>(null);
  const mainElement = useRef<HTMLElement>(null);
  const sessionFocus = useRef(new Map<string, 'composer' | 'reading'>());
  useEffect(() => {
    if (tabMenu) tabMenuContainer.current?.querySelector<HTMLButtonElement>('[role=menuitem]:not(:disabled)')?.focus({ preventScroll: true });
  }, [tabMenu]);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [archivesOpen, setArchivesOpen] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState(() => new Set<string>());
  const [drafts, setDrafts] = useState<Record<string, PromptInput>>({});
  const currentDrafts = useRef<Record<string, PromptInput>>({});
  const draftReady = useRef(new Set<string>());
  draftReady.current = new Set((snapshot?.sessions ?? []).filter(session => session.historyLoaded !== false).map(session => session.id));
  const [draftErrors, setDraftErrors] = useState<Record<string, string>>({});
  const [evidenceTarget, setEvidenceTarget] = useState<DraftEvidence>();
  const [windowCaptures, setWindowCaptures] = useState<PromptAttachment[]>([]);
  const windowCapture = windowCaptures[0];
  const stageWindowCapture = useCallback((attachment: PromptAttachment) => setWindowCaptures(items => [...items, attachment]), []);
  useEffect(() => window.workbench.onWindowCaptured?.(stageWindowCapture), [stageWindowCapture]);
  const [artifactJump, setArtifactJump] = useState<{ runId: string; artifactId: string }>();
  const [annotationJump, setAnnotationJump] = useState<{
    tabId: string; id: string; annotation: Extract<DraftEvidence['source'], { kind: 'preview' }>;
  }>();
  const [fileRequest, setFileRequest] = useState<WorkspaceFileRequest>();
  const [terminalAction, setTerminalAction] = useState<TerminalAction>();
  const [hiddenTerminals, setHiddenTerminals] = useState(new Set<string>());
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
  const projectManagement = useProjectManagement(perform);

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

  const workspaces = snapshot?.workspaces.filter(item => !item.archived) ?? [];
  const sessions = snapshot?.sessions ?? [];
  const workflows = snapshot?.workflows ?? [];
  const providers = snapshot?.providers ?? [];
  const workspace = workspaces.find(item => item.id === workspaceId) ?? workspaces[0];
  const filePane = useWorkspaceFilePane(page === 'workspace' && Boolean(workspace));
  const { visible: rightPane, setRequested: setRightPane } = filePane;
  const workflow = workflows.find(item => item.id === workflowId) ?? workflows[0];
  const activeTab = workspace?.tabs.find(tab => tab.id === workspace.activeTabId) ?? workspace?.tabs[0];
  const secondaryTab = workspace?.tabs.find(tab => tab.id === workspace.secondaryTabId && tab.id !== activeTab?.id);
  const activeSession = activeTab?.kind === 'agent' ? sessions.find(session => session.id === activeTab.sessionId) : undefined;
  const splitBusy = pending.has('split') || pending.has('split-direction') || pending.has('split-ratio');
  const draggedTabId = draggedTab && draggedTab.workspaceId === workspace?.id && draggedTab.activeTabId === (activeTab?.id ?? null)
    && workspace?.tabs.some(tab => tab.id === draggedTab.tabId && tab.kind === 'agent') && !splitBusy ? draggedTab.tabId : undefined;
  useEffect(() => { setDraggedTab(undefined); }, [page, workspace?.id, activeTab?.id]);
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
    if (!connected || !snapshot || applicationReady.current) return;
    applicationReady.current = true;
    void window.workbench.confirmApplicationUpdateReady().catch(error => {
      setToast(error instanceof Error ? error.message : String(error));
    });
  }, [connected, snapshot]);
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
  const matchesSearch = (item: Workspace) => `${item.name} ${item.cwd}`.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  const visibleWorkspaces = workspaces.filter(matchesSearch);
  const archivedWorkspaces = snapshot?.workspaces.filter(item => item.archived) ?? [];
  const visibleArchives = archivedWorkspaces.filter(matchesSearch);
  const refreshKey = sessions.filter(session => session.cwd === workspace?.cwd).map(session => `${session.id}:${session.status}`).join('|');

  const selectWorkspace = useCallback((id: string) => {
    setAttentionOpen(undefined); setMessageOpen(undefined); setReadingSessionId(null); setWorkspaceId(id); setPage('workspace'); setTabMenu(false);
  }, []);
  const createdCwd = sessions.find(session => session.id === createdSessionId)?.cwd;
  const createdWorkspaceId = createdCwd && workspaces.find(item => item.cwd === createdCwd)?.id;
  useLayoutEffect(() => {
    if (!createdWorkspaceId) return;
    setCreatedSessionId(undefined);
    selectWorkspace(createdWorkspaceId);
  }, [createdWorkspaceId, selectWorkspace]);
  const openSession = useCallback((id: string, readOnly = false, fromAttention: boolean | SessionAttentionOpen = false, messageId?: string) => {
    void perform(`open-session-${id}`, async () => {
      const current = await window.workbench.snapshot();
      const session = current.sessions.find(item => item.id === id);
      if (!session) throw new Error(t('app.sessionMissing'));
      const destination = current.workspaces.find(item => !item.archived && item.cwd === session.cwd)?.id;
      const reason = fromAttention === true ? sessionAttentionReason(session) : undefined;
      const request = typeof fromAttention === 'object' ? fromAttention : reason ? {
        sessionId: id, reason, revision: session.attention?.revision, approvalId: session.approvals.at(-1)?.id, messageId: session.attention?.messageId,
      } : undefined;
      if (readOnly || !destination) {
        setAttentionOpen(request);
        setMessageOpen(messageId ? { sessionId: id, messageId } : undefined);
        setReadingSessionId(id); setPage('history'); setDialog(null); return;
      }
      await window.workbench.openSessionTab(destination, id);
      selectWorkspace(destination);
      setAttentionOpen(request);
      setMessageOpen(messageId ? { sessionId: id, messageId } : undefined);
      setDialog(null);
    });
  }, [perform, selectWorkspace, t]);
  const openForkSource = useCallback((id: string, messageId?: string) => openSession(id, false, false, messageId), [openSession]);
  useEffect(() => window.workbench.onFocusSession(target => openSession(target.sessionId, false, target)), [openSession]);
  const appendToDraft = async (sessionId: string, save: () => Promise<PromptInput>, merge: (draft: PromptInput) => PromptInput) => {
    const before = currentDrafts.current[sessionId];
    const saved = await save();
    const latest = currentDrafts.current[sessionId];
    if (latest && latest !== before) {
      updateDraft(sessionId, merge(latest), latest);
    } else {
      currentDrafts.current[sessionId] = saved;
      setDrafts(current => ({ ...current, [sessionId]: saved }));
      setDraftErrors(current => ({ ...current, [sessionId]: '' }));
    }
  };
  const addEvidence = (id: string, reference: DraftEvidence) => appendToDraft(id,
    () => window.workbench.addSessionEvidence(id, reference), draft => addDraftEvidence(draft, reference));
  const addCapture = (id: string, attachment: PromptAttachment) => appendToDraft(id,
    () => window.workbench.addSessionAttachment(id, attachment),
    draft => draft.attachments?.some(item => item.id === attachment.id) ? draft
      : { ...draft, attachments: [...(draft.attachments ?? []), attachment] });
  const openEvidence = (source: DraftEvidence['source']) => {
    if (source.kind === 'message') {
      const origin = sessions.find(session => session.id === source.sessionId);
      if (page === 'workspace' && workspace && activeSession && origin?.cwd === workspace.cwd && origin.id !== activeSession.id) {
        void perform('open-evidence-message', async () => {
          await window.workbench.openSessionTab(workspace.id, origin.id, activeSession.id);
          setMessageOpen({ sessionId: origin.id, messageId: source.messageId });
        });
      } else openSession(source.sessionId, false, false, source.messageId);
    } else if (source.kind === 'artifact') {
      setArtifactJump({ runId: source.runId, artifactId: source.artifactId });
      setPage('collaboration');
    } else {
      void perform('open-evidence-preview', async () => {
        const current = await window.workbench.snapshot();
        const destination = current.workspaces.find(item => !item.archived && item.tabs.some(tab => tab.id === source.tabId && tab.kind === 'preview'));
        if (!destination) throw new Error(t('app.previewSourceMissing'));
        if (page === 'workspace' && workspace?.id === destination.id && activeSession) {
          if (destination.secondaryTabId !== source.tabId) await window.workbench.splitWorkspace(destination.id, {
            tabId: source.tabId, direction: 'horizontal', placement: 'after',
            expectedLayout: { activeTabId: destination.activeTabId, secondaryTabId: destination.secondaryTabId ?? null },
          });
        } else {
          await window.workbench.activateTab(destination.id, source.tabId);
          selectWorkspace(destination.id);
        }
        setAnnotationJump({ tabId: source.tabId, id: source.annotationId, annotation: source });
      });
    }
  };
  const openAgentDialog = useCallback(() => {
    if (!workspace) return;
    selectWorkspace(workspace.id);
    setDialog('agent');
  }, [workspace?.id, selectWorkspace]);
  useEffect(() => {
    if (!workspace || !connected || dialog) return;
    const handleKey = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'n'
        || event.isComposing || event.repeat || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      openAgentDialog();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [workspace?.id, connected, dialog, openAgentDialog]);
  const openLocalTerminal = () => {
    if (!workspace || pending.has('create-terminal')) return;
    setPage('workspace');
    setTabMenu(false);
    void perform('create-terminal', () => window.workbench.createTerminal(workspace.id));
  };
  const showFiles = () => { setPage('workspace'); setRightPane(true); };
  const setTerminalHidden = (id: string, hidden: boolean) => setHiddenTerminals(current => {
    if (current.has(id) === hidden) return current;
    const next = new Set(current);
    if (hidden) next.add(id); else next.delete(id);
    return next;
  });
  const visit: Visit | undefined = !snapshot ? undefined
    : page === 'workspace' ? { page, workspaceId: workspace?.id ?? null, tabId: activeTab?.id ?? null,
      ...(activeTab?.kind === 'agent' ? { sessionId: activeTab.sessionId } : {}) }
    : page === 'history' ? { page, sessionId: readingSession?.id ?? null }
    : page === 'workflows' ? { page, workflowId: workflow?.id ?? null }
    : page === 'collaboration' ? { page, workspaceId: workspace?.id ?? null } : { page };
  const canVisit = (target: Visit) => {
    if (target.page === 'history') return target.sessionId === null || sessions.some(session => session.id === target.sessionId);
    if (target.page === 'workflows') return target.workflowId === null ? !workflows.length : workflows.some(item => item.id === target.workflowId);
    if (target.page === 'collaboration') return target.workspaceId === null ? !workspaces.length : workspaces.some(item => item.id === target.workspaceId);
    if (target.page !== 'workspace') return true;
    if (target.workspaceId === null) return !workspaces.length;
    const project = workspaces.find(item => item.id === target.workspaceId);
    if (!project) return false;
    if (target.sessionId) return sessions.some(session => session.id === target.sessionId && session.cwd === project.cwd);
    return target.tabId === null ? !project.tabs.length : project.tabs.some(tab => tab.id === target.tabId);
  };
  const restoreVisit = async (target: Visit) => {
    let restored = false;
    await perform('visit-history', async () => {
      if (target.page === 'workspace') {
        const project = workspaces.find(item => item.id === target.workspaceId);
        const tab = target.sessionId ? project?.tabs.find(item => item.kind === 'agent' && item.sessionId === target.sessionId)
          : project?.tabs.find(item => item.id === target.tabId);
        if (project && tab && tab.id !== project.activeTabId) await window.workbench.activateTab(project.id, tab.id);
        else if (project && !tab && target.sessionId) await window.workbench.openSessionTab(project.id, target.sessionId);
        if (tab?.kind === 'terminal') setTerminalHidden(tab.terminalId, false);
      }
      setAttentionOpen(undefined);
      setMessageOpen(undefined);
      setTabMenu(false);
      if (target.page === 'workspace' || target.page === 'collaboration') setWorkspaceId(target.workspaceId);
      if (target.page === 'history') setReadingSessionId(target.sessionId);
      if (target.page === 'workflows') { setWorkflowId(target.workflowId); setNewWorkflow(false); }
      setPage(target.page);
      restored = true;
    });
    return restored;
  };
  const focusVisit = () => {
    const pane = page === 'workspace' && activeTab
      ? mainElement.current?.querySelector<HTMLElement>(`[data-workspace-pane="${CSS.escape(activeTab.id)}"] ${activeSession && sessionFocus.current.get(activeSession.id) === 'composer' ? '.composer textarea' : '.message-scroll'}`)
      : page === 'history' && readingSession ? mainElement.current?.querySelector<HTMLElement>('.history-session-view .message-scroll') : undefined;
    (pane ?? (page === 'workspace' ? activeTabElement.current?.querySelector<HTMLButtonElement>('.tab-select') : undefined)
      ?? mainElement.current?.querySelector<HTMLElement>('.workspace-heading h1'))?.focus({ preventScroll: true });
  };
  const visits = useVisitHistory(visit, canVisit, restoreVisit, focusVisit, connected && !dialog);
  const [terminalFocus, setTerminalFocus] = useState<{ id: string }>();
  const returnToComposer = useCallback(() => {
    if (!activeSession) return;
    document.querySelector<HTMLTextAreaElement>(`[data-chat-session-id="${CSS.escape(activeSession.id)}"] .composer textarea`)?.focus({ preventScroll: true });
  }, [activeSession?.id]);
  const openSessionTerminal = useCallback(() => {
    if (!workspace || !activeSession || page !== 'workspace' || !connected) return;
    void perform('open-session-terminal', async () => {
      const id = await window.workbench.createTerminal(workspace.id, activeSession.id);
      setTerminalHidden(id, false);
      setTerminalFocus({ id });
    });
  }, [workspace?.id, activeSession?.id, page, connected, perform]);
  useEffect(() => {
    if (page !== 'workspace' || !activeSession || !connected) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'j' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey
        || event.isComposing || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      if (event.repeat) return;
      if (event.target instanceof Element && event.target.closest('.terminal-pane')) returnToComposer();
      else openSessionTerminal();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [page, activeSession?.id, connected, openSessionTerminal, returnToComposer]);
  const activateTab = (id: string, tab: WorkspaceTab) => {
    if (tab.kind === 'terminal') setTerminalHidden(tab.terminalId, false);
    void perform('activate-tab', () => window.workbench.activateTab(id, tab.id));
  };
  const requestCloseTab = (id: string, tab: WorkspaceTab, terminalExited: boolean) => {
    if (tab.kind === 'terminal' && !terminalExited) {
      setTerminalAction({ workspaceId: id, tabId: tab.id, terminalId: tab.terminalId, kind: 'close' });
      return;
    }
    void perform(`close-tab-${tab.id}`, async () => {
      await window.workbench.closeTab(id, tab.id);
      if (tab.kind === 'terminal') setTerminalHidden(tab.terminalId, false);
    });
  };
  const terminalActionKey = terminalAction && `terminal-action-${terminalAction.terminalId}`;
  const renderTab = (tab?: WorkspaceTab) => {
    const tabSession = tab?.kind === 'agent' ? sessions.find(item => item.id === tab.sessionId) : undefined;
    const tabTerminal = tab?.kind === 'terminal' ? snapshot?.terminals.find(item => item.id === tab.terminalId) : undefined;
    if (tabSession && workspace) return <SessionChat key={tabSession.id} session={tabSession} sessions={sessions} openSession={openSession} connected={connected} provider={providers.find(item => item.id === tabSession.providerId)} providers={providers} perform={perform} pending={pending} draft={drafts[tabSession.id] ?? tabSession.draft ?? { text: '' }} draftError={draftErrors[tabSession.id]} onDraftChange={(value, expected) => updateDraft(tabSession.id, value, expected)}
      workspaceId={workspace.id} onChooseEvidence={connected ? setEvidenceTarget : undefined} onOpenEvidence={openEvidence}
      attentionOpen={tab?.id === activeTab?.id && attentionOpen?.sessionId === tabSession.id ? attentionOpen : undefined}
      onAttentionOpened={onAttentionOpened} messageOpen={messageOpen?.sessionId === tabSession.id ? messageOpen : undefined}
      onMessageOpened={onMessageOpened} onOpenForkSource={openForkSource} />;
    if (tab?.kind === 'terminal' && tabTerminal && workspace) {
      if (hiddenTerminals.has(tabTerminal.id)) return <div className="terminal-collapsed">
        <button className="button" onClick={() => setTerminalHidden(tabTerminal.id, false)}><TerminalSquare size={14} />{t('app.showTerminal')}</button>
      </div>;
      return <TerminalPane key={tabTerminal.id} info={tabTerminal} cwd={workspace.cwd} perform={perform}
        focusRequest={terminalFocus?.id === tabTerminal.id ? terminalFocus : undefined}
        onReturn={activeSession && tab.id === secondaryTab?.id ? returnToComposer : undefined}
        onHide={() => setTerminalHidden(tabTerminal.id, true)}
        onStop={() => setTerminalAction({ workspaceId: workspace.id, tabId: tab.id, terminalId: tabTerminal.id, kind: 'stop' })} />;
    }
    if (tab?.kind === 'preview') return <PreviewPane key={tab.id} tab={tab} drafts={drafts}
      keyboardShortcut={tab.id === activeTab?.id || activeTab?.kind !== 'preview'}
      onChooseEvidence={connected ? setEvidenceTarget : undefined} annotationJump={annotationJump} />;
    return <EmptyState icon={<Layers2 size={28} />} title={t('app.projectReady')} action={<div className="empty-actions"><button className="button" onClick={openAgentDialog}><Plus size={14} />{t('app.addAgent')}</button><button className="button subtle" disabled={pending.has('create-terminal')} onClick={openLocalTerminal}><TerminalSquare size={14} />{t('app.openTerminal')}</button></div>}>{t('app.projectReadyNote')}</EmptyState>;
  };

  const workspaceRow = (item: Workspace, group: string, last: boolean) => {
    const related = sessions.filter(session => session.cwd === item.cwd).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const current = related.find(session => sessionAttentionReason(session) === 'approval')
      ?? related.find(session => sessionAttentionReason(session) === 'failure')
      ?? related.find(session => ['running', 'waiting_children', 'queued'].includes(session.status))
      ?? related.find(session => sessionAttentionReason(session) === 'result') ?? related[0];
    const unread = related.filter(sessionIsUnread).length;
    const selected = page === 'workspace' && workspace?.id === item.id;
    const expanded = expandedProjects.has(item.id);
    const listId = `workspace-sessions-${item.id}`;
    const projectSessions = related.filter(session => !session.archived).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const activeCounts = projectWorkStatuses.flatMap(status => {
      const count = related.filter(session => session.status === status).length;
      return count ? [{ status, count }] : [];
    });
    const row = <button type="button" data-workspace-id={item.id} aria-current={selected ? 'true' : undefined}
        className={`workspace-row group-${group}${selected ? ' selected' : ''}`} onClick={() => selectWorkspace(item.id)}>
        <span className="workspace-glyph">{current ? <AgentIcon providerId={current.providerId} size={15} /> : <Layers2 size={15} />}{activeCounts.some(({ status }) => status === 'running') && <i />}</span>
        <span className="workspace-row-body"><span className="workspace-row-title">{item.name}</span>
          {current && <span className="workspace-row-meta">
            {activeCounts.length ? activeCounts.map(({ status, count }) => <span key={status} className={`status status-${status}`}>
              {t('app.projectStatusCount', { count, status: statusLabel(status) })}
            </span>) : <Status value={current.status} />}
            <AttentionBadge session={current} />
          </span>}
        </span>{unread > 0 && <span className="workspace-unread" aria-label={t('attention.unreadSessions', { count: unread })}>{unread}</span>}
        {!activeCounts.length && <time>{relativeTime(item.updatedAt)}</time>}
      </button>;
    return <motion.div key={`workspace:${item.id}`} initial={false}
      layout={reducedMotion || searching ? false : 'position'} transition={{ layout: SPRING_SNAPPY }}
      className={`workspace-row-entry with-sessions group-${group}${last ? ' workspace-group-end' : ''}${selected ? ' selected' : ''}`}>
      <div className="workspace-row-main">
        {projectSessions.length > 0 && <IconButton label={t('app.projectSessions', { project: item.name })}
          className="icon-button workspace-session-toggle" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpandedProjects(current => {
            const next = new Set(current);
            if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
            return next;
          })}><ChevronRight size={12} /></IconButton>}
        {current ? <SessionDetailCard session={current} provider={providers.find(provider => provider.id === current.providerId)} side="right">{row}</SessionDetailCard> : row}
        <ProjectRowActions workspace={item} disabled={!connected || projectManagement.busy} onAction={action => projectManagement.open(item, action)} />
      </div>
      <ul id={listId} className="workspace-session-list" hidden={!expanded}>
        {expanded && projectSessions.map(session => <li key={session.id}><button type="button" disabled={!connected}
          aria-current={selected && session.id === activeSession?.id ? 'true' : undefined} onClick={() => openSession(session.id)}>
          <AgentIcon providerId={session.providerId} size={13} />
          <span className="workspace-session-title" title={session.title}>{session.title}</span>
          <Status value={session.status} /><AttentionBadge session={session} />
        </button></li>)}
      </ul>
    </motion.div>;
  };

  const groups = [
    { id: 'working', label: t('app.working'), icon: <CircleDot size={15} /> },
    { id: 'review', label: t('app.review'), icon: <CheckCircle2 size={15} /> },
    { id: 'attention', label: t('app.attention'), icon: <CircleAlert size={15} /> },
    { id: 'new', label: t('app.projects'), icon: <Layers2 size={15} /> },
    { id: 'done', label: t('app.done'), icon: <Circle size={15} /> },
  ];
  const sidebarItems: ReactNode[] = [];
  const pinnedWorkspaces = visibleWorkspaces.filter(item => item.pinned);
  if (pinnedWorkspaces.length) {
    sidebarItems.push(<div key="heading:pinned" className="sidebar-section-title">{t('app.pinned')}</div>);
    sidebarItems.push(...pinnedWorkspaces.map((item, index) => workspaceRow(item, 'pinned', index === pinnedWorkspaces.length - 1)));
  }
  sidebarItems.push(<div key="heading:local" className="sidebar-section-title workspace-section-heading"><span>{t('app.localProjects')}</span><IconButton label={t('app.searchWorkspaces')} onClick={() => { setSearching(value => !value); setQuery(''); }}><Search size={13} /></IconButton></div>);
  if (searching) sidebarItems.push(<div key="search" className="workspace-search"><Search size={13} /><input aria-label={t('app.searchWorkspaces')} autoFocus value={query} onChange={event => { setQuery(event.target.value); if (event.target.value.trim()) setArchivesOpen(true); }} placeholder={t('app.searchPlaceholder')} /></div>);
  for (const group of groups) {
    const items = visibleWorkspaces.filter(item => !item.pinned && workspaceGroup(item, sessions) === group.id);
    if (!items.length) continue;
    sidebarItems.push(<div key={`heading:${group.id}`} className={`workspace-group-label group-${group.id}`}>{group.icon}<span>{group.label}</span></div>);
    sidebarItems.push(...items.map((item, index) => workspaceRow(item, group.id, index === items.length - 1)));
  }
  if (!workspaces.length) sidebarItems.push(<div key="empty" className="sidebar-placeholder">{t('app.chooseLocalProject')}<br />{t('app.addRuntimeNote')}</div>);
  if (query.trim() && !visibleWorkspaces.length && !visibleArchives.length) sidebarItems.push(<div key="no-match" className="sidebar-placeholder">{t('app.noWorkspaceMatch')}</div>);
  if (visibleArchives.length) sidebarItems.push(<section key="archives" className="workspace-archives">
    <button type="button" className="workspace-archive-toggle" aria-expanded={archivesOpen} aria-controls="workspace-archive-list"
      onClick={() => setArchivesOpen(open => !open)}>
      <ChevronRight size={12} /><span>{t('projectManagement.archived')}</span><small>{visibleArchives.length}</small>
    </button>
    <div id="workspace-archive-list" hidden={!archivesOpen}>
      {archivesOpen && visibleArchives.map(item => <div className="workspace-row-entry archived" key={item.id}>
        <div className="workspace-row" data-archived-workspace-id={item.id}><span className="workspace-glyph"><Archive size={14} /></span><span className="workspace-row-body"><span className="workspace-row-title">{item.name}</span></span></div>
        <ProjectRowActions workspace={item} disabled={!connected || projectManagement.busy} onAction={action => {
          if (action === 'restore' && workspace) setWorkspaceId(workspace.id);
          projectManagement.open(item, action);
        }} />
      </div>)}
    </div>
  </section>);

  const fileNavigation = useMemo<React.ContextType<typeof WorkspaceFileNavigation>>(() => page === 'workspace' && workspace && connected ? {
    cwd: workspace.cwd,
    open: reference => {
      setFileRequest({ ...reference, workspaceId: workspace.id });
      setRightPane(true);
    },
    request: fileRequest,
    consume: request => setFileRequest(current => current === request ? undefined : current),
  } : null, [page, workspace?.cwd, workspace?.id, connected, fileRequest]);

  return <WorkspaceFileNavigation.Provider value={fileNavigation}><div className="workbench">
    <aside className="workspace-sidebar"><div className="sidebar-titlebar"><img className="brand-symbol" src={ensembleLogo} alt="" /><span>{PRODUCT_NAME}<span className="brand-period">.</span></span></div>
      <CommandPalette projects={workspaces} sessions={sessions} providers={providers} onSelectProject={selectWorkspace} onSelectSession={openSession}
        fileWorkspaceId={fileNavigation ? workspace?.id : undefined} onOpenFile={path => fileNavigation?.open({ path })}
        settings={searchableSettings(t, workspace?.name, activeSession?.title).map(item => ({
          id: `setting:${item.id}`, label: item.title, detail: item.detail, keywords: item.keywords,
          icon: <Settings2 size={16} aria-hidden="true" />, run: () => openSettings(item.section, item),
        }))}
        actions={[
          { id: 'new-project', label: t('commandPalette.newProject'), keywords: t('app.newWorkspace'), icon: <Plus size={16} aria-hidden="true" />, run: () => setDialog('workspace') },
          ...(supportsWindowCapture && connected && sessions.some(session => !session.archived) ? [{
            id: 'capture-window', label: t('app.captureWindow'), icon: <Camera size={16} aria-hidden="true" />,
            run: () => void perform('capture-window', async () => {
              const attachment = await window.workbench.captureWindow();
              if (attachment) stageWindowCapture(attachment);
            }),
          }] : []),
          ...(workspace ? [
            { id: 'new-agent', label: t('app.newAgentSession'), icon: <MessageSquare size={16} aria-hidden="true" />, run: openAgentDialog },
            ...(!pending.has('create-terminal') ? [{ id: 'open-terminal', label: t('app.openLocalTerminal'), icon: <TerminalSquare size={16} aria-hidden="true" />, run: openLocalTerminal }] : []),
            ...(activeSession && connected ? [{ id: 'open-session-terminal', label: t('app.openSessionTerminal'), detail: workspace.cwd,
              icon: <TerminalSquare size={16} aria-hidden="true" />, run: openSessionTerminal }] : []),
            { id: 'open-files', label: t('commandPalette.openFiles'), keywords: t('app.showFiles'), icon: <PanelRight size={16} aria-hidden="true" />, run: showFiles },
          ] : []),
          { id: 'settings', label: t('preferences.open'), icon: <Settings2 size={16} aria-hidden="true" />, run: () => openSettings() },
        ]} />
      <nav className="sidebar-navigation" aria-label={t('app.navigation')}><button className="new-workspace-button" onClick={() => setDialog('workspace')}><Plus size={17} /><span>{t('app.newWorkspace')}</span></button><button className={page === 'workspace' ? 'selected' : ''} aria-current={page === 'workspace' ? 'page' : undefined} onClick={() => setPage('workspace')}><LayoutGrid size={17} /><span>{t('app.workspace')}</span><small>{workspaces.length || ''}</small></button>
        <button className={page === 'attention' ? 'selected' : ''} aria-current={page === 'attention' ? 'page' : undefined}
          onClick={() => { setAttentionOpen(undefined); setPage('attention'); }}><Inbox size={17} />{t('attention.inboxTitle')}</button>
        <button className={page === 'history' ? 'selected' : ''} aria-current={page === 'history' ? 'page' : undefined} onClick={() => setPage('history')}><History size={17} />{t('app.history')}</button><button className={page === 'collaboration' ? 'selected' : ''} aria-current={page === 'collaboration' ? 'page' : undefined} onClick={() => setPage('collaboration')}><Network size={17} />{t('app.collaboration')}</button><button className={page === 'workflows' ? 'selected' : ''} aria-current={page === 'workflows' ? 'page' : undefined} onClick={() => setPage('workflows')}><GitBranch size={17} />{t('app.workflows')}</button></nav>
      <motion.div className="workspace-sidebar-scroll" layoutScroll>{sidebarItems}</motion.div>
      <div className={`sidebar-connection connection-${connected ? 'connected' : connection.status}`}><i /><span>{connected ? t('app.connected') : t(`connection.${connection.status}`)}</span><small>{t('app.thisMachine')}</small></div><footer className="sidebar-footer"><button onClick={() => setDialog('workspace')}><Plus size={15} />{t('app.addProject')}</button><IconButton label={t('preferences.open')} onClick={() => openSettings()}><Settings2 size={16} /></IconButton></footer>
    </aside>

    <main ref={mainElement} className={`main-workspace ${page === 'workspace' && workspace && rightPane ? 'with-file-panel' : ''}`}
      onFocusCapture={event => {
        const target = event.target;
        const id = target.closest<HTMLElement>('[data-chat-session-id]')?.dataset.chatSessionId;
        if (id && target.closest('.composer textarea')) sessionFocus.current.set(id, 'composer');
        else if (id && target.closest('.message-scroll')) sessionFocus.current.set(id, 'reading');
      }}><header className="workspace-header">
      <div className="workspace-heading">
        <div className="visit-history-controls" role="group" aria-label={t('app.visitHistory')}>
          <IconButton label={t('app.visitBack')} title={t('app.visitBackHint')} aria-keyshortcuts="Meta+[" disabled={!visits.canBack} onClick={visits.back}><ArrowLeft size={15} /></IconButton>
          <IconButton label={t('app.visitForward')} title={t('app.visitForwardHint')} aria-keyshortcuts="Meta+]" disabled={!visits.canForward} onClick={visits.forward}><ArrowRight size={15} /></IconButton>
        </div>
        {page === 'workspace' && workspace ? <><FolderOpen size={16} /><h1 tabIndex={-1} title={workspace.name}>{workspace.name}</h1><span title={workspace.cwd}>{pathName(workspace.cwd)}</span><IconButton label={workspace.pinned ? t('app.unpin') : t('app.pin')} aria-pressed={workspace.pinned} onClick={() => void perform('pin-workspace', () => window.workbench.updateWorkspace(workspace.id, { pinned: !workspace.pinned }))}><Pin size={13} fill={workspace.pinned ? 'currentColor' : 'none'} /></IconButton></> : <h1 tabIndex={-1}>{{ workspace: PRODUCT_NAME, attention: t('attention.inboxTitle'), history: t('app.history'), workflows: t('app.workflows'), collaboration: t('app.agentCollaboration') }[page]}</h1>}
      </div>
      <div className="workspace-header-actions">{page === 'workspace' && workspace && <><Tooltip label={t('app.collaboration')}><button className="header-button" aria-label={t('app.collaboration')} title={t('app.collaboration')} onClick={() => setPage('collaboration')}><Network size={14} /><span>{t('app.collaboration')}</span></button></Tooltip><button className="header-button" disabled={workspace.tabs.length < 2} onClick={() => void perform('split', () => window.workbench.splitWorkspace(workspace.id, secondaryTab ? {} : { tabId: workspace.tabs.find(tab => tab.id !== activeTab?.id)?.id, direction: 'horizontal' }))}>{secondaryTab ? t('app.mergePanes') : t('app.splitPanes')}</button>{secondaryTab && <button className="header-button" onClick={() => void perform('split-direction', () => window.workbench.splitWorkspace(workspace.id, { tabId: secondaryTab.id, direction: workspace.splitDirection === 'vertical' ? 'horizontal' : 'vertical' }))}>{t('app.changeDirection')}</button>}</>}<span className="local-indicator"><i />{t('app.local')}</span>{page === 'workspace' && <Tooltip label={t('app.openCodex')}><button className="header-button" onClick={() => setDialog('codex')} aria-label={t('app.openCodex')} title={t('app.openCodexHint')}><ArrowUpRight size={13} /><span>Codex App</span></button></Tooltip>}{page === 'workspace' && workspace && <>
        {filePane.requested && filePane.tooNarrow && <span className="file-pane-space-note" id={`${filePane.id}-space`} role="status">{t('app.filesNeedSpace')}</span>}
        <IconButton id={`${filePane.id}-toggle`} label={filePane.requested ? t('app.hideFiles') : t('app.showFiles')}
          title={filePane.tooNarrow ? t('app.filesNeedSpace') : undefined} aria-pressed={filePane.requested} aria-controls={filePane.id}
          aria-describedby={filePane.requested && filePane.tooNarrow ? `${filePane.id}-space` : undefined}
          onClick={() => setRightPane(value => !value)}><PanelRight size={16} /></IconButton>
      </>}</div>
    </header>
      <ApplicationUpdateNotice state={applicationUpdates.state} onOpen={() => openSettings('general')} />
      {snapshot && !connected && <div className="connection-banner" role="status"><CircleAlert size={14} /><span>{t('connection.stale')}{connection.lastReceivedAt && ` · ${t('connection.lastUpdate', { time: relativeTime(connection.lastReceivedAt) })}`}</span>{connection.error && <small>{connection.error}</small>}</div>}
      {!snapshot ? <div className="loading-view">{loadError ? <><CircleAlert size={23} /><p>{loadError}</p><button className="button" onClick={() => void perform('reload', async () => { setSnapshot(await window.workbench.snapshot()); setLoadError(''); })}>{t('common.reload')}</button></> : <><LoaderCircle className="spin" size={23} /><p>{t('app.loading')}</p></>}</div> : <>
        {page === 'workspace' && (workspace ? <div className="workspace-columns" ref={filePane.columns}><div className="workspace-center"><div className="tabbar"><div className="workspace-tabs">{workspace.tabs.map(tab => {
          const tabSession = tab.kind === 'agent' ? sessions.find(item => item.id === tab.sessionId) : undefined;
          const tabTerminal = tab.kind === 'terminal' ? snapshot.terminals.find(item => item.id === tab.terminalId) : undefined;
          const label = tab.kind === 'agent' ? tabSession?.title || providers.find(provider => provider.id === tabSession?.providerId)?.name || tabSession?.providerId || 'Agent' : tab.kind === 'terminal' ? tabTerminal?.title ?? 'Terminal' : tab.url;
          const canDrag = Boolean(tabSession && connected && !splitBusy && tab.id !== activeTab?.id);
          const tabButton = <button className="tab-select" aria-current={activeTab?.id === tab.id ? 'page' : undefined} title={tabSession ? undefined : label}
            draggable={canDrag} onDragStart={event => {
              if (!canDrag) { event.preventDefault(); return; }
              event.dataTransfer.setData(SESSION_TAB_DRAG_TYPE, tab.id);
              event.dataTransfer.effectAllowed = 'move';
              setDraggedTab({ workspaceId: workspace.id, tabId: tab.id, activeTabId: workspace.activeTabId, secondaryTabId: workspace.secondaryTabId ?? null });
            }} onDragEnd={() => setDraggedTab(undefined)}
            onClick={() => activateTab(workspace.id, tab)}>
            {tab.kind === 'agent' ? <AgentIcon providerId={tabSession?.providerId ?? ''} size={14} /> : tab.kind === 'terminal' ? <TerminalSquare size={14} /> : <Globe size={14} />}
            <span>{label}</span>{tabSession && <AttentionBadge session={tabSession} />}
            {tabSession && ['running', 'waiting_approval', 'waiting_children', 'failed'].includes(tabSession.status) && <i className={`tab-state tab-state-${tabSession.status}`} aria-label={statusLabel(tabSession.status)} />}
          </button>;
          return <div key={tab.id} ref={activeTab?.id === tab.id ? activeTabElement : undefined} className={`workspace-tab ${activeTab?.id === tab.id ? 'active' : ''}`}>
            {activeTab?.id === tab.id && <motion.span className="workspace-tab-active" layoutId={`workspace-tab-${workspace.id}`} transition={reducedMotion ? { duration: 0 } : SPRING_SNAPPY} />}
            {tabSession ? <SessionDetailCard session={tabSession} provider={providers.find(provider => provider.id === tabSession.providerId)} side="bottom">{tabButton}</SessionDetailCard> : tabButton}
            <Tooltip label={t('app.closeNamedTab', { label })}><button className="tab-close" aria-label={t('app.closeNamedTab', { label })} title={tab.kind === 'terminal' ? t('app.closeTerminalTab') : t('app.closeTab')} onClick={() => requestCloseTab(workspace.id, tab, tabTerminal?.status === 'exited')}><X size={11} /></button></Tooltip>
          </div>;
        })}</div><div className="tab-add" ref={tabMenuContainer} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setTabMenu(false); }} onKeyDown={event => {
            if (!tabMenu) return;
            if (event.key === 'Escape') { event.preventDefault(); setTabMenu(false); tabMenuContainer.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus({ preventScroll: true }); return; }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const items = Array.from(tabMenuContainer.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)') ?? []);
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
            items[next]?.focus({ preventScroll: true });
          }}><IconButton label={t('app.addTab')} aria-haspopup="menu" aria-expanded={tabMenu} onClick={() => setTabMenu(value => !value)}><Plus size={17} /></IconButton><AnimatePresence>{tabMenu && <><button key="dismiss" className="menu-dismiss" tabIndex={-1} aria-label={t('app.dismissAddMenu')} onClick={() => setTabMenu(false)} /><motion.div key="menu" className="tab-menu" role="menu" aria-label={t('app.addTabMenu')} initial={reducedMotion ? false : "initial"} animate="animate" exit={reducedMotion ? undefined : "exit"} variants={motionPopover}><button role="menuitem" onClick={openAgentDialog}><MessageSquare size={15} />{t('app.newAgentSession')}</button><button role="menuitem" disabled={pending.has('create-terminal')} onClick={openLocalTerminal}><TerminalSquare size={15} />{t('app.openLocalTerminal')}</button><button role="menuitem" onClick={() => { setDialog('preview'); setTabMenu(false); }}><Globe size={15} />{t('app.addPreview')}</button></motion.div></>}</AnimatePresence></div></div>
          <WorkspacePanes workspace={workspace} active={activeTab} secondary={secondaryTab} renderTab={renderTab} perform={perform}
            draggedTabId={connected ? draggedTabId : undefined} onDropTab={split => {
              setDraggedTab(undefined);
              void perform('split', () => window.workbench.splitWorkspace(workspace.id, { ...split, expectedLayout: { activeTabId: draggedTab!.activeTabId, secondaryTabId: draggedTab!.secondaryTabId } }));
            }} />
        </div><WorkspaceFilePane id={filePane.id} visible={filePane.visible} width={filePane.width} limit={filePane.limit} onResize={filePane.rememberWidth}>
          <FileReviewPanel key={JSON.stringify([workspace.id, workspace.cwd])} workspace={workspace} onEditProject={connected ? () => projectManagement.open(workspace, 'edit') : undefined} refreshKey={refreshKey} perform={perform} sessions={sessions} onFeedback={activeSession ? text => { const draft = currentDrafts.current[activeSession.id] ?? activeSession.draft ?? { text: '' }; updateDraft(activeSession.id, { ...draft, text: [draft.text, text].filter(Boolean).join('\n\n') }); } : undefined} />
        </WorkspaceFilePane></div> : <FirstTask providers={providers} connected={connected} perform={perform} pending={pending} />)}
        {page === 'attention' && <SessionAttentionInbox sessions={sessions} workspaces={snapshot.workspaces} pending={pending}
          openSession={id => openSession(id, false, true)} />}
        {page === 'history' && (readingSession ? <section className="history-session-view">
          <header className="history-session-toolbar"><span>{t('history.readOnly')}</span><button className="header-button" onClick={() => setReadingSessionId(null)}><X size={13} />{t('history.closeSession')}</button></header>
          <SessionChat key={readingSession.id} session={readingSession} readOnly connected={connected} sessions={sessions}
            provider={providers.find(provider => provider.id === readingSession.providerId)} providers={providers} perform={perform} pending={pending}
            draft={{ text: '' }} onDraftChange={() => {}} openSession={id => openSession(id, true)}
            onChooseEvidence={connected ? setEvidenceTarget : undefined} onOpenEvidence={openEvidence}
            attentionOpen={attentionOpen?.sessionId === readingSession.id ? attentionOpen : undefined}
            onAttentionOpened={onAttentionOpened} messageOpen={messageOpen?.sessionId === readingSession.id ? messageOpen : undefined}
            onMessageOpened={onMessageOpened} onOpenForkSource={openForkSource} />
        </section> : <HistoryView sessions={sessions} providers={providers} openSession={openSession} perform={perform} />)}
        {page === 'collaboration' && <Suspense fallback={<div className="loading-view"><LoaderCircle className="spin" size={23} /><p>{t('app.loadingCollaboration')}</p></div>}><CollaborationViews snapshot={snapshot} perform={perform} pending={pending} openSession={openSession} initialCwd={workspace?.cwd} onChooseEvidence={connected ? setEvidenceTarget : undefined} artifactJump={artifactJump} openProviderSettings={() => openSettings('providers')} /></Suspense>}
        {page === 'workflows' && <div className="split-page"><aside className="item-sidebar"><div className="sidebar-heading"><h2>{t('app.workflows')}</h2><IconButton label={t('workflow.new')} onClick={() => setNewWorkflow(true)}><Plus size={17} /></IconButton></div><p className="sidebar-subtitle">{t('workflow.dependenciesNote')}</p><div className="item-list">{workflows.map(item => <button key={item.id} className={`list-item ${item.id === workflow?.id && !newWorkflow ? 'selected' : ''}`} onClick={() => { setWorkflowId(item.id); setNewWorkflow(false); }}><strong>{item.name}</strong><div><span>{t('workflow.stepCount', { count: item.steps.length })}</span><Status value={item.status} /></div></button>)}</div><button className="sidebar-action" onClick={() => setNewWorkflow(true)}><Plus size={14} />{t('workflow.new')}</button></aside>{newWorkflow ? <WorkflowEditor providers={providers} perform={perform} pending={pending} onClose={() => setNewWorkflow(false)} onCreated={id => { setWorkflowId(id); setNewWorkflow(false); }} /> : workflow ? <WorkflowView workflow={workflow} providers={providers} sessions={sessions} perform={perform} pending={pending} openSession={openSession} openWorkflow={id => { setWorkflowId(id); setNewWorkflow(false); }} /> : <EmptyState icon={<GitBranch size={28} />} title={t('workflow.empty')} action={<button className="button" onClick={() => setNewWorkflow(true)}><Plus size={14} />{t('workflow.new')}</button>}>{t('workflow.emptyNote')}</EmptyState>}</div>}
      </>}
    </main>
    {evidenceTarget && <EvidenceTargetDialog reference={evidenceTarget} sessions={sessions}
      onAdd={addEvidence} onClose={() => setEvidenceTarget(undefined)} />}
    {windowCapture && !evidenceTarget && !dialog && !terminalAction && !projectManagement.dialog &&
      <DraftTargetDialog key={windowCapture.id} title={t('app.captureWindowDraft')} sourceLabel={windowCapture.name}
        preview={<WindowCapturePreview attachment={windowCapture} />}
        sessions={sessions.filter(session => supportsPromptAttachment(providers.find(provider => provider.id === session.providerId), 'image'))}
        onAdd={id => addCapture(id, windowCapture)} onClose={() => setWindowCaptures(items => items.filter(item => item.id !== windowCapture.id))} />}
    {pending.has('capture-window') && !windowCapture && <Modal title={t('app.captureWindow')}
      subtitle={t('app.captureWindowPick')} onClose={() => void window.workbench.cancelWindowCapture()}>
      <div className="modal-actions"><button className="button subtle" onClick={() => void window.workbench.cancelWindowCapture()}>
        {t('common.cancel')}
      </button></div>
    </Modal>}
    {dialog === 'settings' && <SettingsDialog snapshot={snapshot} workspace={workspace} sessions={sessions} session={activeSession}
      perform={perform} pending={pending} updates={applicationUpdates} initialSection={settingsSection} initialTarget={settingsTarget} openSession={openSession} onClose={() => setDialog(null)} />}
    {projectManagement.dialog}
    {dialog === 'workspace' && <NewWorkspaceDialog perform={perform} pending={pending} onClose={() => setDialog(null)} onCreated={id => { setDialog(null); selectWorkspace(id); }} />}
    {dialog === 'agent' && workspace && <NewAgentDialog key={workspace.id} workspace={workspace} providers={providers}
      running={sessions.filter(session => session.cwd === workspace.cwd && projectWorkStatuses.includes(session.status)).length}
      onClose={() => setDialog(null)} onCreated={id => { setDialog(null); setCreatedSessionId(id); }} />}
    {dialog === 'preview' && workspace && <PreviewDialog workspace={workspace} pending={pending} perform={perform} onClose={() => setDialog(null)} />}
    {dialog === 'codex' && <CodexDialog initialCwd={workspace?.cwd ?? ''} pending={pending} perform={perform} onClose={() => setDialog(null)} />}
    {terminalAction && terminalActionKey && <Modal title={t('app.stopTerminalTitle')} subtitle={t('app.stopTerminalNote')}
      busy={pending.has(terminalActionKey)} onClose={() => setTerminalAction(undefined)}>
      <div className="modal-actions">
        {terminalAction.kind === 'close' ? <button className="button subtle" disabled={pending.has(terminalActionKey)} onClick={() => {
          setTerminalHidden(terminalAction.terminalId, true);
          setTerminalAction(undefined);
        }}>{t('app.hideTerminal')}</button> : <button className="button subtle" disabled={pending.has(terminalActionKey)} onClick={() => setTerminalAction(undefined)}>{t('common.cancel')}</button>}
        <button className="button danger" disabled={pending.has(terminalActionKey)} onClick={() => void perform(terminalActionKey, async () => {
          if (terminalAction.kind === 'close') {
            await window.workbench.closeTab(terminalAction.workspaceId, terminalAction.tabId, true);
            setTerminalHidden(terminalAction.terminalId, false);
          } else await window.workbench.stopTerminal(terminalAction.terminalId);
          setTerminalAction(current => current === terminalAction ? undefined : current);
        })}>{t(terminalAction.kind === 'close' ? 'app.stopAndCloseTerminal' : 'app.stopTerminal')}</button>
      </div>
    </Modal>}
    {toast && <ErrorToast message={toast} onDismiss={() => setToast('')} />}
  </div></WorkspaceFileNavigation.Provider>;
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
    <label>{t('app.workspaceMode')}<AppSelect label={t('app.workspaceMode')} value={mode} disabled={busy} onChange={value => setMode(value as typeof mode)}
      options={[{ value: 'directory', label: t('app.currentDirectory') }, { value: 'worktree', label: t('app.independentWorktree') }]} /></label>
    {mode === 'worktree' && <><p className="form-note">{t('app.worktreeNote')}</p><label>{t('app.worktreeBranch')}<span className="optional">{t('common.optional')}</span><input value={branch} onChange={event => setBranch(event.target.value)} disabled={busy} placeholder={t('app.worktreeBranchDefault')} /></label></>}
    <label>{t('app.workspaceName')}<span className="optional">{t('common.optional')}</span><input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder={cwd ? pathName(cwd) : t('app.directoryNameDefault')} maxLength={200} /></label>
    <div className="modal-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>{t('common.cancel')}</button><button className="button primary" disabled={!cwd.trim() || busy}><BusyIcon busy={busy}><Plus size={14} /></BusyIcon>{t('app.createWorkspace')}</button></div></form></Modal>;
}

function PreviewDialog({ workspace, pending, perform, onClose }: { workspace: Workspace; pending: Set<string>; perform: Perform; onClose: () => void }) {
  const { t } = useTranslation('shell');
  const [url, setUrl] = useState('');
  const busy = pending.has('create-preview');
  return <Modal title={t('app.addPreview')} subtitle={t('app.previewNote')} busy={busy} onClose={onClose}><form onSubmit={event => { event.preventDefault(); if (!localPreviewUrl(url.trim()) || busy) return; void perform('create-preview', async () => { await window.workbench.createPreview(workspace.id, url.trim()); onClose(); }); }}><label>{t('app.localUrl')}<input autoFocus type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="http://localhost:3000" required /></label>{url && !localPreviewUrl(url.trim()) && <p className="field-error">{t('app.localUrlOnly')}</p>}<div className="modal-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>{t('common.cancel')}</button><button className="button primary" disabled={busy || !localPreviewUrl(url.trim())}><BusyIcon busy={busy}><Globe size={14} /></BusyIcon>{t('app.openPreview')}</button></div></form></Modal>;
}

function CodexDialog({ initialCwd, pending, perform, onClose }: { initialCwd: string; pending: Set<string>; perform: Perform; onClose: () => void }) {
  const { t } = useTranslation('shell');
  const [cwd, setCwd] = useState(initialCwd);
  const [prompt, setPrompt] = useState('');
  const busy = pending.has('launch-codex');
  return <Modal title={t('app.codexNew')} subtitle={t('app.codexNewNote')} busy={busy} onClose={onClose}><form onSubmit={event => { event.preventDefault(); if (!cwd.trim() || busy) return; void perform('launch-codex', async () => { await window.workbench.launchCodex({ cwd: cwd.trim(), prompt }); onClose(); }); }}><label>{t('common.projectDirectory')}<DirectoryField value={cwd} onChange={setCwd} perform={perform} /></label><label>{t('app.prefilledTask')}<span className="optional">{t('common.optional')}</span><textarea value={prompt} onChange={event => setPrompt(event.target.value)} rows={4} placeholder={t('app.codexPrompt')} /></label><div className="form-note"><ArrowUpRight size={14} /><span>{t('app.codexHandoffNote')}</span></div><div className="modal-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>{t('common.cancel')}</button><button className="button primary" disabled={!cwd.trim() || busy}><BusyIcon busy={busy}><ArrowUpRight size={14} /></BusyIcon>{t('app.openCodex')}</button></div></form></Modal>;
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
