import { useTranslation } from 'react-i18next';
import { formatDate, formatNumber } from '../shared/i18n';
import { useEffect, useState } from 'react';
import { Activity, BellRing, FileText, Plug, Plus, Puzzle, RefreshCw, Wallet } from 'lucide-react';
import type { McpSettingsView, NotificationStatus, Session, SkillInfo, Workspace } from '../shared/types';
import { Modal, type Perform } from './ui';

export function WorkspaceTools({ workspace, sessions, perform, onClose }: { workspace: Workspace; sessions: Session[]; perform: Perform; onClose: () => void }) {
  const { t } = useTranslation('workspace');
  const [tab, setTab] = useState<'skills' | 'mcp' | 'usage'>('skills');
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [mcp, setMcp] = useState<McpSettingsView>();
  const [mcpText, setMcpText] = useState('');
  const [skill, setSkill] = useState<{ id?: string; name: string; content: string; revision?: string; editable: boolean }>();
  const [connections, setConnections] = useState<Record<string, { status: 'connected'; count: number } | { status: 'failed'; error?: string }>>({});
  const [balance, setBalance] = useState<Awaited<ReturnType<Window['workbench']['deepSeekBalance']>>>();
  const [notification, setNotification] = useState<NotificationStatus>();
  const refresh = async () => {
    const [nextSkills, nextMcp, status] = await Promise.all([window.workbench.listSkills(workspace.id), window.workbench.mcpSettings(workspace.id), window.workbench.notificationStatus()]);
    setSkills(nextSkills); setMcp(nextMcp); setMcpText(nextMcp.content); setNotification(status);
  };
  useEffect(() => { void perform('tools-load', refresh); }, [workspace.id]);
  const usage = sessions.filter(session => session.cwd === workspace.cwd).flatMap(session => (session.usage ?? []).map(record => ({ ...record, title: session.title })));

  return <Modal title={t('tools.title')} subtitle={workspace.name} onClose={onClose}>
    <div className="workspace-tools">
      <div className="tools-tabs" role="group" aria-label={t('tools.categories')} data-tab={tab}>
        {(['skills', 'mcp', 'usage'] as const).map(value => <button className={tab === value ? 'selected' : ''} aria-pressed={tab === value} key={value} onClick={() => {
          setTab(value);
          if (value === 'usage') void perform('notification-status', async () => setNotification(await window.workbench.notificationStatus()));
        }}>{value === 'skills' ? <Puzzle size={15} /> : value === 'mcp' ? <Plug size={15} /> : <Activity size={15} />}{value === 'skills' ? 'Skills' : value === 'mcp' ? 'MCP' : t('tools.usageTab')}</button>)}
      </div>
      <div className="tools-content">
        {tab === 'skills' && <>
          <div className="tools-actions"><span>{t('tools.skillSources')}</span><button className="button small" onClick={() => setSkill({ name: '', content: '---\nname: \ndescription: \n---\n\n', editable: true })}><Plus size={13} />{t('tools.newSkill')}</button></div>
          <div className="tools-list">
            {skills.map(item => <button className={`tools-list-item ${skill?.id === item.id ? 'selected' : ''}`} key={item.id} onClick={() => void perform('read-skill', async () => {
              const read = await window.workbench.readSkill(workspace.id, item.id);
              setSkill({ id: item.id, name: item.path.split('/').at(-2) ?? item.name, ...read, editable: item.editable });
            })}>
              <span className="tool-list-icon"><Puzzle size={17} /></span>
              <span className="tool-list-copy"><strong>{item.name}</strong><small>{item.description || item.issue}</small></span>
              <span className="tool-scope">{item.scope === 'project' ? t('tools.projectScope') : t('tools.userScope')}</span>
            </button>)}
          </div>
          {skill && <section className="tools-editor">
            <div className="tools-editor-heading"><FileText size={15} /><strong>{skill.id ? t('tools.skillContent') : t('tools.newSkill')}</strong>{!skill.editable && <span className="tool-scope">{t('common.readOnly')}</span>}</div>
            <label>{t('tools.directoryName')}<input value={skill.name} disabled={!!skill.id} onChange={event => setSkill({ ...skill, name: event.target.value })} /></label>
            <textarea aria-label={t('tools.skillContent')} rows={10} readOnly={!skill.editable} value={skill.content} onChange={event => setSkill({ ...skill, content: event.target.value })} />
            <div className="tools-actions"><span>{skill.editable ? t('tools.skillDestination') : t('tools.userSkillReadOnly')}</span>{skill.editable && <button className="button primary small" disabled={!skill.name.trim()} onClick={() => void perform('save-skill', async () => {
              await window.workbench.saveSkill(workspace.id, { name: skill.name, content: skill.content, revision: skill.revision });
              setSkill(undefined); await refresh();
            })}>{t('tools.saveSkill')}</button>}</div>
          </section>}
        </>}
        {tab === 'mcp' && <>
          <p className="pane-note">{t('tools.mcpDescription')}</p>
          <div className="tools-config-surface"><div className="tools-editor-heading"><FileText size={15} /><strong>{t('tools.mcpConfig')}</strong></div><textarea aria-label={t('tools.mcpConfig')} className="config-editor" rows={10} value={mcpText} onChange={event => setMcpText(event.target.value)} /></div>
          <div className="tools-actions"><span>{t('tools.collaborationService')}</span><button className="button primary small" disabled={!mcp} onClick={() => void perform('save-mcp', async () => {
            await window.workbench.saveMcpSettings(workspace.id, { content: mcpText, revision: mcp!.revision }); await refresh();
          })}>{t('tools.saveConfig')}</button></div>
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
