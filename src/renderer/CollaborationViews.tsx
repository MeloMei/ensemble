import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useReducedMotion } from 'framer-motion';
import { ArrowUpRight, Check, ChevronRight, Copy, FileText, GitBranch, KeyRound, LoaderCircle, MessageSquare, Network, PanelRight, Pause, Play, Plus, RefreshCw, Settings2, Square, Trash2, X } from 'lucide-react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, useNodes, useNodesInitialized, useReactFlow, type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import ELK from 'elkjs/lib/elk-api.js';
import ELKWorker from 'elkjs/lib/elk-worker.min.js?worker';
import type { CollaborationArtifactVersion, CollaborationDefinition, CollaborationEvent, CollaborationMessage, CollaborationParticipant, CollaborationRun, CollaborationTask, CollaborationTaskTemplate } from '../shared/collaboration';
import type { McpServerConfig, ProviderInfo, PublicCollaborationState, Session, Snapshot } from '../shared/types';
import { DirectoryField, EmptyState, IconButton, Modal, ModelField, ProviderSelect, Status, defaultModelId, modelName, pathName, relativeTime, validModelSelection, type Perform } from './ui';
import { useAppearance } from './appearance';
import { createImplementationReviewDraft, participantPermissionIssue, withCollaborationGoal } from './collaboration-template';
import '@xyflow/react/dist/style.css';
import './CollaborationViews.css';

const call = (operation: string, input: unknown) => window.workbench.collaborationCall(operation, input);
const requestId = () => crypto.randomUUID();
const splitValues = (text: string) => [...new Set(text.split(/[,，\n]/).map(value => value.trim()).filter(Boolean))];
const splitRoots = (text: string) => [...new Set(text.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN');
const participantName = (run: CollaborationRun, id?: string) => id === 'user' ? '用户' : run.definitionSnapshot.participants.find(item => item.id === id)?.name ?? id ?? '平台';
const deliveryLabel: Record<string, string> = { accepted: '已接收', queued: '排队中', injected: '已注入输入', reported: '外部已报告', failed: '投递失败' };
const eventLabel: Record<string, string> = { 'run.created': '创建协作', 'run.configured': '更新配置', 'run.started': '开始协作', 'run.paused': '暂停协作', 'run.running': '开始或恢复协作', 'run.cancelled': '停止协作', 'run.completed': '结束协作', 'task.submitted': '提交任务', 'task.attached': '关联原会话', 'task.dispatched': '派发执行', 'task.running': '开始执行', 'task.claimed': '外部领取任务', 'task.wait_requested': '等待协作任务', 'task.completed': '任务完成', 'task.failed': '任务失败', 'task.cancelled': '停止任务', 'task.pending': '任务待执行', 'task.queued': '任务排队', 'task.waiting': '等待子任务', 'message.accepted': '接收消息', 'message.injected': '注入消息', 'message.reported': '外部领取消息', 'input.injected': '注入任务输入', 'artifact.published': '发布产物', 'artifact.injected': '注入产物', 'runtime.bound': '关联原生会话', 'runtime.usage': '记录原生用量', 'runtime.structured': '原生工具事件' };
function taskDisplayStatus(task: CollaborationTask, sessions: Session[]) {
  if (task.status === 'waiting' && task.waitingForTaskIds?.length) return 'waiting_children';
  if (task.status === 'running' || task.status === 'queued') {
    const session = sessions.find(item => item.id === task.sessionId);
    if (session && ['queued', 'running', 'waiting_approval', 'waiting_children'].includes(session.status)) return session.status;
  }
  return task.status;
}
function eventStatus(event: CollaborationEvent) {
  if (event.type === 'task.wait_requested' || event.type === 'task.waiting') return 'waiting_children';
  const status = event.type.split('.').at(-1);
  return status && ['running', 'completed', 'failed', 'cancelled', 'interrupted', 'queued', 'pending', 'waiting', 'paused'].includes(status) ? status : undefined;
}
function ListInput({ values, onChange, placeholder }: { values: string[]; onChange: (values: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState(values.join('，'));
  return <input value={text} onChange={event => { setText(event.target.value); onChange(splitValues(event.target.value)); }} placeholder={placeholder} />;
}
function recordedParticipants(run: CollaborationRun, state: PublicCollaborationState, events: CollaborationEvent[]) {
  const participants = new Map<string, CollaborationParticipant>();
  for (const definition of state.definitions.filter(item => item.id === run.definitionId && item.version <= run.definitionVersion).sort((a, b) => a.version - b.version)) for (const participant of definition.participants) participants.set(participant.id, participant);
  for (const task of state.tasks.filter(item => item.runId === run.id)) if (!participants.has(task.participantId)) participants.set(task.participantId, task.participantSnapshot);
  for (const participant of run.definitionSnapshot.participants) participants.set(participant.id, participant);
  const relevant = new Set([...run.definitionSnapshot.participants.map(item => item.id), ...state.tasks.filter(item => item.runId === run.id).map(item => item.participantId), ...events.flatMap(event => [event.participantId, event.targetParticipantId])]);
  return [...participants.values()].filter(participant => relevant.has(participant.id));
}

function SetupSteps({ current }: { current: 1 | 2 | 3 }) {
  return <ol className="collaboration-setup-steps" aria-label="协作设置步骤">{['填写目标', '检查分工', '开始协作'].map((label, index) => <li key={label} className={index + 1 === current ? 'current' : index + 1 < current ? 'complete' : ''} aria-current={index + 1 === current ? 'step' : undefined}><span>{index + 1 < current ? <Check size={12} /> : index + 1}</span>{label}</li>)}</ol>;
}

function CollaborationStart({ onTemplate, onCustom }: { onTemplate: () => void; onCustom: () => void }) {
  return <section className="collaboration-start"><div className="collaboration-start-intro"><Network size={24} /><h1>从一个明确目标开始</h1><p>安排分工、检查权限，再开始执行。</p></div><div className="collaboration-start-options">
    <button className="collaboration-start-option" onClick={onTemplate}><GitBranch size={20} /><span><strong>实现与审阅</strong><small>一位完成修改，另一位只读审阅。任务和依赖已配置好，你可以继续调整。</small><em>填写目标 <ChevronRight size={13} /></em></span></button>
    <button className="collaboration-start-option" onClick={onCustom}><Settings2 size={20} /><span><strong>自定义协作</strong><small>自由安排参与者、权限和任务，支持外部 Agent 与运行中派工。</small><em>打开完整配置 <ChevronRight size={13} /></em></span></button>
  </div><p className="collaboration-start-note">同一项目顺序执行。保存配置后，由你决定何时开始。</p></section>;
}

function implementationReviewDefaults(providers: ProviderInfo[], cwd: string) {
  const implementer = providers.find(provider => provider.available);
  const reviewers = providers.filter(provider => provider.available && provider.capabilities.permissions);
  const reviewer = reviewers.find(provider => provider.id !== implementer?.id) ?? reviewers[0];
  return createImplementationReviewDraft({ cwd, implementer, reviewer, implementerModelId: defaultModelId(implementer), reviewerModelId: defaultModelId(reviewer) });
}

export function CollaborationViews({ snapshot, perform, pending, openSession, initialCwd = '', openProviderSettings }: {
  snapshot: Snapshot; perform: Perform; pending: Set<string>; openSession: (id: string) => void; initialCwd?: string; openProviderSettings?: () => void;
}) {
  const state = snapshot.collaboration;
  const [selectedId, setSelectedId] = useState<string>();
  const [editing, setEditing] = useState<'new' | string>();
  const [connections, setConnections] = useState(false);
  const runs = [...(state?.runs ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const run = runs.find(item => item.id === selectedId) ?? runs[0];
  const editorRun = editing ? runs.find(item => item.id === editing) : undefined;
  return <div className="collaboration-page">
    <aside className="collaboration-list"><div className="sidebar-heading"><h2>协作</h2><IconButton label="新建协作" onClick={() => setEditing('new')}><Plus size={17} /></IconButton></div><p>安排角色，一起完成任务。</p>
      <div className="collaboration-run-list">{runs.map(item => <button className={`collaboration-run-item ${run?.id === item.id && !editing ? 'selected' : ''}`} key={item.id} aria-current={run?.id === item.id && !editing ? 'page' : undefined} onClick={() => { setSelectedId(item.id); setEditing(undefined); }}><strong>{item.definitionSnapshot.name}</strong><small>{pathName(item.definitionSnapshot.cwd)} · v{item.definitionVersion}</small><span><Status value={item.status} /><time>{relativeTime(item.updatedAt)}</time></span></button>)}{!runs.length && <p className="collaboration-list-empty">保存的协作会显示在这里。</p>}</div>
      <button className="button primary" onClick={() => setEditing('new')}><Plus size={14} />新建协作</button><button className="button subtle" onClick={() => setConnections(true)}><KeyRound size={14} />Agent MCP 接入</button>
    </aside>
    {!state ? <EmptyState icon={<Network size={28} />} title="后台协作数据尚未就绪">请重新连接后台服务。</EmptyState> : editing ? <CollaborationEditor key={editing} starter={editing === 'new-template' ? 'template' : editing === 'new-custom' ? 'custom' : 'choose'} providers={snapshot.providers} identities={state.identities} initialCwd={initialCwd} run={editorRun} pending={pending} perform={perform} openProviderSettings={openProviderSettings} onClose={() => setEditing(undefined)} onSaved={id => { setSelectedId(id); setEditing(undefined); }} /> : run ? <CollaborationRunView key={run.id} run={run} state={state} stateVersion={snapshot.collaborationEventSeq} providers={snapshot.providers} sessions={snapshot.sessions} perform={perform} pending={pending} openSession={openSession} onEdit={() => setEditing(run.id)} /> : <CollaborationStart onTemplate={() => setEditing('new-template')} onCustom={() => setEditing('new-custom')} />}
    {connections && <ConnectionDialog providers={snapshot.providers} state={state} initialCwd={run?.definitionSnapshot.cwd ?? initialCwd} perform={perform} pending={pending} onClose={() => setConnections(false)} />}
  </div>;
}

function CollaborationEditor({ providers, identities, initialCwd, run, perform, pending, onClose, onSaved, starter, openProviderSettings }: {
  providers: ProviderInfo[]; identities: PublicCollaborationState['identities']; initialCwd: string; run?: CollaborationRun; perform: Perform; pending: Set<string>; onClose: () => void; onSaved: (id: string) => void; starter: 'choose' | 'template' | 'custom'; openProviderSettings?: () => void;
}) {
  const initial = run?.definitionSnapshot ?? (starter === 'template' ? implementationReviewDefaults(providers, initialCwd) : undefined);
  const [stage, setStage] = useState<'choose' | 'template' | 'details'>(run || starter === 'custom' ? 'details' : starter === 'template' ? 'template' : 'choose');
  const [templated, setTemplated] = useState(starter === 'template');
  const [goal, setGoal] = useState('');
  const [name, setName] = useState(initial?.name ?? '');
  const [cwd, setCwd] = useState(initial?.cwd ?? initialCwd);
  const [participants, setParticipants] = useState<CollaborationParticipant[]>(initial?.participants ?? []);
  const [relationships, setRelationships] = useState<CollaborationDefinition['relationships']>(initial?.relationships ?? []);
  const [steps, setSteps] = useState<CollaborationTaskTemplate[]>(initial?.steps ?? []);
  const [limits, setLimits] = useState(initial?.limits ?? {});
  const [completion, setCompletion] = useState(initial?.completion ?? 'manual');
  const key = run ? `collaboration-update-${run.id}` : 'collaboration-create';
  const busy = pending.has(key);
  const update = (id: string, patch: Partial<CollaborationParticipant>) => setParticipants(items => items.map(item => item.id === id ? { ...item, ...patch } : item));
  const setAccess = (participant: CollaborationParticipant, access: 'read-only' | 'read-write') => update(participant.id, { permissions: { ...participant.permissions, workspace: { cwd: participant.permissions.workspace?.cwd ?? participant.cwd ?? cwd, access } }, settings: { ...participant.settings, permission: access === 'read-only' ? 'read-only' : providers.find(provider => provider.id === participant.providerId)?.capabilities.permissions ? 'review' : undefined } });
  const setProvider = (participant: CollaborationParticipant, providerId: string) => {
    const provider = providers.find(item => item.id === providerId);
    update(participant.id, { providerId, modelId: defaultModelId(provider), settings: { ...participant.settings, effort: undefined, permission: participant.settings?.permission === 'review' && !provider?.capabilities.permissions ? undefined : participant.settings?.permission } });
  };
  const permissionIssues = participants.flatMap(participant => { const issue = participantPermissionIssue(participant, providers.find(provider => provider.id === participant.providerId)); return issue ? [{ id: participant.id, message: issue }] : []; });
  const selectionsValid = participants.every(item => item.mode === 'external' || validModelSelection(providers.find(provider => provider.id === item.providerId), item.modelId));
  const setupValid = Boolean(goal.trim() && cwd.trim() && participants.length && selectionsValid && !permissionIssues.length);
  const valid = Boolean(name.trim() && cwd.trim() && (!templated || goal.trim()) && participants.length && !permissionIssues.length && selectionsValid && participants.every(item => item.name.trim()) && steps.every(step => step.title.trim() && step.prompt.trim() && participants.some(item => item.id === step.participantId)));
  const save = (event: FormEvent) => {
    event.preventDefault(); if (!valid || busy) return;
    void perform(key, async () => {
      const definition = withCollaborationGoal({ name: name.trim(), cwd: cwd.trim(), participants: participants.map(item => ({ ...item, name: item.name.trim(), cwd: item.cwd?.trim() || cwd.trim(), permissions: { ...item.permissions, workspace: { cwd: item.cwd?.trim() || cwd.trim(), access: item.permissions.workspace?.access ?? 'read-only' } } })), relationships, steps, limits, completion }, templated ? goal : '');
      const { cwd: _immutableCwd, ...versionInput } = definition;
      const result = await call(run ? 'update_run' : 'create_run', run
        ? { requestId: requestId(), ...versionInput, runId: run.id, expectedVersion: run.definitionVersion }
        : { requestId: requestId(), ...definition, start: false }) as { runId: string };
      onSaved(result.runId ?? run!.id);
    });
  };
  const addParticipant = () => {
    const provider = providers.find(item => item.available);
    setParticipants(items => [...items, { id: requestId(), name: `Agent ${items.length + 1}`, mode: 'managed', roles: [], providerId: provider?.id, modelId: defaultModelId(provider), permissions: { submitTasks: false, sendMessages: false, configureRun: false, publishArtifacts: false, workspace: { cwd, access: 'read-only' } } }]);
  };
  const chooseTemplate = () => {
    const template = implementationReviewDefaults(providers, cwd);
    setName(template.name); setParticipants(template.participants); setRelationships(template.relationships); setSteps(template.steps); setLimits(template.limits); setCompletion(template.completion ?? 'all-tasks');
    setTemplated(true); setStage('template');
  };
  if (stage === 'choose') return <CollaborationStart onTemplate={chooseTemplate} onCustom={() => setStage('details')} />;
  if (stage === 'template') return <section className="collaboration-editor"><div className="detail-heading"><div><h1>实现与审阅</h1><p>先完成修改，再交给另一位 Agent 只读审阅。</p></div><IconButton label="关闭协作配置" onClick={onClose}><X size={18} /></IconButton></div><form className="collaboration-editor-body collaboration-template-form" onSubmit={event => { event.preventDefault(); if (setupValid) setStage('details'); }}>
    <SetupSteps current={1} />
    <label>任务目标<textarea rows={4} required autoFocus maxLength={100000} value={goal} onChange={event => setGoal(event.target.value)} placeholder="写清要修改的行为、需要保留的功能，以及怎样算完成。" /><small>这个目标会交给两位参与者。下一步可以检查完整任务和权限。</small></label>
    <label>项目目录<DirectoryField value={cwd} onChange={setCwd} perform={perform} /></label>
    <div className="collaboration-template-roles">{participants.map(participant => <section className="collaboration-template-role" key={participant.id}><div><strong>{participant.name || '未命名参与者'}</strong><span>{participant.permissions.workspace?.access === 'read-only' ? '只读检查，等待前序任务完成' : '可修改项目，按运行时处理审批'}</span></div>{participant.mode === 'managed' ? <><label>运行时<ProviderSelect providers={participant.permissions.workspace?.access === 'read-only' ? providers.filter(provider => provider.capabilities.permissions) : providers} value={participant.providerId ?? ''} onChange={providerId => setProvider(participant, providerId)} /></label><ModelField provider={providers.find(provider => provider.id === participant.providerId)} value={participant.modelId} onChange={modelId => update(participant.id, { modelId: modelId || undefined })} /></> : <p className="collaboration-observation-note">外部 Agent；绑定与权限可在下一步继续调整。</p>}{permissionIssues.filter(issue => issue.id === participant.id).map(issue => <p className="collaboration-field-error" role="alert" key={issue.id}>{issue.message}</p>)}</section>)}</div>
    {participants.some(participant => participant.mode === 'managed' && participant.permissions.workspace?.access === 'read-only') && !providers.some(provider => provider.available && provider.capabilities.permissions) && <div className="collaboration-setup-notice" role="status"><p>审阅者需要支持只读权限的运行时。请先接入可用运行时，再继续配置。</p></div>}
    <p className="collaboration-start-note">同一项目顺序执行。同一个运行时也可以分别担任实现者和审阅者。检测到入口不代表认证已通过，任务使用你配置的模型账户。</p>
    {openProviderSettings && <button className="text-button" type="button" onClick={openProviderSettings}>接入与登录帮助 <ArrowUpRight size={13} /></button>}
    <div className="editor-actions"><button className="button" type="button" onClick={onClose}>取消</button><button className="button primary" disabled={!setupValid}>检查分工 <ChevronRight size={14} /></button></div>
  </form></section>;
  return <section className="collaboration-editor"><div className="detail-heading"><div><h1>{run ? '编辑协作配置' : '新建协作'}</h1><p>{run ? `基于 v${run.definitionVersion} 保存新版本，只影响后续任务。` : '保存后再开始执行。角色名称不会自动授予权限。'}</p></div><IconButton label="关闭协作配置" disabled={busy} onClick={onClose}><X size={18} /></IconButton></div>
    <form className="collaboration-editor-body" onSubmit={save}>
      {!run && <SetupSteps current={2} />}
      {templated && <div className="collaboration-goal-summary"><div><strong>共同目标</strong><button className="text-button" type="button" onClick={() => setStage('template')}>返回修改</button></div><p>{goal}</p><small>目标会附在每项任务前。下方修改会保留，返回填写目标不会重置分工。</small></div>}
      <div className="collaboration-form-grid"><label>协作名称<input value={name} maxLength={200} required autoFocus onChange={event => setName(event.target.value)} placeholder="这次协作要完成什么" /></label><label>项目目录{run ? <input value={cwd} readOnly /> : <DirectoryField value={cwd} onChange={setCwd} perform={perform} />}</label></div>
      <div className="collaboration-section-heading"><div><h2>参与者与角色</h2><p>同一运行时可以添加多位参与者，分别分配职责。</p></div><button className="button small" type="button" disabled={busy} onClick={addParticipant}><Plus size={14} />添加参与者</button></div>
      {!participants.length && <div className="collaboration-form-empty">添加参与者后，自由填写角色和职责。</div>}
      {participants.map(participant => <article className="participant-editor" key={participant.id}>
        <div className="participant-editor-heading"><strong>{participant.name || '未命名参与者'}</strong><IconButton label={`删除参与者 ${participant.name}`} disabled={busy} onClick={() => { setParticipants(items => items.filter(item => item.id !== participant.id).map(item => ({ ...item, permissions: { ...item.permissions, ...(item.permissions.allowedTargets ? { allowedTargets: item.permissions.allowedTargets.filter(id => id !== participant.id) } : {}) } }))); setRelationships(items => items.filter(item => item.from !== participant.id && item.to !== participant.id)); setSteps(items => items.filter(item => item.participantId !== participant.id).map(item => ({ ...item, dependsOn: item.dependsOn.filter(id => !steps.some(step => step.id === id && step.participantId === participant.id)) }))); }}><Trash2 size={14} /></IconButton></div>
        <div className="collaboration-form-grid"><label>显示名称<input value={participant.name} required onChange={event => update(participant.id, { name: event.target.value })} /></label><label>接入方式<select value={participant.mode} onChange={event => update(participant.id, { mode: event.target.value as 'managed' | 'external' })}><option value="managed">由平台启动和管理</option><option value="external">来自外部 Agent 的 MCP 连接</option></select></label></div>
        <label>角色<ListInput values={participant.roles} onChange={roles => update(participant.id, { roles })} placeholder="自由命名，多个角色用逗号分隔" /></label>
        <label>职责与交付要求<textarea rows={2} value={participant.instructions ?? ''} onChange={event => update(participant.id, { instructions: event.target.value })} placeholder="这个参与者负责什么，向谁交付什么" /></label>
        {participant.mode === 'managed' ? <div className="collaboration-form-grid"><label>运行时<ProviderSelect providers={providers} value={participant.providerId ?? ''} onChange={providerId => setProvider(participant, providerId)} /></label><ModelField provider={providers.find(item => item.id === participant.providerId)} value={participant.modelId} disabled={busy} onChange={modelId => update(participant.id, { modelId: modelId || undefined })} /></div> : <label>绑定接入身份<select value={participant.binding?.identityId ?? ''} onChange={event => update(participant.id, { binding: event.target.value ? { identityId: event.target.value } : undefined })}><option value="">稍后绑定</option>{identities.filter(item => !item.revokedAt).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
        <div className="collaboration-form-grid"><label>执行目录 <span className="optional">默认项目目录</span><input value={participant.cwd ?? ''} placeholder={cwd} onChange={event => update(participant.id, { cwd: event.target.value })} /></label><label>{participant.mode === 'external' ? '平台内文件授权' : '文件权限'}<select value={participant.permissions.workspace?.access ?? 'read-only'} aria-invalid={permissionIssues.some(issue => issue.id === participant.id)} aria-describedby={permissionIssues.some(issue => issue.id === participant.id) ? `permission-issue-${participant.id}` : undefined} onChange={event => setAccess(participant, event.target.value as 'read-only' | 'read-write')}><option value="read-only" disabled={participant.mode === 'managed' && !providers.find(provider => provider.id === participant.providerId)?.capabilities.permissions}>只读</option><option value="read-write">可读写授权目录</option></select></label></div>
        {permissionIssues.filter(issue => issue.id === participant.id).map(issue => <p className="collaboration-field-error" id={`permission-issue-${participant.id}`} role="alert" key={issue.id}>{issue.message}</p>)}
        {participant.mode === 'managed' && !providers.find(provider => provider.id === participant.providerId)?.capabilities.permissions && participant.permissions.workspace?.access === 'read-write' && <p className="collaboration-observation-note">此运行时的工具权限由它自身的配置控制。当前选择允许它修改项目文件。</p>}
        {participant.mode === 'external' && <p className="collaboration-observation-note">原客户端的文件和工具权限由原客户端管理；这里限制它通过平台进行的操作。</p>}
        <fieldset className="collaboration-permissions"><legend>协作权限</legend>{([{ key: 'submitTasks', label: '派发任务' }, { key: 'sendMessages', label: '发送消息' }, { key: 'publishArtifacts', label: '发布产物' }, { key: 'configureRun', label: '调整协作配置' }] as const).map(permission => <label key={permission.key}><input type="checkbox" checked={participant.permissions[permission.key]} onChange={event => update(participant.id, { permissions: { ...participant.permissions, [permission.key]: event.target.checked } })} />{permission.label}</label>)}</fieldset>
        <details className="collaboration-advanced"><summary>目标与运行范围</summary><label className="collaboration-checkbox"><input type="checkbox" checked={participant.permissions.allowedTargets !== undefined} onChange={event => update(participant.id, { permissions: { ...participant.permissions, allowedTargets: event.target.checked ? [] : undefined } })} />限制可交互的参与者</label>{participant.permissions.allowedTargets && <div className="collaboration-check-list">{participants.filter(item => item.id !== participant.id).map(target => <label key={target.id}><input type="checkbox" checked={participant.permissions.allowedTargets!.includes(target.id)} onChange={event => update(participant.id, { permissions: { ...participant.permissions, allowedTargets: event.target.checked ? [...participant.permissions.allowedTargets!, target.id] : participant.permissions.allowedTargets!.filter(id => id !== target.id) } })} />{target.name}</label>)}</div>}{participant.mode === 'managed' && Boolean(providers.find(item => item.id === participant.providerId)?.efforts?.length) && <label>思考档位<select value={participant.settings?.effort ?? ''} onChange={event => update(participant.id, { settings: { ...participant.settings, effort: event.target.value || undefined } })}><option value="">运行时当前设置</option>{providers.find(item => item.id === participant.providerId)?.efforts?.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label>}<p>工具执行范围遵循当前运行时已提供的权限能力。</p></details>
      </article>)}
      <div className="collaboration-section-heading"><div><h2>配置关系</h2><p>用于表达用户安排，不表示任务或资料已传递。</p></div><button className="button small" type="button" disabled={participants.length < 2 || busy} onClick={() => setRelationships(items => [...items, { id: requestId(), from: participants[0].id, to: participants[1].id, kind: '', label: '' }])}><Plus size={14} />添加关系</button></div>
      {relationships.map(relation => <div className="relationship-editor" key={relation.id}><select aria-label="关系来源" value={relation.from} onChange={event => setRelationships(items => items.map(item => item.id === relation.id ? { ...item, from: event.target.value } : item))}>{participants.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronRight size={14} /><select aria-label="关系目标" value={relation.to} onChange={event => setRelationships(items => items.map(item => item.id === relation.id ? { ...item, to: event.target.value } : item))}>{participants.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><input aria-label="关系说明" value={relation.kind} onChange={event => setRelationships(items => items.map(item => item.id === relation.id ? { ...item, kind: event.target.value } : item))} placeholder="关系，例如：汇报、审查" required /><IconButton label="删除配置关系" onClick={() => setRelationships(items => items.filter(item => item.id !== relation.id))}><Trash2 size={14} /></IconButton></div>)}
      <div className="collaboration-section-heading"><div><h2>预设任务 <span className="optional">可选</span></h2><p>留空可在运行中派工；预设任务也可以和动态派工组合。</p></div><button className="button small" type="button" disabled={!participants.length || busy} onClick={() => setSteps(items => [...items, { id: requestId(), title: '', participantId: participants[0].id, prompt: '', dependsOn: [], artifactIds: [] }])}><Plus size={14} />添加任务</button></div>
      {steps.map(step => <article className="participant-editor" key={step.id}><div className="collaboration-form-grid"><label>任务名称<input value={step.title} required onChange={event => setSteps(items => items.map(item => item.id === step.id ? { ...item, title: event.target.value } : item))} /></label><label>负责参与者<select value={step.participantId} onChange={event => setSteps(items => items.map(item => item.id === step.id ? { ...item, participantId: event.target.value } : item))}>{participants.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div><label>任务与验收条件<textarea rows={3} value={step.prompt} required onChange={event => setSteps(items => items.map(item => item.id === step.id ? { ...item, prompt: event.target.value } : item))} /></label><div className="collaboration-check-list"><span>等待任务</span>{steps.filter(item => item.id !== step.id).map(target => <label key={target.id}><input type="checkbox" checked={step.dependsOn.includes(target.id)} onChange={event => setSteps(items => items.map(item => item.id === step.id ? { ...item, dependsOn: event.target.checked ? [...item.dependsOn, target.id] : item.dependsOn.filter(id => id !== target.id) } : item))} />{target.title || '未命名任务'}</label>)}<IconButton label="删除预设任务" onClick={() => setSteps(items => items.filter(item => item.id !== step.id).map(item => ({ ...item, dependsOn: item.dependsOn.filter(id => id !== step.id) })))}><Trash2 size={14} /></IconButton></div></article>)}
      <label>结束条件<select value={completion} onChange={event => setCompletion(event.target.value as 'manual' | 'all-tasks')}><option value="manual">由用户或获授权参与者结束</option><option value="all-tasks">全部已提交任务完成时结束</option></select></label>
      <details className="collaboration-advanced"><summary>运行限制 <span className="optional">由你决定，留空使用后台已声明的范围</span></summary><div className="collaboration-form-grid">{([{ key: 'maxConcurrentTasks', label: '并行任务上限' }, { key: 'maxTasks', label: '任务总数上限' }, { key: 'maxAttemptsPerTask', label: '任务尝试上限（含重试）' }, { key: 'maxTaskTurns', label: '每个任务运行时回合' }] as const).map(item => <label key={item.key}>{item.label}<input type="number" min={1} step={1} value={limits[item.key] ?? ''} onChange={event => setLimits(current => ({ ...current, [item.key]: event.target.value ? Number(event.target.value) : undefined }))} /></label>)}</div><p>一个运行时回合可能包含多次模型请求，回合上限不等于费用硬上限。原生用量、上下文占用、估算金额分别记录。外部会话未接入的费用不在平台记录范围内。</p></details>
      <div className="editor-actions"><button className="button" type="button" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={!valid || busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{run ? '保存新版本' : '保存并查看协作'}</button></div>
    </form>
  </section>;
}

interface GraphNodeData extends Record<string, unknown> { title: string; subtitle: string; detail?: string; kind: 'participant' | 'task' | 'artifact'; status?: string; external?: boolean }
type CollaborationNode = Node<GraphNodeData, 'collaboration'>;
type GraphSelection = { kind: 'participant' | 'task' | 'artifact' | 'event' | 'message' | 'relationship'; id: string } | { kind: 'events'; ids: string[] };
interface GraphEdgeData extends Record<string, unknown> { selection?: GraphSelection; configured?: boolean }
type CollaborationEdge = Edge<GraphEdgeData>;
function CollaborationNodeView({ data, selected, isConnectable }: NodeProps<CollaborationNode>) {
  return <div className={`collaboration-node node-${data.kind} ${selected ? 'selected' : ''}`}><Handle type="target" position={Position.Left} isConnectable={isConnectable} /><div className="collaboration-node-eyebrow">{data.kind === 'artifact' ? <FileText size={12} /> : data.kind === 'task' ? <GitBranch size={12} /> : <Network size={12} />}<span>{data.subtitle}</span></div><strong>{data.title}</strong>{data.detail && <p>{data.detail}</p>}<footer>{data.status && <Status value={data.status} />}{data.external && <span>外部连接</span>}</footer><Handle type="source" position={Position.Right} isConnectable={isConnectable} /></div>;
}
const nodeTypes = { collaboration: CollaborationNodeView };
const edgeFor = (id: string, source: string, target: string, label: string, selection?: GraphSelection, configured = false): CollaborationEdge => ({ id, source, target, label, type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: configured ? 'var(--dim)' : 'var(--muted)' }, style: { stroke: configured ? 'var(--dim)' : 'var(--muted)', strokeWidth: configured ? 1 : 1.25, ...(configured ? { strokeDasharray: '6 5' } : {}) }, labelStyle: { fill: configured ? 'var(--muted)' : 'var(--text)', fontSize: 11 }, labelBgStyle: { fill: 'var(--surface)', fillOpacity: 1 }, labelBgBorderRadius: 3, labelBgPadding: [7, 5], data: { selection, configured } });
const graphNode = (id: string, data: GraphNodeData): CollaborationNode => ({ id, type: 'collaboration', position: { x: 0, y: 0 }, data, width: 228, height: 118 });

function buildGraph(run: CollaborationRun, participants: CollaborationParticipant[], tasks: CollaborationTask[], messages: CollaborationMessage[], artifacts: CollaborationArtifactVersion[], events: CollaborationEvent[], view: 'relationships' | 'data', sessions: Session[]) {
  const nodes: CollaborationNode[] = [], edges: CollaborationEdge[] = [];
  if (view === 'relationships') {
    for (const participant of participants) {
      const active = tasks.filter(task => task.participantId === participant.id);
      const current = run.definitionSnapshot.participants.some(item => item.id === participant.id);
      const currentTask = active.find(task => ['running', 'waiting', 'queued'].includes(task.status));
      nodes.push(graphNode(participant.id, { kind: 'participant', title: participant.name, subtitle: participant.roles.join(' · ') || '角色未指定', detail: !current ? '历史参与者 · 当前配置已移除' : participant.mode === 'managed' ? [participant.providerId, participant.modelId].filter(Boolean).join(' · ') : '仅展示通过平台交换的记录', external: participant.mode === 'external', status: currentTask ? taskDisplayStatus(currentTask, sessions) : undefined }));
    }
    if (events.some(event => event.participantId === 'user' || event.targetParticipantId === 'user')) nodes.push(graphNode('user', { kind: 'participant', title: '用户', subtitle: '实际操作来源', detail: '平台界面中的操作' }));
    const ids = new Set(nodes.map(node => node.id));
    for (const relation of run.definitionSnapshot.relationships) if (ids.has(relation.from) && ids.has(relation.to)) edges.push(edgeFor(`configured-${relation.id}`, relation.from, relation.to, relation.label || relation.kind, { kind: 'relationship', id: relation.id }, true));
    const groups = new Map<string, { from: string; to: string; type: string; ids: string[] }>();
    for (const event of events) {
      if (!event.participantId || !event.targetParticipantId || !ids.has(event.participantId) || !ids.has(event.targetParticipantId)) continue;
      const key = `${event.participantId}:${event.targetParticipantId}:${event.type}`;
      const group = groups.get(key) ?? { from: event.participantId, to: event.targetParticipantId, type: event.type, ids: [] };
      group.ids.push(event.id); groups.set(key, group);
    }
    for (const [key, group] of groups) edges.push(edgeFor(`observed-${key}`, group.from, group.to, `${eventLabel[group.type] ?? group.type}${group.ids.length > 1 ? ` ×${group.ids.length}` : ''}`, { kind: 'events', ids: group.ids }));
  } else {
    for (const task of tasks) nodes.push(graphNode(`task-${task.id}`, { kind: 'task', title: task.title, subtitle: task.participantSnapshot.name, detail: `${task.attempts.length} 段执行 · 配置 v${task.definitionVersion}`, status: taskDisplayStatus(task, sessions) }));
    for (const artifact of artifacts) nodes.push(graphNode(`artifact-${artifact.id}`, { kind: 'artifact', title: artifact.name, subtitle: `产物 v${artifact.version} · ${artifact.kind}`, detail: artifact.sha256.slice(0, 16) }));
    const taskIds = new Set(tasks.map(task => task.id)), artifactIds = new Set(artifacts.map(artifact => artifact.id));
    for (const task of tasks) {
      for (const dependency of task.dependsOn) if (taskIds.has(dependency)) edges.push(edgeFor(`dependency-${dependency}-${task.id}`, `task-${dependency}`, `task-${task.id}`, '等待完成', { kind: 'task', id: task.id }, true));
      const inputs = new Set([...task.artifactIds, ...task.attempts.flatMap(attempt => attempt.inputArtifactIds)]);
      for (const artifactId of inputs) if (artifactIds.has(artifactId)) { const injected = events.some(event => event.type === 'artifact.injected' && event.taskId === task.id && event.artifactVersionId === artifactId); edges.push(edgeFor(`input-${artifactId}-${task.id}`, `artifact-${artifactId}`, `task-${task.id}`, injected ? '已注入输入' : '绑定输入', { kind: 'artifact', id: artifactId }, !injected)); }
    }
    for (const artifact of artifacts) if (artifact.taskId && taskIds.has(artifact.taskId)) edges.push(edgeFor(`output-${artifact.id}`, `task-${artifact.taskId}`, `artifact-${artifact.id}`, '发布产物', { kind: 'artifact', id: artifact.id }));
    for (const message of messages) if (message.taskId && message.targetTaskId && message.taskId !== message.targetTaskId && taskIds.has(message.taskId) && taskIds.has(message.targetTaskId)) edges.push(edgeFor(`message-${message.id}`, `task-${message.taskId}`, `task-${message.targetTaskId}`, deliveryLabel[message.delivery], { kind: 'message', id: message.id }));
  }
  return { nodes, edges };
}

interface CanvasNodeView {
  position?: { x: number; y: number };
  measured?: { width?: number; height?: number };
  selected?: boolean;
  dragging?: boolean;
}
interface CompletedLayout { id: number; key: string; positions: Map<string, { x: number; y: number }> }
interface CanvasView {
  nodes: Map<string, CanvasNodeView>;
  selectedEdgeId?: string;
  layout?: CompletedLayout;
  error: string;
}
function FitCompletedLayout({ layout }: { layout?: CompletedLayout }) {
  const reducedMotion = useReducedMotion();
  const nodes = useNodes<CollaborationNode>();
  const initialized = useNodesInitialized();
  const { fitView, viewportInitialized } = useReactFlow<CollaborationNode, CollaborationEdge>();
  const fitted = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!layout || fitted.current === layout.id || !initialized || !viewportInitialized) return;
    const committed = nodes.length === layout.positions.size && nodes.every(node => {
      const position = layout.positions.get(node.id);
      return position?.x === node.position.x && position.y === node.position.y;
    });
    if (!committed) return;
    fitted.current = layout.id;
    void fitView({ padding: 0.25, duration: reducedMotion ? 0 : 160 });
  }, [layout, nodes, initialized, viewportInitialized, fitView, reducedMotion]);
  return null;
}

function CollaborationCanvas({ graph, view, onSelect, onConnect }: { graph: ReturnType<typeof buildGraph>; view: string; onSelect: (selection: GraphSelection) => void; onConnect: (connection: Connection) => void }) {
  const { theme } = useAppearance();
  const [canvas, setCanvas] = useState<CanvasView>(() => ({ nodes: new Map(), error: '' }));
  const [revision, setRevision] = useState(0);
  const layoutId = useRef(0);
  const layoutKey = JSON.stringify([view, revision, graph.nodes.map(node => node.id), graph.edges.map(edge => [edge.id, edge.source, edge.target])]);
  const nodes = useMemo(() => graph.nodes.map(node => {
    const display = canvas.nodes.get(node.id);
    return { ...node, ...display, position: display?.position ?? node.position };
  }), [graph.nodes, canvas.nodes]);
  const edges = useMemo(() => graph.edges.map(edge => ({ ...edge, selected: edge.id === canvas.selectedEdgeId })), [graph.edges, canvas.selectedEdgeId]);
  const onNodesChange = (changes: NodeChange<CollaborationNode>[]) => setCanvas(current => {
    const display = new Map(current.nodes);
    for (const change of changes) {
      if (change.type === 'position') display.set(change.id, { ...display.get(change.id),
        ...(change.position ? { position: change.position } : {}), ...(change.dragging !== undefined ? { dragging: change.dragging } : {}) });
      else if (change.type === 'dimensions' && change.dimensions) display.set(change.id, { ...display.get(change.id), measured: change.dimensions });
      else if (change.type === 'select') display.set(change.id, { ...display.get(change.id), selected: change.selected });
    }
    return { ...current, nodes: display };
  });
  const onEdgesChange = (changes: EdgeChange<CollaborationEdge>[]) => setCanvas(current => {
    let selectedEdgeId = current.selectedEdgeId;
    for (const change of changes) if (change.type === 'select') {
      if (change.selected) selectedEdgeId = change.id;
      else if (selectedEdgeId === change.id) selectedEdgeId = undefined;
    }
    return { ...current, selectedEdgeId };
  });
  useEffect(() => {
    let active = true;
    setCanvas(current => ({ ...current, error: '' }));
    if (!graph.nodes.length) return;
    const elk = new ELK({ workerFactory: () => new ELKWorker() });
    void elk.layout({
      id: 'collaboration',
      layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.spacing.nodeNode': '44', 'elk.layered.spacing.nodeNodeBetweenLayers': '84' },
      children: graph.nodes.map(node => ({ id: node.id, width: node.width ?? 228, height: node.height ?? 118 })),
      edges: graph.edges.map(edge => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
    }).then(result => {
      if (!active) return;
      const positions = new Map(result.children?.map(node => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]));
      const completed: CompletedLayout = { id: ++layoutId.current, key: layoutKey, positions };
      setCanvas(current => ({
        ...current, error: '', layout: completed,
        nodes: new Map([...positions].map(([id, position]) => [id, { ...current.nodes.get(id), position }])),
      }));
    }).catch(reason => { if (active) setCanvas(current => ({ ...current, error: reason instanceof Error ? reason.message : String(reason) })); });
    return () => { active = false; elk.terminateWorker(); };
  }, [layoutKey]);
  return <div className="collaboration-canvas">
    <ReactFlow<CollaborationNode, CollaborationEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes}
      onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
      onNodeClick={(_, node) => onSelect({ kind: node.data.kind, id: node.data.kind === 'participant' ? node.id : node.id.replace(/^(task|artifact)-/, '') })}
      onEdgeClick={(_, edge) => edge.data?.selection && onSelect(edge.data.selection)}
      onConnect={onConnect} nodesConnectable={view === 'relationships'} deleteKeyCode={null}
      minZoom={0.05} maxZoom={1.8} colorMode={theme} aria-label={view === 'relationships' ? '参与者关系图' : '任务数据流图'}>
      <FitCompletedLayout layout={canvas.layout?.key === layoutKey ? canvas.layout : undefined} />
      <Background color="var(--border-strong)" gap={24} size={1} /><Controls showInteractive={false} />
    </ReactFlow>
    <div className="collaboration-canvas-tools"><button className="button small" onClick={() => setRevision(value => value + 1)}><RefreshCw size={12} />重新布局</button></div>
    {!graph.nodes.length && <div className="collaboration-canvas-empty">这里会显示实际任务和产物。</div>}
    {canvas.error && <div className="collaboration-graph-error" role="alert">布局失败：{canvas.error}</div>}
  </div>;
}

function CollaborationRunView({ run, state, stateVersion, providers, sessions, perform, pending, openSession, onEdit }: { run: CollaborationRun; state: PublicCollaborationState; stateVersion?: number; providers: ProviderInfo[]; sessions: Session[]; perform: Perform; pending: Set<string>; openSession: (id: string) => void; onEdit: () => void }) {
  const tasks = state.tasks.filter(item => item.runId === run.id), messages = state.messages.filter(item => item.runId === run.id), artifacts = state.artifacts.filter(item => item.runId === run.id);
  const [view, setView] = useState<'relationships' | 'data'>(run.definitionSnapshot.steps?.length ? 'data' : 'relationships');
  const [selection, setSelection] = useState<GraphSelection>();
  const [selectionOpen, setSelectionOpen] = useState(false);
  const selectRecord = (value: GraphSelection) => { setSelection(value); setSelectionOpen(true); };
  const [composer, setComposer] = useState<'task' | 'message' | 'artifact'>();
  const [connection, setConnection] = useState<Connection>();
  const [events, setEvents] = useState<CollaborationEvent[]>([]);
  const [eventError, setEventError] = useState('');
  const [more, setMore] = useState(false);
  const [timeline, setTimeline] = useState(true);
  const cursor = useRef(0), generation = useRef(0);
  const revision = [stateVersion, run.updatedAt, ...tasks.map(item => item.updatedAt), ...messages.map(item => `${item.id}:${item.delivery}`), artifacts.length].join('|');
  const loadEvents = async () => {
    const current = generation.current;
    try { const incoming = await window.workbench.queryCollaborationEvents(run.id, cursor.current, 500); if (generation.current !== current) return; cursor.current = incoming.at(-1)?.seq ?? cursor.current; setEvents(previous => [...new Map([...previous, ...incoming].map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq)); setMore(incoming.length === 500); setEventError(''); }
    catch (reason) { if (generation.current === current) setEventError(reason instanceof Error ? reason.message : String(reason)); }
  };
  useEffect(() => { void loadEvents(); return () => { generation.current++; }; }, [run.id, revision]);
  const participants = useMemo(() => recordedParticipants(run, state, events), [run, state, events]);
  const graph = useMemo(() => buildGraph(run, participants, tasks, messages, artifacts, events, view, sessions), [run, state, events, view, participants, sessions]);
  const control = (action: string) => void perform(`collaboration-control-${run.id}`, () => call('control_run', { requestId: requestId(), runId: run.id, action }));
  const busy = pending.has(`collaboration-control-${run.id}`);
  return <section className="collaboration-run-view"><div className="collaboration-run-heading"><div><div className="collaboration-heading-kicker"><Network size={12} />协作空间</div><h1>{run.definitionSnapshot.name}</h1><p title={run.definitionSnapshot.cwd}>{pathName(run.definitionSnapshot.cwd)}<span>配置 v{run.definitionVersion}</span><Status value={run.status} /></p></div><div className="collaboration-run-actions"><IconButton label="编辑参与者与协作配置" onClick={onEdit}><Settings2 size={16} /></IconButton>{run.status === 'draft' ? <button className="button primary small" disabled={busy} onClick={() => control('start')}><Play size={13} />开始协作</button> : run.status === 'running' ? <button className="button small" disabled={busy} onClick={() => control('pause')}><Pause size={13} />暂停新派工</button> : ['paused', 'interrupted', 'failed'].includes(run.status) ? <button className="button small" disabled={busy} onClick={() => control('resume')}><Play size={13} />继续</button> : null}{['running', 'paused'].includes(run.status) && <><button className="button small" disabled={busy || tasks.some(task => ['running', 'queued', 'waiting', 'pending'].includes(task.status))} onClick={() => control('finish')}><Check size={13} />结束</button><IconButton label="停止本次协作" disabled={busy} onClick={() => control('cancel')}><Square size={14} /></IconButton></>}</div></div>
    {run.status === 'draft' && <section className="collaboration-launch-plan" aria-label="开始前确认"><SetupSteps current={3} /><div className="collaboration-launch-summary"><div><strong>配置已保存，尚未执行</strong><p>{tasks.length ? `${tasks.length} 项任务将按依赖执行，完成后可打开对应会话查看输出。` : '开始后可以派发任务，也可以继续编辑预设任务。'} 同一项目顺序执行。</p></div><div className="collaboration-launch-participants">{run.definitionSnapshot.participants.map(participant => <span key={participant.id}><strong>{participant.name}</strong><small>{participant.mode === 'external' ? '外部 Agent · 平台内' : providers.find(provider => provider.id === participant.providerId)?.name ?? participant.providerId} · {participant.permissions.workspace?.access === 'read-only' || participant.settings?.permission === 'read-only' ? '只读' : '可读写'}</small></span>)}</div></div></section>}
    <div className="collaboration-toolbar"><div className="collaboration-view-switch" role="tablist" aria-label="协作视图"><button role="tab" aria-selected={view === 'relationships'} className={view === 'relationships' ? 'active' : ''} onClick={() => setView('relationships')}><Network size={14} />参与者关系</button><button role="tab" aria-selected={view === 'data'} className={view === 'data' ? 'active' : ''} onClick={() => setView('data')}><GitBranch size={14} />任务与数据流</button></div><div className="collaboration-toolbar-actions"><button className="button small" onClick={() => setComposer('task')}><Plus size={13} />派发任务</button><button className="button small" onClick={() => setComposer('artifact')}><FileText size={13} />发布资料</button><IconButton label="发送协作消息" onClick={() => setComposer('message')}><MessageSquare size={15} /></IconButton><IconButton label={selectionOpen ? '收起记录详情' : '展开记录详情'} disabled={!selection} aria-expanded={selectionOpen} onClick={() => setSelectionOpen(value => !value)}><PanelRight size={15} /></IconButton></div></div>
    <div className="collaboration-legend"><span><i className="configured" />配置关系 / 执行依赖</span><span><i />实际操作 / 资料引用</span><span>{tasks.length} 个任务 · {artifacts.length} 个产物版本</span>{view === 'relationships' && <small>拖动节点连接点可添加配置关系</small>}</div>
    {run.error && <div className="collaboration-inline-error">{run.error}</div>}
    <div className={`collaboration-graph-body ${selectionOpen ? 'with-selection' : ''}`}><CollaborationCanvas graph={graph} view={view} onSelect={selectRecord} onConnect={value => { if (value.source !== value.target && run.definitionSnapshot.participants.some(item => item.id === value.source) && run.definitionSnapshot.participants.some(item => item.id === value.target)) setConnection(value); }} />{selection && <SelectionPanel selection={selection} open={selectionOpen} sessions={sessions} run={run} participants={participants} tasks={tasks} messages={messages} artifacts={artifacts} events={events} providers={providers} openSession={openSession} perform={perform} pending={pending} onSelect={selectRecord} onClose={() => setSelectionOpen(false)} />}</div>
    <div className={`collaboration-timeline ${timeline ? 'expanded' : ''}`}>
      <button className="collaboration-timeline-heading" onClick={() => setTimeline(value => !value)} aria-expanded={timeline} aria-controls={`collaboration-events-${run.id}`}><ChevronRight size={13} /><strong>运行时间线</strong><span>{events.length} 条已加载记录</span></button>
      <div className="collaboration-timeline-content" data-open={timeline} aria-hidden={!timeline} inert={!timeline} id={`collaboration-events-${run.id}`}><div className="collaboration-timeline-clip"><div className="collaboration-timeline-events">
        <div className="collaboration-timeline-list">{events.map(event => <button key={event.id} className={selection?.kind === 'event' && selection.id === event.id ? 'selected' : ''} onClick={() => selectRecord({ kind: 'event', id: event.id })}>
          <span className="collaboration-event-marker" aria-hidden="true">{eventStatus(event) ? <Status value={eventStatus(event)!} /> : <span className="event-dot" />}</span><span className="event-sequence">#{event.seq}</span><time>{new Date(event.createdAt).toLocaleTimeString('zh-CN')}</time><strong>{eventLabel[event.type] ?? event.type}</strong><span className="event-participants">{participantName(run, event.participantId)}{event.targetParticipantId ? ` → ${participantName(run, event.targetParticipantId)}` : ''}</span>{event.source === 'external' && <small>外部上报</small>}
        </button>)}</div>
        {!events.length && !eventError && <p>还没有运行事件。</p>}{more && <button className="text-button" onClick={() => void perform('collaboration-load-events', loadEvents)}>加载后续事件</button>}{eventError && <p className="collaboration-inline-error">{eventError}<button className="text-button" onClick={() => void loadEvents()}>重试读取</button></p>}
      </div></div></div>
    </div>
    {composer && <RunComposer kind={composer} run={run} tasks={tasks} artifacts={artifacts} perform={perform} pending={pending} onClose={() => setComposer(undefined)} />}
    {connection?.source && connection.target && <RelationshipDialog run={run} from={connection.source} to={connection.target} perform={perform} pending={pending} onClose={() => setConnection(undefined)} />}
  </section>;
}

function DetailField({ label, children }: { label: string; children: ReactNode }) { return <div className="collaboration-detail-field"><span>{label}</span><div>{children}</div></div>; }
function ArtifactFileContent({ artifact, perform, pending }: { artifact: CollaborationArtifactVersion; perform: Perform; pending: Set<string> }) {
  const [loaded, setLoaded] = useState<CollaborationArtifactVersion>();
  const key = `collaboration-read-artifact-${artifact.id}`;
  return loaded ? loaded.content !== undefined ? <DetailField label="文件内容"><pre>{loaded.content}</pre></DetailField> : <p className="collaboration-observation-note">文件副本已校验。此产物不提供文本预览。</p> : <button className="button small" disabled={pending.has(key)} onClick={() => void perform(key, async () => setLoaded(await call('get_artifact', { runId: artifact.runId, artifactVersionId: artifact.id }) as CollaborationArtifactVersion))}>{pending.has(key) ? <LoaderCircle className="spin" size={12} /> : <FileText size={12} />}读取并校验文件副本</button>;
}
function SelectionPanel({ selection, open, sessions, run, participants, tasks, messages, artifacts, events, providers, openSession, perform, pending, onSelect, onClose }: {
  selection: GraphSelection; open: boolean; sessions: Session[]; run: CollaborationRun; participants: CollaborationParticipant[]; tasks: CollaborationTask[]; messages: CollaborationMessage[]; artifacts: CollaborationArtifactVersion[]; events: CollaborationEvent[]; providers: ProviderInfo[]; openSession: (id: string) => void; perform: Perform; pending: Set<string>; onSelect: (selection: GraphSelection) => void; onClose: () => void;
}) {
  const participant = selection.kind === 'participant' ? participants.find(item => item.id === selection.id) : undefined;
  const task = selection.kind === 'task' ? tasks.find(item => item.id === selection.id) : undefined;
  const artifact = selection.kind === 'artifact' ? artifacts.find(item => item.id === selection.id) : undefined;
  const message = selection.kind === 'message' ? messages.find(item => item.id === selection.id) : undefined;
  const relation = selection.kind === 'relationship' ? run.definitionSnapshot.relationships.find(item => item.id === selection.id) : undefined;
  const selectedEvents = selection.kind === 'event' ? events.filter(item => item.id === selection.id) : selection.kind === 'events' ? events.filter(item => selection.ids.includes(item.id)) : [];
  const artifactLink = (id: string) => { const item = artifacts.find(value => value.id === id); return <button className="collaboration-detail-link" key={id} onClick={() => onSelect({ kind: 'artifact', id })}><FileText size={12} />{item ? `${item.name} · v${item.version}` : id}<ArrowUpRight size={12} /></button>; };
  const title = participant?.name ?? task?.title ?? artifact?.name ?? (message ? '协作消息' : relation ? '配置关系' : selectedEvents.length ? '实际运行记录' : '记录详情');
  return <aside className="collaboration-selection" aria-label="协作记录详情" data-open={open} aria-hidden={!open} inert={!open}><header><strong>{title}</strong><IconButton label="关闭记录详情" onClick={onClose}><X size={15} /></IconButton></header><div className="collaboration-selection-scroll">
    {participant && <><DetailField label="角色">{participant.roles.join(' · ') || '未指定'}</DetailField><DetailField label="接入方式">{participant.mode === 'external' ? '外部 MCP 参与者' : '平台托管'}</DetailField>{participant.providerId && <DetailField label="运行时 / 模型">{providers.find(item => item.id === participant.providerId)?.name ?? participant.providerId}{participant.modelId ? ` · ${modelName(providers.find(item => item.id === participant.providerId), participant.modelId)}` : ''}</DetailField>}<DetailField label="职责">{participant.instructions || '未填写'}</DetailField><DetailField label="权限"><div className="collaboration-permission-summary">{Object.entries({ '派发任务': participant.permissions.submitTasks, '发送消息': participant.permissions.sendMessages, '发布产物': participant.permissions.publishArtifacts, '调整配置': participant.permissions.configureRun }).map(([label, allowed]) => <span key={label}>{allowed ? '允许' : '未授权'}{label}</span>)}<span>文件：{participant.permissions.workspace?.access === 'read-write' ? '可读写授权目录' : '只读'}</span></div></DetailField>{participant.mode === 'external' && <p className="collaboration-observation-note">此处只展示平台收到的消息、任务与结果。外部原聊天和未上报的工具操作不在记录范围内。</p>}<DetailField label="任务">{tasks.filter(item => item.participantId === participant.id).map(item => <button key={item.id} className="collaboration-detail-link" onClick={() => onSelect({ kind: 'task', id: item.id })}>{item.title}<Status value={taskDisplayStatus(item, sessions)} /></button>)}</DetailField></>}
    {task && <><DetailField label="负责参与者">{task.participantSnapshot.name} · 配置 v{task.definitionVersion}</DetailField><DetailField label="任务状态"><Status value={taskDisplayStatus(task, sessions)} /></DetailField><DetailField label="任务要求"><pre>{task.prompt}</pre></DetailField>{task.error && <p className="collaboration-inline-error">{task.error}</p>}<DetailField label="输入资料">{task.artifactIds.length ? task.artifactIds.map(artifactLink) : '未绑定产物版本'}</DetailField>{task.result && <DetailField label="结果"><pre>{task.result}</pre></DetailField>}{task.sessionId && <button className="button small" onClick={() => openSession(task.sessionId!)}><MessageSquare size={13} />打开真实会话<ArrowUpRight size={13} /></button>}<DetailField label="执行尝试">{task.attempts.length ? task.attempts.map((attempt, index) => <div className="collaboration-attempt" key={attempt.id}><strong>{attempt.continuationOf ? '续聊' : attempt.retryOf ? '失败后重试' : '执行'} · 第 {index + 1} 段 <Status value={attempt.status === 'running' ? taskDisplayStatus(task, sessions) : attempt.status} /></strong><time>{dateLabel(attempt.startedAt)}{attempt.physicalTurns !== undefined ? ` · ${attempt.physicalTurns} 个运行时回合` : ''}</time>{attempt.nativeId && <code title={attempt.nativeId}>nativeId: {attempt.nativeId}</code>}{attempt.error && <p>{attempt.error}</p>}{attempt.inputArtifactIds.map(artifactLink)}{attempt.outputArtifactIds.map(artifactLink)}{attempt.sessionId && attempt.sessionId !== task.sessionId && <button className="text-button" onClick={() => openSession(attempt.sessionId!)}>查看此次会话</button>}</div>) : '尚未执行'}</DetailField>{['running', 'queued', 'waiting', 'pending'].includes(task.status) && <button className="button small" disabled={pending.has(`collaboration-task-${task.id}`)} onClick={() => void perform(`collaboration-task-${task.id}`, () => call('control_task', { requestId: requestId(), runId: run.id, taskId: task.id, action: 'cancel' }))}><Square size={12} />停止此任务</button>}{['failed', 'cancelled', 'interrupted'].includes(task.status) && <button className="button small" disabled={pending.has(`collaboration-task-${task.id}`)} onClick={() => void perform(`collaboration-task-${task.id}`, () => call('control_task', { requestId: requestId(), runId: run.id, taskId: task.id, action: 'retry' }))}><RefreshCw size={12} />重试此任务</button>}</>}
    {artifact && <><DetailField label="版本">v{artifact.version} · {artifact.kind}</DetailField><DetailField label="发布者">{participantName(run, artifact.participantId)}</DetailField><DetailField label="版本 ID"><code>{artifact.id}</code></DetailField><DetailField label="SHA256"><code>{artifact.sha256}</code></DetailField>{artifact.revision && <DetailField label="文件 revision"><code>{artifact.revision}</code></DetailField>}<DetailField label="发布时间">{dateLabel(artifact.createdAt)}</DetailField>{artifact.taskId && <button className="collaboration-detail-link" onClick={() => onSelect({ kind: 'task', id: artifact.taskId! })}><GitBranch size={12} />查看生产任务<ArrowUpRight size={12} /></button>}{artifact.path && <DetailField label="导入文件"><code>{artifact.path}</code></DetailField>}{artifact.content !== undefined && <DetailField label="内容"><pre>{artifact.content}</pre></DetailField>}<DetailField label="使用此版本的任务">{tasks.filter(item => item.artifactIds.includes(artifact.id) || item.attempts.some(attempt => attempt.inputArtifactIds.includes(artifact.id))).map(item => <button className="collaboration-detail-link" key={item.id} onClick={() => onSelect({ kind: 'task', id: item.id })}>{item.title}<ArrowUpRight size={12} /></button>)}</DetailField></>}
    {artifact?.path && artifact.content === undefined && <ArtifactFileContent key={artifact.id} artifact={artifact} perform={perform} pending={pending} />}
    {message && <><DetailField label="传递方向">{participantName(run, message.fromParticipantId)} → {participantName(run, message.toParticipantId)}</DetailField><DetailField label="投递状态">{deliveryLabel[message.delivery]}{message.source === 'external' ? ' · 外部上报' : ''}</DetailField><DetailField label="消息"><pre>{message.text}</pre></DetailField>{message.artifactIds.map(artifactLink)}{message.error && <p className="collaboration-inline-error">{message.error}</p>}</>}
    {relation && <><DetailField label="用户配置">{participantName(run, relation.from)} → {participantName(run, relation.to)}</DetailField><DetailField label="关系说明">{relation.label || relation.kind}</DetailField><p className="collaboration-observation-note">这条线表达协作安排。实际任务与资料传递会产生独立记录。</p><button className="button small" disabled={pending.has(`collaboration-relation-${relation.id}`)} onClick={() => void perform(`collaboration-relation-${relation.id}`, async () => { await call('update_run', { requestId: requestId(), runId: run.id, expectedVersion: run.definitionVersion, relationships: run.definitionSnapshot.relationships.filter(item => item.id !== relation.id) }); onClose(); })}><Trash2 size={12} />删除此配置关系</button></>}
    {selectedEvents.map(event => <article className="collaboration-event-detail" key={event.id}><h3>#{event.seq} {eventLabel[event.type] ?? event.type}</h3><time>{dateLabel(event.createdAt)}</time><DetailField label="来源">{participantName(run, event.participantId)}{event.targetParticipantId ? ` → ${participantName(run, event.targetParticipantId)}` : ''} · {event.source === 'external' ? '外部上报' : event.source === 'managed' ? '托管运行时' : '平台记录'}</DetailField>{event.taskId && <button className="collaboration-detail-link" onClick={() => onSelect({ kind: 'task', id: event.taskId! })}>查看任务<ArrowUpRight size={12} /></button>}{event.messageId && <button className="collaboration-detail-link" onClick={() => onSelect({ kind: 'message', id: event.messageId! })}>查看实际消息<ArrowUpRight size={12} /></button>}{event.artifactVersionId && artifactLink(event.artifactVersionId)}{event.cause && <DetailField label="前序操作"><code>{event.cause}</code></DetailField>}<DetailField label="事件内容"><pre>{JSON.stringify(event.data, null, 2)}</pre></DetailField></article>)}
    {selection.kind === 'participant' && selection.id === 'user' && <p className="collaboration-observation-note">平台界面中的用户操作。角色和权限由用户配置。</p>}
  </div></aside>;
}

function RunComposer({ kind, run, tasks, artifacts, perform, pending, onClose }: { kind: 'task' | 'message' | 'artifact'; run: CollaborationRun; tasks: CollaborationTask[]; artifacts: CollaborationArtifactVersion[]; perform: Perform; pending: Set<string>; onClose: () => void }) {
  const [participantId, setParticipantId] = useState(run.definitionSnapshot.participants[0]?.id ?? '');
  const [title, setTitle] = useState(''), [text, setText] = useState(''), [path, setPath] = useState('');
  const [artifactMode, setArtifactMode] = useState<'text' | 'file'>('text');
  const [artifactIds, setArtifactIds] = useState<string[]>([]), [dependsOn, setDependsOn] = useState<string[]>([]);
  const busy = pending.has(`collaboration-compose-${run.id}`);
  const labels = { task: '派发任务', message: '发送协作消息', artifact: '发布资料' };
  const valid = kind === 'artifact' ? Boolean(title.trim() && (artifactMode === 'text' ? text.trim() : path.trim())) : Boolean(participantId && text.trim() && (kind !== 'task' || title.trim()));
  return <Modal title={labels[kind]} subtitle={kind === 'artifact' ? '发布后保存为独立版本，任务按版本引用。' : '操作将进入本次协作的真实运行记录。'} busy={busy} onClose={onClose}><form onSubmit={event => { event.preventDefault(); if (!valid || busy) return; void perform(`collaboration-compose-${run.id}`, async () => { const base = { requestId: requestId(), runId: run.id }; if (kind === 'task') await call('submit_task', { ...base, participantId, title: title.trim(), prompt: text.trim(), dependsOn, artifactIds }); else if (kind === 'message') await call('send_message', { ...base, toParticipantId: participantId, text: text.trim(), kind: 'message', artifactIds }); else await call('publish_artifact', { ...base, name: title.trim(), kind: artifactMode === 'text' ? 'document' : 'file', ...(artifactMode === 'text' ? { content: text } : { path: path.trim() }) }); onClose(); }); }}>
    {kind !== 'message' && <label>{kind === 'task' ? '任务名称' : '资料名称'}<input value={title} required onChange={event => setTitle(event.target.value)} autoFocus /></label>}
    {kind !== 'artifact' && <label>{kind === 'task' ? '负责参与者' : '接收者'}<select value={participantId} onChange={event => setParticipantId(event.target.value)}>{run.definitionSnapshot.participants.map(item => <option key={item.id} value={item.id}>{item.name}{item.roles.length ? ` · ${item.roles.join(' / ')}` : ''}</option>)}</select></label>}
    {kind === 'artifact' && <div className="collaboration-view-switch"><button type="button" className={artifactMode === 'text' ? 'active' : ''} onClick={() => setArtifactMode('text')}>填写内容</button><button type="button" className={artifactMode === 'file' ? 'active' : ''} onClick={() => setArtifactMode('file')}>导入文件</button></div>}
    {kind !== 'artifact' || artifactMode === 'text' ? <label>{kind === 'task' ? '任务、范围与验收条件' : kind === 'message' ? '消息内容' : '资料内容'}<textarea value={text} required rows={6} onChange={event => setText(event.target.value)} /></label> : <label>授权目录内的文件路径<input value={path} required onChange={event => setPath(event.target.value)} placeholder={`${run.definitionSnapshot.cwd}/方案.md`} /><small>后台会读取并保存不可变副本。</small></label>}
    {kind === 'task' && tasks.length > 0 && <fieldset className="collaboration-check-list"><legend>等待任务</legend>{tasks.map(task => <label key={task.id}><input type="checkbox" checked={dependsOn.includes(task.id)} onChange={event => setDependsOn(ids => event.target.checked ? [...ids, task.id] : ids.filter(id => id !== task.id))} />{task.title}</label>)}</fieldset>}
    {kind !== 'artifact' && artifacts.length > 0 && <fieldset className="collaboration-check-list"><legend>输入资料版本</legend>{artifacts.map(artifact => <label key={artifact.id}><input type="checkbox" checked={artifactIds.includes(artifact.id)} onChange={event => setArtifactIds(ids => event.target.checked ? [...ids, artifact.id] : ids.filter(id => id !== artifact.id))} />{artifact.name} · v{artifact.version}<code>{artifact.sha256.slice(0, 8)}</code></label>)}</fieldset>}
    <div className="modal-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={!valid || busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{labels[kind]}</button></div>
  </form></Modal>;
}

function RelationshipDialog({ run, from, to, perform, pending, onClose }: { run: CollaborationRun; from: string; to: string; perform: Perform; pending: Set<string>; onClose: () => void }) {
  const [kind, setKind] = useState(''); const busy = pending.has('collaboration-add-relationship');
  return <Modal title="添加配置关系" subtitle={`${participantName(run, from)} → ${participantName(run, to)}`} busy={busy} onClose={onClose}><form onSubmit={event => { event.preventDefault(); if (!kind.trim() || busy) return; void perform('collaboration-add-relationship', async () => { await call('update_run', { requestId: requestId(), runId: run.id, expectedVersion: run.definitionVersion, relationships: [...run.definitionSnapshot.relationships, { id: requestId(), from, to, kind: kind.trim() }] }); onClose(); }); }}><label>关系说明<input autoFocus value={kind} onChange={event => setKind(event.target.value)} placeholder="由你定义，例如：提交方案、交付实现" required /></label><p className="collaboration-observation-note">保存协作安排。实际传递的数据会单独记录。</p><div className="modal-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={!kind.trim() || busy}>保存关系</button></div></form></Modal>;
}

interface IdentityConfiguration { identity: { id: string; name: string }; configuration: Extract<McpServerConfig, { type: 'stdio' }>; http: { url: string; headers: Record<string, string> } }
function connectionText(issued: IdentityConfiguration, client: string) {
  const server = issued.configuration;
  if (client === 'codex') return [`[mcp_servers.workbench]`, `command = ${JSON.stringify(server.command)}`, `args = ${JSON.stringify(server.args)}`, '', '[mcp_servers.workbench.env]', ...Object.entries(server.env ?? {}).map(([key, value]) => `${key} = ${JSON.stringify(value)}`)].join('\n');
  if (client === 'opencode') return JSON.stringify({ mcp: { workbench: { type: 'local', command: [server.command, ...server.args], environment: server.env, enabled: true, codemode: false } } }, null, 2);
  if (client === 'deepseek-harness') return ['- id: mcp-workbench', "  name: '@deepseek-ai/dsh-mcp-client'", '  config:', '    serverName: workbench', '    transport: stdio', `    command: ${JSON.stringify(server.command)}`, `    args: ${JSON.stringify(server.args)}`, '    env:', ...Object.entries(server.env ?? {}).map(([key, value]) => `      ${key}: ${JSON.stringify(value)}`)].join('\n');
  if (client === 'http') return JSON.stringify({ mcpServers: { workbench: { type: 'http', url: issued.http.url, headers: issued.http.headers } } }, null, 2);
  return JSON.stringify({ mcpServers: { workbench: { type: 'stdio', command: server.command, args: server.args, env: server.env } } }, null, 2);
}
function ConnectionDialog({ providers, state, initialCwd, perform, pending, onClose }: { providers: ProviderInfo[]; state?: PublicCollaborationState; initialCwd: string; perform: Perform; pending: Set<string>; onClose: () => void }) {
  const [name, setName] = useState(''), [roots, setRoots] = useState(initialCwd), [createRuns, setCreateRuns] = useState(true);
  const [providerIds, setProviderIds] = useState(providers.filter(item => item.available).map(item => item.id));
  const [issued, setIssued] = useState<IdentityConfiguration>(), [client, setClient] = useState('claude'), [copied, setCopied] = useState(false);
  const busy = pending.has('collaboration-issue-identity');
  return <Modal title="Agent MCP 接入" subtitle="给外部 Agent 签发独立身份，授权范围由你指定。" busy={busy} onClose={onClose}>{issued ? <div className="collaboration-connection-result"><p>已创建「{issued.identity.name}」。下面包含接入凭据，只在本次窗口展示，请保存到自己的 Agent 配置。</p><label>客户端格式<select value={client} onChange={event => { setClient(event.target.value); setCopied(false); }}><option value="claude">Claude Code / 通用 stdio JSON</option><option value="codex">Codex TOML</option><option value="opencode">OpenCode JSON</option><option value="deepseek-harness">DeepSeek Harness YAML overlay</option><option value="http">通用 Streamable HTTP JSON</option></select></label><pre>{connectionText(issued, client)}</pre><button className="button" onClick={() => void perform('collaboration-copy-config', async () => { await navigator.clipboard.writeText(connectionText(issued, client)); setCopied(true); })}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制' : '复制配置'}</button><p className="collaboration-observation-note">在原客户端加载配置后，Agent 通过 MCP 发起协作。是否自动唤醒原会话，取决于客户端能力。</p><div className="modal-actions"><button className="button primary" onClick={onClose}>已保存，关闭</button></div></div> : <><form onSubmit={event => { event.preventDefault(); if (!name.trim() || !splitRoots(roots).length || busy) return; void perform('collaboration-issue-identity', async () => { setIssued(await call('issue_identity', { name: name.trim(), policy: { createRuns, workspaceRoots: splitRoots(roots), providerIds } }) as IdentityConfiguration); }); }}><label>身份名称<input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="例如：我的终端 Agent" required /></label><label>授权项目目录<textarea rows={2} value={roots} onChange={event => setRoots(event.target.value)} placeholder="每行一个绝对路径" required /></label><label className="collaboration-checkbox"><input type="checkbox" checked={createRuns} onChange={event => setCreateRuns(event.target.checked)} />允许创建协作运行</label><fieldset className="collaboration-check-list"><legend>允许调用的平台运行时</legend>{providers.map(provider => <label key={provider.id}><input type="checkbox" checked={providerIds.includes(provider.id)} onChange={event => setProviderIds(ids => event.target.checked ? [...ids, provider.id] : ids.filter(id => id !== provider.id))} />{provider.name}</label>)}</fieldset><div className="modal-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={!name.trim() || !splitRoots(roots).length || busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <KeyRound size={14} />}签发接入配置</button></div></form>{Boolean(state?.identities.length) && <div className="collaboration-identities"><h3>已有接入身份</h3>{state!.identities.map(identity => <div key={identity.id}><span><strong>{identity.name}</strong><small>{identity.revokedAt ? '已撤销' : '有效'}</small></span>{!identity.revokedAt && <button className="text-button" disabled={pending.has(`collaboration-revoke-${identity.id}`)} onClick={() => void perform(`collaboration-revoke-${identity.id}`, () => call('revoke_identity', { identityId: identity.id }))}>撤销</button>}</div>)}</div>}</>}</Modal>;
}
