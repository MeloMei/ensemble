import { AgentIcon } from './AgentIcon';
import { AppSelect } from './AppSelect';
import { useTranslation } from 'react-i18next';
import { translate as t, formatDate, renderDisplayText } from '../shared/i18n';
import { useEffect, useState, type FormEvent } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowUpRight, Check, Copy, CircleAlert, CircleStop, Folder, FolderOpen, GitBranch, LoaderCircle, MessageSquare, Plug, Plus, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import type { ProviderInfo, Session, Snapshot, Workflow, WorkflowInput, WorkflowStep, WorkflowStepInput } from '../shared/types';
import { DirectoryField, IconButton, ModelField, ProviderSelect, Status, defaultModelId, statusLabel, modelName, modelPolicy, validModelSelection, usesCliModelDefault, type Perform } from './ui';
import { motionMessageFadeUp } from './vendor/open-claude-ui/ClaudeMotionPresets';
import { RuntimeHealth, useRuntimeHealth } from './RuntimeHealth';
import './WorkflowViews.css';

function makeStep(provider: ProviderInfo | undefined, previous?: string): WorkflowStepInput {
  return { id: crypto.randomUUID(), title: '', providerId: provider?.id ?? '', modelId: defaultModelId(provider),
    prompt: '', dependsOn: previous ? [previous] : [] };
}

export function WorkflowEditor({ providers, perform, pending, onClose, onCreated }: { providers: ProviderInfo[]; perform: Perform; pending: Set<string>; onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation('shell');
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
    <div className="detail-heading"><div><h1>{t('workflow.new')}</h1><p className="heading-description">{t('workflow.saveFirst')}</p></div><IconButton label={t('workflow.cancelNew')} disabled={busy} onClick={onClose}><X size={18} /></IconButton></div>
    <form className="workflow-editor scroll-content" onSubmit={save}>
      <div className="workflow-settings"><label>{t('workflow.name')}<input value={name} onChange={event => setName(event.target.value)} placeholder={t('workflow.nameExample')} required autoFocus /></label><label>{t('common.projectDirectory')}<DirectoryField value={cwd} onChange={setCwd} perform={perform} /></label></div>
      <div className="section-label">{t('workflow.tasks')}<span>{t('workflow.resultHandoff')}</span></div>
      <div className="workflow-steps">{steps.map((step, index) => {
        const provider = providers.find(item => item.id === step.providerId);
        return <motion.div className="step-editor" key={step.id} variants={motionMessageFadeUp} initial={reducedMotion ? false : 'initial'} animate="animate">
          <div className="step-editor-heading"><span className="step-number">{String(index + 1).padStart(2, '0')}</span><strong>{t('workflow.numberedStep', { number: index + 1 })}</strong><IconButton label={t('workflow.removeStep', { number: index + 1 })} disabled={steps.length === 1 || busy} onClick={() => setSteps(current => current.filter(item => item.id !== step.id).map(item => ({ ...item, dependsOn: item.dependsOn.filter(id => id !== step.id) })))}><Trash2 size={15} /></IconButton></div>
          <div className="step-fields"><label>{t('common.title')}<input value={step.title} onChange={event => updateStep(step.id, { title: event.target.value })} placeholder={t('workflow.stepGoal')} required /></label><label>{t('common.agent')}<ProviderSelect providers={providers} value={step.providerId} onChange={providerId => updateStep(step.id, { providerId, modelId: defaultModelId(providers.find(item => item.id === providerId)) })} /></label></div>
          <ModelField provider={provider} value={step.modelId} disabled={busy} onChange={modelId => updateStep(step.id, { modelId })} />
          <label>{t('common.task')}<textarea value={step.prompt} onChange={event => updateStep(step.id, { prompt: event.target.value })} placeholder={t('workflow.taskHint')} rows={3} required /></label>
          <div className="dependency-field"><span>{t('workflow.waitFor')}</span>{steps.length === 1 ? <span className="muted">{t('workflow.noPredecessor')}</span> : steps.filter(item => item.id !== step.id).map(item => <label className="dependency-option" key={item.id}><input type="checkbox" checked={step.dependsOn.includes(item.id)} onChange={event => updateStep(step.id, { dependsOn: event.target.checked ? [...step.dependsOn, item.id] : step.dependsOn.filter(id => id !== item.id) })} /><span>{item.title || t('workflow.numberedStep', { number: steps.indexOf(item) + 1 })}</span></label>)}</div>
        </motion.div>;
      })}</div>
      <button type="button" className="add-step" disabled={busy} onClick={() => setSteps(current => [...current, makeStep(defaultProvider, current.at(-1)?.id)])}><Plus size={15} />{t('workflow.addStep')}</button>
      <div className="editor-actions"><button type="button" className="button" disabled={busy} onClick={onClose}>{t('common.cancel')}</button><button className="button primary" disabled={!valid || busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{t('workflow.save')}</button></div>
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
  const { t } = useTranslation('shell');
  const reducedMotion = useReducedMotion();
  const completed = workflow.steps.filter(step => step.status === 'completed').length;
  const displayedSteps = workflow.steps.map(step => ({ step, status: stepDisplayStatus(step, sessions) }));
  const resumable = ['failed', 'cancelled', 'interrupted'].includes(workflow.status);
  const recoveryKey = JSON.stringify([workflow.id, workflow.updatedAt, workflow.status]);
  const [confirmedRecovery, setConfirmedRecovery] = useState<string>();
  const resumeConfirmed = resumable && confirmedRecovery === recoveryKey;
  useEffect(() => { setConfirmedRecovery(undefined); }, [recoveryKey]);
  const resume = () => void perform(`resume-${workflow.id}`, async () => {
    if (!resumeConfirmed) return;
    await window.workbench.resumeWorkflow(workflow.id); setConfirmedRecovery(undefined);
  });
  return <section className="workflow-detail">
    <div className="detail-heading">
      <div className="heading-text"><h1>{workflow.name}</h1><div className="detail-meta"><span title={workflow.cwd}><Folder size={12} />{workflow.cwd.split('/').filter(Boolean).pop()}</span><Status value={workflow.status} /></div></div>
      <div className="heading-actions">
        <button className="button small" disabled={pending.has(`clone-${workflow.id}`)} onClick={() => void perform(`clone-${workflow.id}`, async () => {
          const id = await window.workbench.cloneWorkflow(workflow.id); openWorkflow?.(id);
        })}><Copy size={14} />{t('workflow.clone')}</button>
        {workflow.status === 'draft' && <button className="button primary small" disabled={pending.has(`start-${workflow.id}`)} onClick={() => void perform(`start-${workflow.id}`, () => window.workbench.startWorkflow(workflow.id))}>{pending.has(`start-${workflow.id}`) ? <LoaderCircle className="spin" size={14} /> : <ArrowUpRight size={14} />}{t('workflow.start')}</button>}
        {workflow.status === 'running' && <button className="button danger small" disabled={pending.has(`stop-${workflow.id}`)} onClick={() => void perform(`stop-${workflow.id}`, () => window.workbench.cancelWorkflow(workflow.id))}><CircleStop size={14} />{t('workflow.stop')}</button>}
      </div>
    </div>
    <div className="workflow-run scroll-content">
      <div className="run-overview"><div><span className="eyebrow">{t('workflow.progress')}</span><p><strong>{completed}</strong><span>{t('workflow.completedCount', { count: workflow.steps.length })}</span></p></div><div className="run-progress" role="progressbar" aria-label={t('workflow.progressLabel')} aria-valuemin={0} aria-valuemax={workflow.steps.length} aria-valuenow={completed}>{displayedSteps.map(({ step, status }) => <span key={step.id} className={`progress-${status}`} title={`${step.title}: ${statusLabel(status)}`} />)}</div></div>
      {workflow.status === 'draft' && <div className="info-note"><GitBranch size={16} />{t('workflow.readyNote')}</div>}
      {resumable && <div className="workflow-recovery">
        <p>{t('workflow.resumeNote')}</p>
        <label className="dependency-option"><input type="checkbox" checked={resumeConfirmed} onChange={event => setConfirmedRecovery(event.target.checked ? recoveryKey : undefined)} /><span>{t('workflow.resumeConfirm')}</span></label>
        <button className="button primary small" disabled={!resumeConfirmed || pending.has(`resume-${workflow.id}`)} onClick={resume}><RefreshCw size={14} />{t('workflow.resume')}</button>
      </div>}
      <div className="run-steps">{displayedSteps.map(({ step, status }, index) => <motion.article className={`run-step step-${status}`} key={step.id} variants={motionMessageFadeUp} initial={reducedMotion ? false : 'initial'} animate="animate">
        <div className="step-track" aria-hidden="true"><Status value={status} /></div>
        <div className="run-step-body">
          <div className="run-step-heading"><div><span className="step-index">{t('workflow.numberedStep', { number: String(index + 1).padStart(2, '0') })}</span><h2>{step.title}</h2></div><Status value={status} /></div>
          <div className="step-meta"><span>{providers.find(provider => provider.id === step.providerId)?.name ?? step.providerId}</span>{step.modelId && <><span>·</span><span title={step.modelId}>{modelName(providers.find(provider => provider.id === step.providerId), step.modelId)}</span></>}<span>·</span><span>{step.dependsOn.length ? t('workflow.dependsOn', { steps: step.dependsOn.map(id => workflow.steps.find(item => item.id === id)?.title ?? id).join(', ') }) : t('workflow.independent')}</span></div>
          <div className="step-prompt">{step.prompt}</div>
          {step.error && <div className="inline-error"><CircleAlert size={14} /><span>{step.error}</span></div>}
          {step.sessionId && <button className="session-link" onClick={() => openSession(step.sessionId!)}><MessageSquare size={13} />{t('workflow.viewOutput')}<ArrowUpRight size={13} /></button>}
          {resumable && ['failed', 'cancelled'].includes(step.status) && <button className="button small" disabled={pending.has(`retry-${workflow.id}-${step.id}`)} onClick={() => void perform(`retry-${workflow.id}-${step.id}`, () => window.workbench.retryWorkflowStep(workflow.id, step.id))}><RefreshCw size={13} />{t('workflow.retryBlocked')}</button>}
          {Boolean(step.attempts?.length) && <details className="attempt-history"><summary>{t('workflow.attemptCount', { count: step.attempts!.length })}</summary>{step.attempts!.map((attempt, offset) => <div className="attempt-row" key={attempt.id}>
            <span>{t('workflow.attempt', { number: offset + 1 })}</span><Status value={attempt.status === 'running' && attempt.sessionId === step.sessionId ? status : attempt.status} /><time dateTime={attempt.startedAt}>{formatDate(attempt.startedAt)}</time>
            {attempt.retryOf && <span className="muted">{t('workflow.retry')}</span>}
            <button className="session-link" onClick={() => openSession(attempt.sessionId)}><MessageSquare size={12} />{t('workflow.viewSession')}</button>
            {attempt.error && <p className="inline-error">{attempt.error}</p>}
          </div>)}</details>}
        </div>
      </motion.article>)}</div>
    </div>
  </section>;
}

function ProviderModelSummary({ provider }: { provider: ProviderInfo }) {
  const { t } = useTranslation('shell');
  if (!provider.models || (!provider.defaultModelId && usesCliModelDefault(provider))) return usesCliModelDefault(provider)
    ? <p className="provider-model-note">{t('provider.cliModel')}</p> : null;
  const model = provider.models.find(item => item.id === provider.defaultModelId);
  const policy = modelPolicy(provider);
  return <div className="provider-model-summary"><span>{t('provider.defaultModel')}</span><div><strong title={provider.defaultModelId}>{model?.name ?? t('provider.noDefaultModel')}</strong>{model && <span className={`model-badge ${model.free ? 'free' : 'metered'}`}>{model.free ? t('provider.free') : t('provider.metered')}</span>}</div>{policy && <p>{policy}</p>}</div>;
}

interface ProvidersProps { snapshot: Snapshot; perform: Perform; pending: Set<string> }

function providerGuides(): Record<string, { install: string; configure: string; configureLabel: string; note: string }> { return {
  codex: {
    install: 'https://learn.chatgpt.com/docs/codex/cli', configure: 'https://learn.chatgpt.com/docs/auth', configureLabel: t('provider.authHelp'),
    note: t('provider.codexSetup'),
  },
  claude: {
    install: 'https://code.claude.com/docs/en/quickstart', configure: 'https://code.claude.com/docs/en/authentication', configureLabel: t('provider.authHelp'),
    note: t('provider.claudeSetup'),
  },
  pi: {
    install: 'https://pi.dev/', configure: 'https://pi.dev/docs/latest/models', configureLabel: t('provider.authHelp'),
    note: t('provider.piSetup'),
  },
  gemini: {
    install: 'https://geminicli.com/docs/get-started/installation/', configure: 'https://geminicli.com/docs/get-started/authentication/', configureLabel: t('provider.authHelp'),
    note: t('provider.geminiSetup'),
  },
  cursor: {
    install: 'https://cursor.com/docs/cli/installation', configure: 'https://cursor.com/docs/cli/reference/authentication', configureLabel: t('provider.authHelp'),
    note: t('provider.cursorSetup'),
  },
  qoder: {
    install: 'https://docs.qoder.com/cli/installation', configure: 'https://docs.qoder.com/cli/authentication', configureLabel: t('provider.authHelp'),
    note: t('provider.qoderSetup'),
  },
  opencode: {
    install: 'https://opencode.ai/v2/docs/', configure: 'https://opencode.ai/v2/docs/providers/', configureLabel: t('provider.extraProviderDocs'),
    note: t('provider.opencodeSetup'),
  },
  'deepseek-harness': {
    install: 'https://www.deepseek.com/en/harness/', configure: 'https://deepseek-harness.github.io/deepseek-harness/en/guide/providers', configureLabel: t('provider.modelHelp'),
    note: t('provider.deepseekSetup'),
  },
}; }

function ProviderGuides({ provider }: { provider: ProviderInfo }) {
  const { t } = useTranslation('shell');
  const guide = provider.source === 'builtin' ? providerGuides()[provider.id] : undefined;
  if (!guide) return null;
  return <div className="provider-guides"><p>{guide.note}</p><nav className="provider-guide-links" aria-label={t('provider.guideLabel', { provider: provider.name })}>
    <a href={guide.install} target="_blank" rel="noreferrer">{t('provider.installGuide')}<ArrowUpRight size={13} aria-hidden="true" /></a>
    <a href={guide.configure} target="_blank" rel="noreferrer">{guide.configureLabel}<ArrowUpRight size={13} aria-hidden="true" /></a>
  </nav></div>;
}

export function ProvidersContent({ snapshot, perform, pending }: ProvidersProps) {
  const { t } = useTranslation('shell');
  const { t: runtimeText } = useTranslation('runtime');
  const reducedMotion = useReducedMotion();
  const [directory, setDirectory] = useState('');
  const cwd = snapshot.workspaces.some(workspace => workspace.cwd === directory) ? directory : '';
  const health = useRuntimeHealth(snapshot.providers, cwd);
  const available = health.providers.filter(provider => provider.available).length;
  const directories = snapshot.workspaces.filter((workspace, index, values) => values.findIndex(item => item.cwd === workspace.cwd) === index);
  return <div className="providers-content">
    <div className="runtime-directory"><label>{runtimeText('health.directory')}<AppSelect label={runtimeText('health.directory')} value={cwd} onChange={setDirectory}
      options={[{ value: '', label: runtimeText('health.global') }, ...directories.map(workspace => ({ value: workspace.cwd, label: workspace.name, description: workspace.cwd }))]} /></label>{cwd && <code>{cwd}</code>}<p>{runtimeText(cwd ? 'health.directoryNote' : 'health.globalNote')}</p></div>
    <div className="provider-detection">
      <div><span className={`connections-status ${available ? 'ready' : ''}`}><span />{t('provider.detectedCount', { count: available })}</span><p>{t('provider.detectionNote')}</p></div>
      <button className="button" disabled={pending.has('refresh-providers') || health.loading} onClick={() => void perform('refresh-providers', health.refresh)}><RefreshCw className={pending.has('refresh-providers') ? 'spin' : ''} size={14} />{t('provider.refresh')}</button>
    </div>
    {health.error && <p className="runtime-panel-error" role="alert">{health.error}</p>}
    <div className="provider-cards">{health.providers.map(provider => <motion.article className={`provider-card ${!provider.available ? 'unavailable' : ''}`} key={provider.id} variants={motionMessageFadeUp} initial={reducedMotion ? false : 'initial'} animate="animate">
      <div className="provider-card-heading"><div className="provider-icon"><AgentIcon providerId={provider.id} size={18} /></div><div><h2>{provider.name}</h2><span>{provider.source === 'plugin' ? t('provider.plugin') : t('provider.builtin')}</span></div><span className={`availability ${provider.available ? 'available' : ''}`}><span />{provider.available ? t('provider.entryFound') : t('provider.notReady')}</span></div>
      <p className="provider-detail">{renderDisplayText(provider.detail, provider.detailI18n)}</p><ProviderModelSummary provider={provider} />
      <div className="provider-capabilities"><span className={provider.capabilities.resume ? 'supported' : ''}>{provider.capabilities.resume ? <Check size={13} /> : <X size={13} />}{t('provider.continueSession')}{!provider.capabilities.resume && t('provider.unsupportedSuffix')}</span><span className={provider.capabilities.approvals ? 'supported' : ''}><ShieldCheck size={13} />{t('provider.approvals')}{!provider.capabilities.approvals && t('provider.unsupportedSuffix')}</span></div>
      <RuntimeHealth provider={provider} loading={health.loading} />
      <ProviderGuides provider={provider} />
    </motion.article>)}</div>
    <div className="plugin-section">
      <div className="plugin-section-heading"><div><h2><Plug size={18} />{t('provider.plugin')}</h2><p>{t('provider.pluginsNote')}</p></div><button className="button" onClick={() => void perform('open-plugins', () => window.workbench.openPluginDirectory())}><FolderOpen size={14} />{t('provider.openPluginDirectory')}</button></div>
      <code className="path-display">{snapshot.pluginPath}</code>
      {snapshot.pluginErrors.length > 0 && <div className="plugin-errors"><h3><CircleAlert size={15} />{t('provider.pluginErrors')}</h3>{snapshot.pluginErrors.map((error, index) => <p key={index}>{error}</p>)}</div>}
    </div>
  </div>;
}
