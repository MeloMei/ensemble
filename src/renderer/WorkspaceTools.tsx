import { useEffect, useState } from 'react';
import { Activity, BellRing, FileText, Plug, Plus, Puzzle, RefreshCw, Wallet } from 'lucide-react';
import type { McpSettingsView, NotificationStatus, Session, SkillInfo, Workspace } from '../shared/types';
import { Modal, type Perform } from './ui';

export function WorkspaceTools({ workspace, sessions, perform, onClose }: { workspace: Workspace; sessions: Session[]; perform: Perform; onClose: () => void }) {
  const [tab, setTab] = useState<'skills' | 'mcp' | 'usage'>('skills');
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [mcp, setMcp] = useState<McpSettingsView>();
  const [mcpText, setMcpText] = useState('');
  const [skill, setSkill] = useState<{ id?: string; name: string; content: string; revision?: string; editable: boolean }>();
  const [connections, setConnections] = useState<Record<string, string>>({});
  const [balance, setBalance] = useState<Awaited<ReturnType<Window['workbench']['deepSeekBalance']>>>();
  const [notification, setNotification] = useState<NotificationStatus>();
  const refresh = async () => {
    const [nextSkills, nextMcp, status] = await Promise.all([window.workbench.listSkills(workspace.id), window.workbench.mcpSettings(workspace.id), window.workbench.notificationStatus()]);
    setSkills(nextSkills); setMcp(nextMcp); setMcpText(nextMcp.content); setNotification(status);
  };
  useEffect(() => { void perform('tools-load', refresh); }, [workspace.id]);
  const usage = sessions.filter(session => session.cwd === workspace.cwd).flatMap(session => (session.usage ?? []).map(record => ({ ...record, title: session.title })));

  return <Modal title="项目设置" subtitle={workspace.name} onClose={onClose}>
    <div className="workspace-tools">
      <div className="tools-tabs" role="group" aria-label="项目设置类别" data-tab={tab}>
        {(['skills', 'mcp', 'usage'] as const).map(value => <button className={tab === value ? 'selected' : ''} aria-pressed={tab === value} key={value} onClick={() => {
          setTab(value);
          if (value === 'usage') void perform('notification-status', async () => setNotification(await window.workbench.notificationStatus()));
        }}>{value === 'skills' ? <Puzzle size={15} /> : value === 'mcp' ? <Plug size={15} /> : <Activity size={15} />}{value === 'skills' ? 'Skills' : value === 'mcp' ? 'MCP' : '用量与通知'}</button>)}
      </div>
      <div className="tools-content">
        {tab === 'skills' && <>
          <div className="tools-actions"><span>本机与当前项目的 Skills</span><button className="button small" onClick={() => setSkill({ name: '', content: '---\nname: \ndescription: \n---\n\n', editable: true })}><Plus size={13} />新建项目 Skill</button></div>
          <div className="tools-list">
            {skills.map(item => <button className={`tools-list-item ${skill?.id === item.id ? 'selected' : ''}`} key={item.id} onClick={() => void perform('read-skill', async () => {
              const read = await window.workbench.readSkill(workspace.id, item.id);
              setSkill({ id: item.id, name: item.path.split('/').at(-2) ?? item.name, ...read, editable: item.editable });
            })}>
              <span className="tool-list-icon"><Puzzle size={17} /></span>
              <span className="tool-list-copy"><strong>{item.name}</strong><small>{item.description || item.issue}</small></span>
              <span className="tool-scope">{item.scope === 'project' ? '项目' : '用户'}</span>
            </button>)}
          </div>
          {skill && <section className="tools-editor">
            <div className="tools-editor-heading"><FileText size={15} /><strong>{skill.id ? 'Skill 内容' : '新建项目 Skill'}</strong>{!skill.editable && <span className="tool-scope">只读</span>}</div>
            <label>目录名称<input value={skill.name} disabled={!!skill.id} onChange={event => setSkill({ ...skill, name: event.target.value })} /></label>
            <textarea aria-label="Skill 内容" rows={10} readOnly={!skill.editable} value={skill.content} onChange={event => setSkill({ ...skill, content: event.target.value })} />
            <div className="tools-actions"><span>{skill.editable ? '保存至项目 .agents/skills' : '用户 Skill 只读'}</span>{skill.editable && <button className="button primary small" disabled={!skill.name.trim()} onClick={() => void perform('save-skill', async () => {
              await window.workbench.saveSkill(workspace.id, { name: skill.name, content: skill.content, revision: skill.revision });
              setSkill(undefined); await refresh();
            })}>保存 Skill</button>}</div>
          </section>}
        </>}
        {tab === 'mcp' && <>
          <p className="pane-note">Ensemble 配置用于下一回合。项目原有配置保持来源标识；“enabled”表示配置启用，连接结果由检测返回。</p>
          <div className="tools-config-surface"><div className="tools-editor-heading"><FileText size={15} /><strong>MCP 配置</strong></div><textarea aria-label="MCP 配置" className="config-editor" rows={10} value={mcpText} onChange={event => setMcpText(event.target.value)} /></div>
          <div className="tools-actions"><span>内部协作服务由平台注入。</span><button className="button primary small" disabled={!mcp} onClick={() => void perform('save-mcp', async () => {
            await window.workbench.saveMcpSettings(workspace.id, { content: mcpText, revision: mcp!.revision }); await refresh();
          })}>保存配置</button></div>
          <div className="tools-list">{mcp?.servers.map((server, index) => <div className="tools-item" key={`${server.source}-${server.name}-${index}`}>
            <div className="tools-item-heading"><span className="tool-list-icon"><Plug size={17} /></span><div className="tool-list-copy"><strong>{server.name}</strong><small>{server.source} · {server.transport} · {server.status}{server.issue && ` · ${server.issue}`}</small></div>
              {server.status === 'enabled' && <button className="button small" onClick={() => void perform(`mcp-${server.name}`, async () => {
                const result = await window.workbench.testMcpServer(workspace.id, server.name);
                setConnections(current => ({ ...current, [server.name]: result.status === 'connected' ? `已连接 · ${result.tools.length} 个工具` : result.error ?? '连接失败' }));
              })}>检测连接</button>}
            </div>
            {connections[server.name] && <p className="tools-connection-result" role="status">{connections[server.name]}</p>}
          </div>)}</div>
        </>}
        {tab === 'usage' && <>
          <div className="tools-balance-card">
            <div className="tools-actions"><span className="tools-section-title"><Wallet size={16} />DeepSeek 官方余额</span><button className="button small" onClick={() => void perform('balance', async () => setBalance(await window.workbench.deepSeekBalance()))}>查询余额</button></div>
            {balance && <div className="balance-value">{balance.balances.map(value => <div key={value.currency}>{value.currency} {value.total}</div>)}<small>{new Date(balance.checkedAt).toLocaleString()}</small></div>}
            <p className="pane-note">余额精度以服务返回为准。运行时记录的 tokens、上下文占用和费用分别显示。</p>
          </div>
          <div className="usage-table">{usage.length ? usage.map(record => <div key={`${record.title}-${record.id}`}>
            <strong>{record.title}</strong><small>{record.source} · {record.scope === 'context' ? '上下文' : record.scope === 'cumulative' ? '累计' : '本次'}</small>
            <span>{record.scope === 'context' ? `${record.contextUsed ?? '—'} / ${record.contextSize ?? '—'}` : `输入 ${record.inputTokens ?? '—'} · 输出 ${record.outputTokens ?? '—'} · 缓存 ${record.cachedTokens ?? '—'}`}{record.cost !== undefined && ` · ${record.currency ?? ''} ${record.cost}`}</span>
          </div>) : <p className="pane-note">还没有运行时用量记录。</p>}</div>
          <section className="tools-notification-card"><div className="tools-actions"><span className="tools-section-title"><BellRing size={15} />系统通知</span><button className="button small" onClick={() => void perform('notification-status', async () => setNotification(await window.workbench.notificationStatus()))}><RefreshCw size={12} />刷新状态</button></div>
            <p className="pane-note">{!notification?.supported ? '当前环境不支持' : notification.state === 'failed' ? `送达失败：${notification.error ?? ''}` : notification.state === 'shown' ? '系统报告已显示' : notification.state === 'requested' ? '已请求显示，等待系统回执' : '等待任务状态变化'}</p>
          </section>
        </>}
      </div>
    </div>
  </Modal>;
}
