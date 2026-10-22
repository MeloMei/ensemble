import { useState, type FormEvent } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowUpRight, Check, Copy, CircleAlert, CircleStop, Folder, FolderOpen, GitBranch, LoaderCircle, MessageSquare, Plug, Plus, RefreshCw, ShieldCheck, TerminalSquare, Trash2, X } from 'lucide-react';
import type { ProviderInfo, Session, Snapshot, Workflow, WorkflowInput, WorkflowStep, WorkflowStepInput } from '../shared/types';
import { DirectoryField, IconButton, Modal, ModelField, ProviderSelect, Status, defaultModelId, labels, modelName, modelPolicy, validModelSelection, type Perform } from './ui';
import { motionMessageFadeUp } from './vendor/open-claude-ui/ClaudeMotionPresets';
import './WorkflowViews.css';

function makeStep(provider: ProviderInfo | undefined, previous?: string): WorkflowStepInput {
  return { id: crypto.randomUUID(), title: '', providerId: provider?.id ?? '', modelId: defaultModelId(provider),
    prompt: '', dependsOn: previous ? [previous] : [] };
}

export function WorkflowEditor({ providers, perform, pending, onClose, onCreated }: { providers: ProviderInfo[]; perform: Perform; pending: Set<string>; onClose: () => void; onCreated: (id: string) => void }) {
  const reducedMotion = useReducedMotion();
  const defaultProvider = providers.find(provider => provider.available);
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [steps, setSteps] = useState<WorkflowStepInput[]>(() => [makeStep(defaultProvider)]);
  const updateStep = (id: string, patch: Partial<WorkflowStepInput>) => setSteps(current => current.map(step => step.id === id ? { ...step, ...patch } : step));
  const busy = pending.has('create-workflow');
  const valid = Boolean(name.trim() && cwd.trim() && steps.length > 0 && steps.every(step =>
    step.title.trim() && step.prompt.trim() && validModelSelection(providers.find(provider => provider.id === step.providerId), step.modelId)));
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    const input: WorkflowInput = { name: name.trim(), cwd: cwd.trim(), steps: steps.map(step => ({ ...step, title: step.title.trim(), prompt: step.prompt.trim() })) };
    void perform('create-workflow', async () => onCreated(await window.workbench.createWorkflow(input)));
  };
  return <section className="workflow-detail">
    <div className="detail-heading"><div><h1>新建编排</h1><p className="heading-description">先保存步骤，再手动开始执行。</p></div><IconButton label="取消新建" disabled={busy} onClick={onClose}><X size={18} /></IconButton></div>
    <form className="workflow-editor scroll-content" onSubmit={save}>
      <div className="workflow-settings"><label>编排名称<input value={name} onChange={event => setName(event.target.value)} placeholder="例如：分析、实现与检查" required autoFocus /></label><label>项目目录<DirectoryField value={cwd} onChange={setCwd} perform={perform} /></label></div>
      <div className="section-label">任务步骤<span>后续步骤会收到依赖步骤的结果</span></div>
      <div className="workflow-steps">{steps.map((step, index) => {
        const provider = providers.find(item => item.id === step.providerId);
        return <motion.div className="step-editor" key={step.id} variants={motionMessageFadeUp} initial={reducedMotion ? false : 'initial'} animate="animate">
          <div className="step-editor-heading"><span className="step-number">{String(index + 1).padStart(2, '0')}</span><strong>步骤 {index + 1}</strong><IconButton label={`删除步骤 ${index + 1}`} disabled={steps.length === 1 || busy} onClick={() => setSteps(current => current.filter(item => item.id !== step.id).map(item => ({ ...item, dependsOn: item.dependsOn.filter(id => id !== step.id) })))}><Trash2 size={15} /></IconButton></div>
          <div className="step-fields"><label>标题<input value={step.title} onChange={event => updateStep(step.id, { title: event.target.value })} placeholder="这个步骤要完成什么" required /></label><label>智能体<ProviderSelect providers={providers} value={step.providerId} onChange={providerId => updateStep(step.id, { providerId, modelId: defaultModelId(providers.find(item => item.id === providerId)) })} /></label></div>
          <ModelField provider={provider} value={step.modelId} disabled={busy} onChange={modelId => updateStep(step.id, { modelId })} />
          <label>任务<textarea value={step.prompt} onChange={event => updateStep(step.id, { prompt: event.target.value })} placeholder="写清目标、范围和完成条件" rows={3} required /></label>
          <div className="dependency-field"><span>等待步骤</span>{steps.length === 1 ? <span className="muted">没有前序步骤</span> : steps.filter(item => item.id !== step.id).map(item => <label className="dependency-option" key={item.id}><input type="checkbox" checked={step.dependsOn.includes(item.id)} onChange={event => updateStep(step.id, { dependsOn: event.target.checked ? [...step.dependsOn, item.id] : step.dependsOn.filter(id => id !== item.id) })} /><span>{item.title || `步骤 ${steps.indexOf(item) + 1}`}</span></label>)}</div>
        </motion.div>;
      })}</div>
      <button type="button" className="add-step" disabled={busy} onClick={() => setSteps(current => [...current, makeStep(defaultProvider, current.at(-1)?.id)])}><Plus size={15} />添加步骤</button>
      <div className="editor-actions"><button type="button" className="button" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={!valid || busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}保存编排</button></div>
    </form>
  </section>;
}

function stepDisplayStatus(step: WorkflowStep, sessions: Session[]) {
  const session = sessions.find(item => item.id === step.sessionId);
  return step.status === 'running' && session && ['queued', 'running', 'waiting_approval', 'waiting_children'].includes(session.status) ? session.status : step.status;
}

export function WorkflowView({ workflow, providers, sessions = [], perform, pending, openSession, openWorkflow }: {
  workflow: Workflow; providers: ProviderInfo[]; sessions?: Session[]; perform: Perform; pending: Set<string>;
  openSession: (id: string) => void; openWorkflow?: (id: string) => void;
}) {
  const reducedMotion = useReducedMotion();
  const completed = workflow.steps.filter(step => step.status === 'completed').length;
  const displayedSteps = workflow.steps.map(step => ({ step, status: stepDisplayStatus(step, sessions) }));
  const [resumeConfirmed, setResumeConfirmed] = useState(false);
  const resumable = ['failed', 'cancelled', 'interrupted'].includes(workflow.status);
  const resume = () => void perform(`resume-${workflow.id}`, async () => {
    await window.workbench.resumeWorkflow(workflow.id); setResumeConfirmed(false);
  });
  return <section className="workflow-detail">
    <div className="detail-heading">
      <div className="heading-text"><h1>{workflow.name}</h1><div className="detail-meta"><span title={workflow.cwd}><Folder size={12} />{workflow.cwd.split('/').filter(Boolean).pop()}</span><Status value={workflow.status} /></div></div>
      <div className="heading-actions">
        <button className="button small" disabled={pending.has(`clone-${workflow.id}`)} onClick={() => void perform(`clone-${workflow.id}`, async () => {
          const id = await window.workbench.cloneWorkflow(workflow.id); openWorkflow?.(id);
        })}><Copy size={14} />复制为新编排</button>
        {workflow.status === 'draft' && <button className="button primary small" disabled={pending.has(`start-${workflow.id}`)} onClick={() => void perform(`start-${workflow.id}`, () => window.workbench.startWorkflow(workflow.id))}>{pending.has(`start-${workflow.id}`) ? <LoaderCircle className="spin" size={14} /> : <ArrowUpRight size={14} />}开始执行</button>}
        {workflow.status === 'running' && <button className="button danger small" disabled={pending.has(`stop-${workflow.id}`)} onClick={() => void perform(`stop-${workflow.id}`, () => window.workbench.cancelWorkflow(workflow.id))}><CircleStop size={14} />停止编排</button>}
      </div>
    </div>
    <div className="workflow-run scroll-content">
      <div className="run-overview"><div><span className="eyebrow">执行进度</span><p><strong>{completed}</strong><span>/ {workflow.steps.length} 个步骤完成</span></p></div><div className="run-progress" role="progressbar" aria-label="编排进度" aria-valuemin={0} aria-valuemax={workflow.steps.length} aria-valuenow={completed}>{displayedSteps.map(({ step, status }) => <span key={step.id} className={`progress-${status}`} title={`${step.title}：${labels[status]}`} />)}</div></div>
      {workflow.status === 'draft' && <div className="info-note"><GitBranch size={16} />准备就绪。开始后，没有依赖的步骤会先执行，后续步骤等待前序完成。</div>}
      {resumable && <div className="workflow-recovery">
        <p>已完成的步骤会保留。恢复会继续未完成的任务；上次执行可能已经修改文件或产生外部操作，请先检查各步骤的会话和任务内容。</p>
        <label className="dependency-option"><input type="checkbox" checked={resumeConfirmed} onChange={event => setResumeConfirmed(event.target.checked)} /><span>我已检查现有结果，确认继续下方未完成的任务</span></label>
        <button className="button primary small" disabled={!resumeConfirmed || pending.has(`resume-${workflow.id}`)} onClick={resume}><RefreshCw size={14} />恢复未完成步骤</button>
      </div>}
      <div className="run-steps">{displayedSteps.map(({ step, status }, index) => <motion.article className={`run-step step-${status}`} key={step.id} variants={motionMessageFadeUp} initial={reducedMotion ? false : 'initial'} animate="animate">
        <div className="step-track" aria-hidden="true"><Status value={status} /></div>
        <div className="run-step-body">
          <div className="run-step-heading"><div><span className="step-index">步骤 {String(index + 1).padStart(2, '0')}</span><h2>{step.title}</h2></div><Status value={status} /></div>
          <div className="step-meta"><span>{providers.find(provider => provider.id === step.providerId)?.name ?? step.providerId}</span>{step.modelId && <><span>·</span><span title={step.modelId}>{modelName(providers.find(provider => provider.id === step.providerId), step.modelId)}</span></>}<span>·</span><span>{step.dependsOn.length ? `依赖 ${step.dependsOn.map(id => workflow.steps.find(item => item.id === id)?.title ?? id).join('、')}` : '独立开始'}</span></div>
          <div className="step-prompt">{step.prompt}</div>
          {step.error && <div className="inline-error"><CircleAlert size={14} /><span>{step.error}</span></div>}
          {step.sessionId && <button className="session-link" onClick={() => openSession(step.sessionId!)}><MessageSquare size={13} />查看会话和输出<ArrowUpRight size={13} /></button>}
          {resumable && ['failed', 'cancelled'].includes(step.status) && <button className="button small" disabled={pending.has(`retry-${workflow.id}-${step.id}`)} onClick={() => void perform(`retry-${workflow.id}-${step.id}`, () => window.workbench.retryWorkflowStep(workflow.id, step.id))}><RefreshCw size={13} />重试此步骤及受阻后续</button>}
          {Boolean(step.attempts?.length) && <details className="attempt-history"><summary>{step.attempts!.length} 次执行尝试</summary>{step.attempts!.map((attempt, offset) => <div className="attempt-row" key={attempt.id}>
            <span>第 {offset + 1} 次</span><Status value={attempt.status === 'running' && attempt.sessionId === step.sessionId ? status : attempt.status} /><time dateTime={attempt.startedAt}>{new Date(attempt.startedAt).toLocaleString('zh-CN')}</time>
            {attempt.retryOf && <span className="muted">重试</span>}
            <button className="session-link" onClick={() => openSession(attempt.sessionId)}><MessageSquare size={12} />查看会话</button>
            {attempt.error && <p className="inline-error">{attempt.error}</p>}
          </div>)}</details>}
        </div>
      </motion.article>)}</div>
    </div>
  </section>;
}

function ProviderModelSummary({ provider }: { provider: ProviderInfo }) {
  if (!provider.models || (!provider.defaultModelId && ['codex', 'claude'].includes(provider.id))) return provider.id === 'codex' || provider.id === 'claude'
    ? <p className="provider-model-note">模型使用 CLI 当前配置。</p> : null;
  const model = provider.models.find(item => item.id === provider.defaultModelId);
  const policy = modelPolicy(provider);
  return <div className="provider-model-summary"><span>默认模型</span><div><strong title={provider.defaultModelId}>{model?.name ?? '暂无可用默认模型'}</strong>{model && <span className={`model-badge ${model.free ? 'free' : 'metered'}`}>{model.free ? '免费' : '按量计费'}</span>}</div>{policy && <p>{policy}</p>}</div>;
}

interface ProvidersProps { snapshot: Snapshot; perform: Perform; pending: Set<string> }

const providerGuides: Record<string, { install: string; configure: string; configureLabel: string; note: string }> = {
  codex: {
    install: 'https://learn.chatgpt.com/docs/codex/cli', configure: 'https://learn.chatgpt.com/docs/auth', configureLabel: '登录与配置帮助',
    note: '先安装并登录 Codex CLI。Ensemble 使用 CLI 的当前模型与认证配置。',
  },
  claude: {
    install: 'https://code.claude.com/docs/en/quickstart', configure: 'https://code.claude.com/docs/en/authentication', configureLabel: '登录与配置帮助',
    note: '先安装并登录 Claude Code。已有 CLI 配置可继续使用。',
  },
  opencode: {
    install: 'https://opencode.ai/v2/docs/', configure: 'https://opencode.ai/v2/docs/providers/', configureLabel: '模型提供商资料（补充）',
    note: '这里接入 OpenCode V2，使用 Ensemble 的独立配置与免费模型目录。提供商文档为补充资料，无需配置或购买付费 Provider。',
  },
  'deepseek-harness': {
    install: 'https://www.deepseek.com/en/harness/', configure: 'https://deepseek-harness.github.io/deepseek-harness/en/guide/providers', configureLabel: '模型配置帮助',
    note: '这里接入本机 dsh CLI。安装后按官方说明配置 DeepSeek API key，再返回刷新检测。',
  },
};

function ProviderGuides({ provider }: { provider: ProviderInfo }) {
  const guide = provider.source === 'builtin' ? providerGuides[provider.id] : undefined;
  if (!guide) return null;
  return <div className="provider-guides"><p>{guide.note}</p><nav className="provider-guide-links" aria-label={`${provider.name} 安装与配置`}>
    <a href={guide.install} target="_blank" rel="noreferrer">安装指南<ArrowUpRight size={13} aria-hidden="true" /></a>
    <a href={guide.configure} target="_blank" rel="noreferrer">{guide.configureLabel}<ArrowUpRight size={13} aria-hidden="true" /></a>
  </nav></div>;
}

function ProvidersContent({ snapshot, perform, pending }: ProvidersProps) {
  const reducedMotion = useReducedMotion();
  const available = snapshot.providers.filter(provider => provider.available).length;
  return <div className="providers-content">
    <div className="provider-detection">
      <div><span className={`connections-status ${available ? 'ready' : ''}`}><span />已发现 {available} 个运行入口</span><p>检测只确认本机入口，认证和模型访问以实际任务为准。</p></div>
      <button className="button" disabled={pending.has('refresh-providers')} onClick={() => void perform('refresh-providers', () => window.workbench.refreshProviders())}><RefreshCw className={pending.has('refresh-providers') ? 'spin' : ''} size={14} />刷新检测</button>
    </div>
    <div className="provider-cards">{snapshot.providers.map(provider => <motion.article className={`provider-card ${!provider.available ? 'unavailable' : ''}`} key={provider.id} variants={motionMessageFadeUp} initial={reducedMotion ? false : 'initial'} animate="animate">
      <div className="provider-card-heading"><div className="provider-icon"><TerminalSquare size={18} /></div><div><h2>{provider.name}</h2><span>{provider.source === 'plugin' ? '本地插件' : '内置接入'}</span></div><span className={`availability ${provider.available ? 'available' : ''}`}><span />{provider.available ? '已发现入口' : '未就绪'}</span></div>
      <p className="provider-detail">{provider.detail}</p><ProviderModelSummary provider={provider} />
      <div className="provider-capabilities"><span className={provider.capabilities.resume ? 'supported' : ''}>{provider.capabilities.resume ? <Check size={13} /> : <X size={13} />}继续会话{!provider.capabilities.resume && ' · 未支持'}</span><span className={provider.capabilities.approvals ? 'supported' : ''}><ShieldCheck size={13} />操作审批{!provider.capabilities.approvals && ' · 未支持'}</span></div>
      <ProviderGuides provider={provider} />
    </motion.article>)}</div>
    <div className="plugin-section">
      <div className="plugin-section-heading"><div><h2><Plug size={18} />本地插件</h2><p>添加新的智能体接入后，点击刷新检测。</p></div><button className="button" onClick={() => void perform('open-plugins', () => window.workbench.openPluginDirectory())}><FolderOpen size={14} />打开插件目录</button></div>
      <code className="path-display">{snapshot.pluginPath}</code>
      {snapshot.pluginErrors.length > 0 && <div className="plugin-errors"><h3><CircleAlert size={15} />插件加载失败</h3>{snapshot.pluginErrors.map((error, index) => <p key={index}>{error}</p>)}</div>}
    </div>
  </div>;
}

export function ProvidersView(props: ProvidersProps) {
  return <section className="providers-page scroll-content">
    <div className="page-intro"><div><span className="eyebrow">本地运行环境</span><h1>智能体接入</h1><p>安装或配置运行时后，回到这里刷新检测。</p></div></div>
    <ProvidersContent {...props} />
  </section>;
}

export function ProvidersDialog({ onClose, ...props }: ProvidersProps & { onClose: () => void }) {
  return <Modal title="安装与接入帮助" subtitle="查看官方安装与配置说明，刷新检测后继续填写协作。" size="wide" onClose={onClose}>
    <ProvidersContent {...props} />
  </Modal>;
}
