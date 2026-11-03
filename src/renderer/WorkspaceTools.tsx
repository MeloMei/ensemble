import { useTranslation } from 'react-i18next';
import { formatDate, formatNumber } from '../shared/i18n';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Activity, BellRing, Check, CircleAlert, FileText, GitBranch, ListChecks, LoaderCircle, Plug, Plus, Puzzle, RefreshCw, Wallet } from 'lucide-react';
import { motion, useAnimationControls, useReducedMotion } from 'framer-motion';
import type { NotificationStatus, Session, SkillInfo, Workspace } from '../shared/types';
import { Modal, type Perform } from './ui';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { ManagedWorktreePanel } from './ManagedWorktreePanel';
import { hasMcpEdits, hasSkillEdits, workspaceToolDrafts, type SkillDraft } from './workspace-tool-drafts';
import { SPRING_SNAPPY } from './vendor/open-claude-ui/ClaudeMotionPresets';

const emptySkill = '---\nname: \ndescription: \n---\n\n';
type ToolTab = 'skills' | 'mcp' | 'usage' | 'diagnostics' | 'worktree';
type FeedbackState = 'pending' | 'saved' | 'failed';
type Connection = { status: 'pending' } | { status: 'connected'; count: number } | { status: 'failed'; error?: string };

function OperationFeedback({ state, label }: { state: FeedbackState; label: string }) {
  const Icon = state === 'pending' ? LoaderCircle : state === 'saved' ? Check : CircleAlert;
  return <span className="tools-operation-feedback" data-state={state} key={state} role="status"><Icon size={13} aria-hidden="true" />{label}</span>;
}

interface WorkspaceToolsPanelProps {
  workspace: Workspace;
  sessions: Session[];
  perform: Perform;
  onBusyChange?: (busy: boolean) => void;
  onRemoved?: () => void;
}

export interface WorkspaceToolsHandle {
  requestClose: (action: () => void) => void;
}

export const WorkspaceToolsPanel = forwardRef<WorkspaceToolsHandle, WorkspaceToolsPanelProps>(function WorkspaceToolsPanel(props, ref) {
  return <WorkspaceToolsContent key={props.workspace.id} {...props} ref={ref} />;
});

const WorkspaceToolsContent = forwardRef<WorkspaceToolsHandle, WorkspaceToolsPanelProps>(function WorkspaceToolsContent({ workspace, sessions, perform, onBusyChange, onRemoved }, ref) {
  const { t } = useTranslation('workspace');
  const { t: runtimeText } = useTranslation('runtime');
  const [tab, setTab] = useState<ToolTab>('skills');
  const [visitedTabs, setVisitedTabs] = useState<Set<ToolTab>>(() => new Set(['skills']));
  const toolPanels = useRef<Partial<Record<ToolTab, HTMLDivElement>>>({});
  const scrollTops = useRef<Partial<Record<ToolTab, number>>>({});
  const restoringScroll = useRef<ToolTab | undefined>(undefined);
  const drafts = useSyncExternalStore(useCallback((listener: () => void) => workspaceToolDrafts.subscribe(workspace, listener), [workspace.id]), () => workspaceToolDrafts.get(workspace));
  const { skill, mcp, mcpDraft, savingSkill, savingMcp, skills, servers } = drafts;
  const [discardAction, setDiscardAction] = useState<() => void>();
  const skillReadGeneration = useRef(0);
  const [connections, setConnections] = useState<Record<string, Connection>>({});
  const pendingConnections = useRef(new Set<string>());
  const [skillFeedback, setSkillFeedback] = useState<{ status: 'saved' | 'failed'; token: object }>();
  const [mcpFeedback, setMcpFeedback] = useState<{ status: 'saved' | 'failed'; content: string }>();
  const skillReveal = useAnimationControls();
  const reducedMotion = useReducedMotion();
  const [balance, setBalance] = useState<Awaited<ReturnType<Window['workbench']['deepSeekBalance']>>>();
  const [notification, setNotification] = useState<NotificationStatus>();
  const editSkill = (next: SkillDraft | undefined) => {
    setSkillFeedback(undefined);
    workspaceToolDrafts.update(workspace, current => ({ ...current, skill: next }));
  };
  const editMcp = (next: { content: string }) => {
    setMcpFeedback(undefined);
    workspaceToolDrafts.update(workspace, current => ({ ...current, mcpDraft: next }));
  };
  const skillDirty = hasSkillEdits(skill);
  const guardDiscard = (action: () => void, dirty: boolean) => { if (dirty) setDiscardAction(current => current ?? action); else action(); };
  const busy = Boolean(savingSkill) || savingMcp;
  useLayoutEffect(() => {
    const panel = toolPanels.current[tab];
    if (!panel) return;
    const top = scrollTops.current[tab] ?? 0;
    restoringScroll.current = tab;
    const observer = new ResizeObserver(() => restore());
    const restore = () => {
      if (restoringScroll.current !== tab) return;
      panel.scrollTop = top;
      if (panel.scrollTop === top) {
        restoringScroll.current = undefined;
        observer.disconnect();
      }
    };
    if (panel.firstElementChild) observer.observe(panel.firstElementChild);
    restore();
    return () => { observer.disconnect(); restoringScroll.current = undefined; };
  }, [tab]);
  const cancelScrollRestore = () => {
    restoringScroll.current = undefined;
    scrollTops.current[tab] = toolPanels.current[tab]?.scrollTop ?? 0;
  };
  useEffect(() => {
    if (!skill) return;
    if (reducedMotion) skillReveal.set({ opacity: 1, y: 0 });
    else void skillReveal.start({ opacity: [0, 1], y: [3, 0], transition: SPRING_SNAPPY });
  }, [skill?.token, reducedMotion, skillReveal]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useImperativeHandle(ref, () => ({
    requestClose: action => {
      const current = workspaceToolDrafts.get(workspace);
      if (current.savingSkill || current.savingMcp) return;
      guardDiscard(() => { if (workspaceToolDrafts.discard(workspace)) action(); }, hasSkillEdits(current.skill) || hasMcpEdits(current));
    },
  }));
  const readSkill = async (item: SkillInfo) => {
    const generation = ++skillReadGeneration.current;
    const previous = workspaceToolDrafts.get(workspace).skill;
    const read = await window.workbench.readSkill(workspace.id, item.id);
    const name = item.path.split('/').at(-2) ?? item.name;
    if (generation !== skillReadGeneration.current) return;
    guardDiscard(() => {
      if (generation === skillReadGeneration.current) editSkill({ token: {}, id: item.id, name, ...read, editable: item.editable, saved: { name, content: read.content } });
    }, workspaceToolDrafts.get(workspace).skill !== previous && hasSkillEdits(workspaceToolDrafts.get(workspace).skill));
  };
  const saveSkill = async () => {
    const current = workspaceToolDrafts.get(workspace);
    const submitted = current.skill;
    if (!submitted || current.savingSkill) return;
    setSkillFeedback(undefined);
    workspaceToolDrafts.update(workspace, value => ({ ...value, savingSkill: submitted }));
    try {
      await window.workbench.saveSkill(workspace.id, { name: submitted.name, content: submitted.content, revision: submitted.revision });
      const nextSkills = await window.workbench.listSkills(workspace.id);
      workspaceToolDrafts.update(workspace, value => ({ ...value, skills: nextSkills }));
      const saved = nextSkills.find(item => item.editable && item.path.split('/').at(-2) === submitted.name);
      if (!saved) {
        setSkillFeedback({ status: 'failed', token: submitted.token });
        return;
      }
      const written = await window.workbench.readSkill(workspace.id, saved.id);
      const latest = workspaceToolDrafts.get(workspace).skill;
      if (latest?.token === submitted.token && latest.name === submitted.name) {
        editSkill({ ...latest, id: saved.id, revision: written.revision, saved: { name: submitted.name, content: written.content }, content: latest === submitted ? written.content : latest.content });
      }
      setSkillFeedback({ status: 'saved', token: submitted.token });
    } catch (error) {
      setSkillFeedback({ status: 'failed', token: submitted.token });
      throw error;
    } finally { workspaceToolDrafts.update(workspace, value => ({ ...value, savingSkill: undefined })); }
  };
  const saveMcp = async () => {
    const current = workspaceToolDrafts.get(workspace);
    if (!current.mcp || current.savingMcp) return;
    const submitted = current.mcpDraft;
    setMcpFeedback(undefined);
    workspaceToolDrafts.update(workspace, value => ({ ...value, savingMcp: true }));
    try {
      await window.workbench.saveMcpSettings(workspace.id, { content: submitted.content, revision: current.mcp.revision });
      const next = await window.workbench.mcpSettings(workspace.id);
      workspaceToolDrafts.update(workspace, value => ({ ...value, servers: next.servers, mcp: { content: next.content, revision: next.revision }, mcpDraft: value.mcpDraft === submitted ? { content: next.content } : value.mcpDraft }));
      setMcpFeedback({ status: 'saved', content: next.content });
    } catch (error) {
      setMcpFeedback({ status: 'failed', content: submitted.content });
      throw error;
    } finally { workspaceToolDrafts.update(workspace, value => ({ ...value, savingMcp: false })); }
  };
  const testConnection = async (name: string) => {
    if (pendingConnections.current.has(name)) return;
    pendingConnections.current.add(name);
    setConnections(current => ({ ...current, [name]: { status: 'pending' } }));
    try {
      const result = await window.workbench.testMcpServer(workspace.id, name);
      setConnections(current => ({ ...current, [name]: result.status === 'connected' ? { status: 'connected', count: result.tools.length } : { status: 'failed', error: result.error } }));
    } catch (error) {
      setConnections(current => ({ ...current, [name]: { status: 'failed', error: error instanceof Error ? error.message : String(error) } }));
      throw error;
    } finally { pendingConnections.current.delete(name); }
  };
  useEffect(() => {
    let cancelled = false;
    const initialDrafts = workspaceToolDrafts.get(workspace);
    const initial = initialDrafts.mcpDraft;
    void perform('tools-load', async () => {
      const [nextSkills, nextMcp, status] = await Promise.all([window.workbench.listSkills(workspace.id), window.workbench.mcpSettings(workspace.id), window.workbench.notificationStatus()]);
      if (cancelled) return;
      setNotification(status);
      workspaceToolDrafts.update(workspace, current => ({
        ...current,
        skills: current.skills === initialDrafts.skills ? nextSkills : current.skills,
        ...(current.mcp === initialDrafts.mcp && !current.savingMcp ? {
          servers: nextMcp.servers,
          ...(!current.mcp || !hasMcpEdits(current) ? {
            mcp: { content: nextMcp.content, revision: nextMcp.revision },
            mcpDraft: current.mcpDraft === initial && !hasMcpEdits(initialDrafts) ? { content: nextMcp.content } : current.mcpDraft,
          } : {}),
        } : {}),
      }));
    });
    return () => { cancelled = true; skillReadGeneration.current++; };
  }, [workspace.id]);
  const usage = sessions.filter(session => session.cwd === workspace.cwd).flatMap(session => (session.usage ?? []).map(record => ({ ...record, title: session.title })));
  const tabs: ToolTab[] = ['skills', 'mcp', 'usage', 'diagnostics', ...(workspace.worktree ? ['worktree' as const] : [])];
  const currentSkillFeedback = skillFeedback?.token === skill?.token && (skillFeedback?.status === 'failed' || !skillDirty) ? skillFeedback?.status : undefined;
  const currentMcpFeedback = mcpFeedback?.status === 'failed' || (mcpFeedback?.content === mcpDraft.content && !hasMcpEdits(drafts)) ? mcpFeedback?.status : undefined;
  const skillFeedbackState = savingSkill && savingSkill.token === skill?.token ? 'pending' : currentSkillFeedback;
  const mcpFeedbackState = savingMcp ? 'pending' : currentMcpFeedback;
  const feedbackLabel = (state: FeedbackState) => t(state === 'pending' ? 'tools.saving' : state === 'saved' ? 'tools.saved' : 'tools.saveFailed');

  return <><div className="workspace-tools">
      <div className="tools-tabs" role="group" aria-label={t('tools.categories')} data-tab={tab}>
        {tabs.map(value => <button className={tab === value ? 'selected' : ''} aria-pressed={tab === value} key={value} onClick={() => {
          if (restoringScroll.current !== tab) scrollTops.current[tab] = toolPanels.current[tab]?.scrollTop ?? 0;
          setTab(value);
          setVisitedTabs(current => current.has(value) ? current : new Set([...current, value]));
          if (value === 'usage') void perform('notification-status', async () => setNotification(await window.workbench.notificationStatus()));
        }}>{value === 'skills' ? <Puzzle size={15} /> : value === 'mcp' ? <Plug size={15} /> : value === 'usage' ? <Activity size={15} /> : value === 'diagnostics' ? <ListChecks size={15} /> : <GitBranch size={15} />}{value === 'skills' ? 'Skills' : value === 'mcp' ? 'MCP' : value === 'usage' ? t('tools.usageTab') : runtimeText(value === 'diagnostics' ? 'diagnostics.tab' : 'worktree.tab')}</button>)}
      </div>
      {tabs.filter(value => value === 'skills' || (value === 'mcp' ? visitedTabs.has(value) : tab === value)).map(value => <div className="tools-content" data-tool-panel={value} key={value} ref={element => { if (element) toolPanels.current[value] = element; else delete toolPanels.current[value]; }} onScroll={event => { if (tab === value && restoringScroll.current !== value) scrollTops.current[value] = event.currentTarget.scrollTop; }} onWheel={cancelScrollRestore} onPointerDown={cancelScrollRestore} onKeyDown={cancelScrollRestore} hidden={tab !== value} inert={tab !== value}><div className="tools-panel-body">
        {value === 'diagnostics' && <DiagnosticsPanel sessions={sessions} />}
        {value === 'worktree' && <ManagedWorktreePanel workspace={workspace} onRemoved={() => onRemoved?.()} />}
        {value === 'skills' && <>
          <div className="tools-actions"><span>{t('tools.skillSources')}</span><button className="button small" onClick={() => guardDiscard(() => { skillReadGeneration.current++; editSkill({ token: {}, name: '', content: emptySkill, editable: true, saved: { name: '', content: emptySkill } }); }, skillDirty)}><Plus size={13} />{t('tools.newSkill')}</button></div>
          <div className="tools-list">
            {skills.map(item => <button className={`tools-list-item ${skill?.id === item.id ? 'selected' : ''}`} key={item.id} onClick={() => guardDiscard(() => { void perform('read-skill', () => readSkill(item)); }, skillDirty)}>
              <span className="tool-list-icon"><Puzzle size={17} /></span>
              <span className="tool-list-copy"><strong>{item.name}</strong><small>{item.description || item.issue}</small></span>
              <span className="tool-scope">{item.scope === 'project' ? t('tools.projectScope') : t('tools.userScope')}</span>
            </button>)}
          </div>
          {skill && <motion.section className="tools-editor" initial={false} animate={skillReveal}>
            <div className="tools-editor-heading"><FileText size={15} /><strong>{skill.id ? t('tools.skillContent') : t('tools.newSkill')}</strong>{!skill.editable && <span className="tool-scope">{t('common.readOnly')}</span>}</div>
            <label>{t('tools.directoryName')}<input value={skill.name} maxLength={100} disabled={!!skill.id} onChange={event => editSkill({ ...workspaceToolDrafts.get(workspace).skill!, name: event.target.value })} /></label>
            <textarea aria-label={t('tools.skillContent')} rows={10} maxLength={64_000} readOnly={!skill.editable} value={skill.content} onChange={event => editSkill({ ...workspaceToolDrafts.get(workspace).skill!, content: event.target.value })} />
            <div className="tools-actions"><span>{skill.editable ? t('tools.skillDestination') : t('tools.userSkillReadOnly')}</span>{skill.editable && <div className="tools-action-status">{skillFeedbackState && <OperationFeedback state={skillFeedbackState} label={feedbackLabel(skillFeedbackState)} />}<button className="button primary small" aria-busy={Boolean(savingSkill)} disabled={!skill.name.trim() || Boolean(savingSkill)} onClick={() => void perform('save-skill', saveSkill)}>{t('tools.saveSkill')}</button></div>}</div>
          </motion.section>}
        </>}
        {value === 'mcp' && <>
          <p className="pane-note">{t('tools.mcpDescription')}</p>
          <div className="tools-config-surface"><div className="tools-editor-heading"><FileText size={15} /><strong>{t('tools.mcpConfig')}</strong></div><textarea aria-label={t('tools.mcpConfig')} className="config-editor" rows={10} maxLength={256_000} value={mcpDraft.content} onChange={event => editMcp({ content: event.target.value })} /></div>
          <div className="tools-actions"><span>{t('tools.collaborationService')}</span><div className="tools-action-status">{mcpFeedbackState && <OperationFeedback state={mcpFeedbackState} label={feedbackLabel(mcpFeedbackState)} />}<button className="button primary small" aria-busy={savingMcp} disabled={!mcp || savingMcp} onClick={() => void perform('save-mcp', saveMcp)}>{t('tools.saveConfig')}</button></div></div>
          <div className="tools-list">{servers.map((server, index) => {
            const connection = connections[server.name];
            return <div className="tools-item" key={`${server.source}-${server.name}-${index}`}>
            <div className="tools-item-heading"><span className="tool-list-icon"><Plug size={17} /></span><div className="tool-list-copy"><strong>{server.name}</strong><small>{server.source} · {server.transport} · {t(`tools.serverStatus.${server.status}`, { defaultValue: server.status })}{server.issue && ` · ${server.issue}`}</small></div>
              {server.status === 'enabled' && <button className="button small" disabled={connection?.status === 'pending'} aria-busy={connection?.status === 'pending'} onClick={() => void perform(`mcp-${server.name}`, () => testConnection(server.name))}>{t('tools.testConnection')}</button>}
            </div>
            {connection && <div className="tools-connection-result"><OperationFeedback state={connection.status === 'pending' ? 'pending' : connection.status === 'connected' ? 'saved' : 'failed'} label={connection.status === 'pending' ? t('tools.testingConnection') : connection.status === 'connected' ? t('tools.connected', { count: connection.count }) : connection.error ?? t('tools.connectionFailed')} /></div>}
          </div>; })}</div>
        </>}
        {value === 'usage' && <>
          <div className="tools-balance-card">
            <div className="tools-actions"><span className="tools-section-title"><Wallet size={16} />{t('tools.deepSeekBalance')}</span><button className="button small" onClick={() => void perform('balance', async () => setBalance(await window.workbench.deepSeekBalance()))}>{t('tools.checkBalance')}</button></div>
            {balance && <div className="balance-value">{balance.balances.map(value => <div key={value.currency}>{value.currency} {value.total}</div>)}<small>{formatDate(balance.checkedAt)}</small></div>}
            <p className="pane-note">{t('tools.balanceDescription')}</p>
          </div>
          <div className="usage-table">{usage.length ? usage.map(record => <div key={`${record.title}-${record.id}`}>
            <strong>{record.title}</strong><small>{record.source} · {record.scope === 'context' ? t('usage.context') : record.scope === 'cumulative' ? t('usage.cumulative') : t('usage.turn')}</small>
            <span>{record.scope === 'context' ? `${record.contextUsed ?? '—'} / ${record.contextSize ?? '—'}` : t('usage.tokens', { input: record.inputTokens === undefined ? '—' : formatNumber(record.inputTokens), output: record.outputTokens === undefined ? '—' : formatNumber(record.outputTokens), cached: record.cachedTokens === undefined ? '—' : formatNumber(record.cachedTokens) })}{record.cost !== undefined && ` · ${record.currency ?? ''} ${record.cost}`}</span>
          </div>) : <p className="pane-note">{t('tools.noUsage')}</p>}</div>
          <section className="tools-notification-card"><div className="tools-actions"><span className="tools-section-title"><BellRing size={15} />{t('tools.notifications')}</span><button className="button small" onClick={() => void perform('notification-status', async () => setNotification(await window.workbench.notificationStatus()))}><RefreshCw size={12} />{t('tools.refreshStatus')}</button></div>
            <p className="pane-note">{!notification?.supported ? t('tools.notificationsUnsupported') : notification.state === 'failed' ? t('tools.notificationFailed', { error: notification.error ?? '' }) : notification.state === 'shown' ? t('tools.notificationShown') : notification.state === 'requested' ? t('tools.notificationRequested') : t('tools.notificationWaiting')}</p>
          </section>
        </>}
      </div></div>)}
    </div>
  {discardAction && <Modal title={t('tools.unsavedTitle')} subtitle={t('tools.unsavedDescription')} onClose={() => setDiscardAction(undefined)}>
    <div className="modal-actions"><button className="button" autoFocus onClick={() => setDiscardAction(undefined)}>{t('tools.keepEditing')}</button><button className="button danger" onClick={() => { setDiscardAction(undefined); discardAction(); }}>{t('tools.discardChanges')}</button></div>
  </Modal>}</>;
});
