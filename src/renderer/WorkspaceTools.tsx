import { useTranslation } from 'react-i18next';
import { formatDate, formatNumber } from '../shared/i18n';
import { useEffect, useRef, useState } from 'react';
import { Activity, BellRing, FileText, GitBranch, ListChecks, Plug, Plus, Puzzle, RefreshCw, Wallet } from 'lucide-react';
import type { McpSettingsView, NotificationStatus, Session, SkillInfo, Workspace } from '../shared/types';
import { Modal, type Perform } from './ui';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { ManagedWorktreePanel } from './ManagedWorktreePanel';

interface SkillDraft { token: object; id?: string; name: string; content: string; revision?: string; editable: boolean }
type ToolTab = 'skills' | 'mcp' | 'usage' | 'diagnostics' | 'worktree';

export function WorkspaceTools({ workspace, sessions, perform, onClose }: { workspace: Workspace; sessions: Session[]; perform: Perform; onClose: () => void }) {
  const { t } = useTranslation('workspace');
  const { t: runtimeText } = useTranslation('runtime');
  const [tab, setTab] = useState<ToolTab>('skills');
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [mcp, setMcp] = useState<McpSettingsView>();
  const [mcpDraft, setMcpDraft] = useState({ content: '' });
  const [skill, setSkill] = useState<SkillDraft>();
  const [savingSkill, setSavingSkill] = useState(false);
  const [savingMcp, setSavingMcp] = useState(false);
  const currentSkill = useRef(skill);
  const currentMcp = useRef(mcpDraft);
  const skillReadGeneration = useRef(0);
  const [connections, setConnections] = useState<Record<string, { status: 'connected'; count: number } | { status: 'failed'; error?: string }>>({});
  const [balance, setBalance] = useState<Awaited<ReturnType<Window['workbench']['deepSeekBalance']>>>();
  const [notification, setNotification] = useState<NotificationStatus>();
  const editSkill = (next: SkillDraft | undefined) => { currentSkill.current = next; setSkill(next); };
  const editMcp = (next: { content: string }) => { currentMcp.current = next; setMcpDraft(next); };
  const readSkill = async (item: SkillInfo) => {
    const generation = ++skillReadGeneration.current;
    const read = await window.workbench.readSkill(workspace.id, item.id);
    if (generation === skillReadGeneration.current) editSkill({ token: {}, id: item.id, name: item.path.split('/').at(-2) ?? item.name, ...read, editable: item.editable });
  };
  const saveSkill = async () => {
    const submitted = currentSkill.current;
    if (!submitted || savingSkill) return;
    setSavingSkill(true);
    try {
      await window.workbench.saveSkill(workspace.id, { name: submitted.name, content: submitted.content, revision: submitted.revision });
      const nextSkills = await window.workbench.listSkills(workspace.id);
      setSkills(nextSkills);
      const saved = nextSkills.find(item => item.editable && item.path.split('/').at(-2) === submitted.name);
      if (!saved) return;
      const written = await window.workbench.readSkill(workspace.id, saved.id);
      const latest = currentSkill.current;
      if (latest?.token === submitted.token && latest.name === submitted.name) {
        editSkill({ ...latest, id: saved.id, revision: written.revision, content: latest === submitted ? written.content : latest.content });
      }
    } finally { setSavingSkill(false); }
  };
  const saveMcp = async () => {
    if (!mcp || savingMcp) return;
    const submitted = currentMcp.current;
    setSavingMcp(true);
    try {
      await window.workbench.saveMcpSettings(workspace.id, { content: submitted.content, revision: mcp.revision });
      const next = await window.workbench.mcpSettings(workspace.id);
      setMcp(next);
      if (currentMcp.current === submitted) editMcp({ content: next.content });
    } finally { setSavingMcp(false); }
  };
  useEffect(() => {
    let cancelled = false;
    const initial = currentMcp.current;
    void perform('tools-load', async () => {
      const [nextSkills, nextMcp, status] = await Promise.all([window.workbench.listSkills(workspace.id), window.workbench.mcpSettings(workspace.id), window.workbench.notificationStatus()]);
      if (cancelled) return;
      setSkills(nextSkills); setMcp(nextMcp); setNotification(status);
      if (currentMcp.current === initial) editMcp({ content: nextMcp.content });
    });
    return () => { cancelled = true; skillReadGeneration.current++; };
  }, [workspace.id]);
  const usage = sessions.filter(session => session.cwd === workspace.cwd).flatMap(session => (session.usage ?? []).map(record => ({ ...record, title: session.title })));
  const tabs: ToolTab[] = ['skills', 'mcp', 'usage', 'diagnostics', ...(workspace.worktree ? ['worktree' as const] : [])];

  return <Modal title={t('tools.title')} subtitle={workspace.name} onClose={onClose}>
    <div className="workspace-tools">
      <div className="tools-tabs" role="group" aria-label={t('tools.categories')} data-tab={tab}>
        {tabs.map(value => <button className={tab === value ? 'selected' : ''} aria-pressed={tab === value} key={value} onClick={() => {
          setTab(value);
          if (value === 'usage') void perform('notification-status', async () => setNotification(await window.workbench.notificationStatus()));
        }}>{value === 'skills' ? <Puzzle size={15} /> : value === 'mcp' ? <Plug size={15} /> : value === 'usage' ? <Activity size={15} /> : value === 'diagnostics' ? <ListChecks size={15} /> : <GitBranch size={15} />}{value === 'skills' ? 'Skills' : value === 'mcp' ? 'MCP' : value === 'usage' ? t('tools.usageTab') : runtimeText(value === 'diagnostics' ? 'diagnostics.tab' : 'worktree.tab')}</button>)}
      </div>
      <div className="tools-content">
        {tab === 'diagnostics' && <DiagnosticsPanel sessions={sessions} />}
        {tab === 'worktree' && <ManagedWorktreePanel workspace={workspace} onRemoved={onClose} />}
        {tab === 'skills' && <>
          <div className="tools-actions"><span>{t('tools.skillSources')}</span><button className="button small" onClick={() => { skillReadGeneration.current++; editSkill({ token: {}, name: '', content: '---\nname: \ndescription: \n---\n\n', editable: true }); }}><Plus size={13} />{t('tools.newSkill')}</button></div>
          <div className="tools-list">
            {skills.map(item => <button className={`tools-list-item ${skill?.id === item.id ? 'selected' : ''}`} key={item.id} onClick={() => void perform('read-skill', () => readSkill(item))}>
              <span className="tool-list-icon"><Puzzle size={17} /></span>
              <span className="tool-list-copy"><strong>{item.name}</strong><small>{item.description || item.issue}</small></span>
              <span className="tool-scope">{item.scope === 'project' ? t('tools.projectScope') : t('tools.userScope')}</span>
            </button>)}
          </div>
          {skill && <section className="tools-editor">
            <div className="tools-editor-heading"><FileText size={15} /><strong>{skill.id ? t('tools.skillContent') : t('tools.newSkill')}</strong>{!skill.editable && <span className="tool-scope">{t('common.readOnly')}</span>}</div>
            <label>{t('tools.directoryName')}<input value={skill.name} disabled={!!skill.id} onChange={event => editSkill({ ...currentSkill.current!, name: event.target.value })} /></label>
            <textarea aria-label={t('tools.skillContent')} rows={10} readOnly={!skill.editable} value={skill.content} onChange={event => editSkill({ ...currentSkill.current!, content: event.target.value })} />
            <div className="tools-actions"><span>{skill.editable ? t('tools.skillDestination') : t('tools.userSkillReadOnly')}</span>{skill.editable && <button className="button primary small" disabled={!skill.name.trim() || savingSkill} onClick={() => void perform('save-skill', saveSkill)}>{t('tools.saveSkill')}</button>}</div>
          </section>}
        </>}
        {tab === 'mcp' && <>
          <p className="pane-note">{t('tools.mcpDescription')}</p>
          <div className="tools-config-surface"><div className="tools-editor-heading"><FileText size={15} /><strong>{t('tools.mcpConfig')}</strong></div><textarea aria-label={t('tools.mcpConfig')} className="config-editor" rows={10} value={mcpDraft.content} onChange={event => editMcp({ content: event.target.value })} /></div>
          <div className="tools-actions"><span>{t('tools.collaborationService')}</span><button className="button primary small" disabled={!mcp || savingMcp} onClick={() => void perform('save-mcp', saveMcp)}>{t('tools.saveConfig')}</button></div>
          <div className="tools-list">{mcp?.servers.map((server, index) => {
            const connection = connections[server.name];
            return <div className="tools-item" key={`${server.source}-${server.name}-${index}`}>
            <div className="tools-item-heading"><span className="tool-list-icon"><Plug size={17} /></span><div className="tool-list-copy"><strong>{server.name}</strong><small>{server.source} · {server.transport} · {t(`tools.serverStatus.${server.status}`, { defaultValue: server.status })}{server.issue && ` · ${server.issue}`}</small></div>
              {server.status === 'enabled' && <button className="button small" onClick={() => void perform(`mcp-${server.name}`, async () => {
                const result = await window.workbench.testMcpServer(workspace.id, server.name);
                setConnections(current => ({ ...current, [server.name]: result.status === 'connected' ? { status: 'connected', count: result.tools.length } : { status: 'failed', error: result.error } }));
              })}>{t('tools.testConnection')}</button>}
            </div>
            {connection && <p className="tools-connection-result" role="status">{connection.status === 'connected' ? t('tools.connected', { count: connection.count }) : connection.error ?? t('tools.connectionFailed')}</p>}
          </div>; })}</div>
        </>}
        {tab === 'usage' && <>
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
      </div>
    </div>
  </Modal>;
}
