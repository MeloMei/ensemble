import { AgentIcon } from './AgentIcon';
import { AppSelect } from './AppSelect';
import { useTranslation } from 'react-i18next';
import { translate as t, formatDate, renderDisplayText } from '../shared/i18n';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { useReducedMotion } from './appearance';
import { ArrowDownUp, ArrowRight, ArrowUpRight, Check, Copy, CircleAlert, CircleStop, Folder, FolderOpen, GitBranch, Link2, LoaderCircle, MessageSquare, Plug, Plus, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import type { Connection } from '@xyflow/react';
import type { ProviderInfo, Session, Snapshot, Workflow, WorkflowInput, WorkflowStep, WorkflowStepInput } from '../shared/types';
import { DirectoryField, IconButton, ModelField, ProviderSelect, Status, defaultModelId, statusLabel, modelName, modelPolicy, validModelSelection, usesCliModelDefault, type Perform } from './ui';
import { motionMessageFadeUp } from './vendor/open-claude-ui/ClaudeMotionPresets';
import { RuntimeHealth, useRuntimeHealth } from './RuntimeHealth';
import { ExecutionGraph, graphNode, edgeFor, type GraphSelection } from './ExecutionGraph';
import { copyGraphView } from './graph-view-state';
import { workflowDependencies, setWorkflowDependency, removeWorkflowDependency, removeWorkflowStep, type WorkflowDependency } from './workflow-graph';
import './WorkflowViews.css';

function makeStep(provider: ProviderInfo | undefined): WorkflowStepInput {
  return { id: crypto.randomUUID(), title: '', providerId: provider?.id ?? '', modelId: defaultModelId(provider), prompt: '', dependsOn: [] };
}

export function stepDisplayStatus(step: WorkflowStep, sessions: Session[]) {
  const session = sessions.find(item => item.id === step.sessionId);
  return step.status === 'running' && session && ['queued', 'running', 'waiting_approval', 'waiting_children'].includes(session.status) ? session.status : step.status;
}

function currentStepExecutionId(step: WorkflowStep) {
  return step.attempts?.slice().reverse().find(attempt => attempt.sessionId === step.sessionId)?.id ?? step.sessionId;
}

function stepExecutionId(step: WorkflowStep, sessions: Session[]) {
  if (step.status !== 'running' || sessions.find(session => session.id === step.sessionId)?.status !== 'running') return undefined;
  return currentStepExecutionId(step);
}

export function workflowGraph(steps: WorkflowStepInput[], providers: ProviderInfo[], sessions: Session[] = [], draft = false, activity?: { edges: Map<string, number>; onEnd: (id: string, seq: number) => void }) {
  return {
    nodes: steps.map((step, index) => {
      const runStep = 'status' in step ? step as WorkflowStep : undefined;
      const provider = providers.find(item => item.id === step.providerId);
      const status = draft ? 'draft' : runStep ? stepDisplayStatus(runStep, sessions) : 'draft';
      return graphNode('task-' + step.id, { kind: 'task', title: step.title || t('workflow.numberedStep', { number: index + 1 }),
        subtitle: [provider?.name ?? step.providerId, step.modelId ? modelName(provider, step.modelId) : ''].filter(Boolean).join(' · '),
        detail: step.prompt, status, recipientProviderId: step.providerId,
        executionId: runStep ? currentStepExecutionId(runStep) : undefined,
        executionActive: Boolean(runStep && stepExecutionId(runStep, sessions)) });
    }),
    edges: workflowDependencies(steps).map(dependency => {
      const edge = edgeFor(dependency.id, 'task-' + dependency.source, 'task-' + dependency.target,
        t('workflow.afterComplete'), { kind: 'relationship', id: dependency.id }, true);
      const seq = activity?.edges.get(dependency.id);
      return seq === undefined ? edge : { ...edge, data: { ...edge.data, configured: false,
        handoffSeqs: [seq], onHandoffEnd: () => activity?.onEnd(dependency.id, seq) } };
    }),
  };
}

export function WorkflowEditor({ providers, perform, pending, onClose, onCreated }: { providers: ProviderInfo[]; perform: Perform; pending: Set<string>; onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation('shell');
  const defaultProvider = providers.find(provider => provider.available);
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [draftKey] = useState(() => 'workflow-draft:' + crypto.randomUUID());
  const [steps, setSteps] = useState<WorkflowStepInput[]>(() => [makeStep(defaultProvider)]);
  const [selection, setSelection] = useState<GraphSelection>(() => ({ kind: 'task', id: steps[0].id }));
  const [connecting, setConnecting] = useState(false);
  const [source, setSource] = useState<string>();
  const [graphError, setGraphError] = useState('');
  const busy = pending.has('create-workflow');
  const selectedStep = selection.kind === 'task' ? steps.find(step => step.id === selection.id) : undefined;
  const selectedEdge = selection.kind === 'relationship' ? workflowDependencies(steps).find(edge => edge.id === selection.id) : undefined;
  const valid = Boolean(name.trim() && cwd.trim() && steps.length > 0 && steps.every(step =>
    step.title.trim() && step.prompt.trim() && validModelSelection(providers.find(provider => provider.id === step.providerId), step.modelId)));
  const updateStep = (id: string, patch: Partial<WorkflowStepInput>) => {
    if (!busy) setSteps(current => current.map(step => step.id === id ? { ...step, ...patch } : step));
  };
  const connect = (from: string, to: string, previous?: WorkflowDependency) => {
    if (busy) return;
    const result = setWorkflowDependency(steps, from, to, previous);
    if (result.error) { setGraphError(t('workflow.dependencyError.' + result.error)); return; }
    setSteps(result.steps); setGraphError(''); setSource(undefined); setConnecting(false);
    setSelection({ kind: 'relationship', id: JSON.stringify([from, to]) });
  };
  const onConnect = (connection: Connection) => {
    if (connection.source && connection.target) connect(connection.source.replace(/^task-/, ''), connection.target.replace(/^task-/, ''));
  };
  const select = (next: GraphSelection) => {
    if (busy) return;
    if (connecting && next.kind === 'task') {
      if (!source) { setSource(next.id); setSelection(next); setGraphError(''); }
      else connect(source, next.id);
    } else { setSelection(next); setGraphError(''); setConnecting(false); setSource(undefined); }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    const input: WorkflowInput = { name: name.trim(), cwd: cwd.trim(), steps: steps.map(step => ({ ...step, title: step.title.trim(), prompt: step.prompt.trim() })) };
    void perform('create-workflow', async () => {
      const id = await window.workbench.createWorkflow(input);
      copyGraphView(draftKey, 'workflow:' + id);
      onCreated(id);
    });
  };
  const options = steps.map((step, index) => ({ value: step.id, label: step.title || t('workflow.numberedStep', { number: index + 1 }) }));
  const provider = providers.find(item => item.id === selectedStep?.providerId);
  return <section className="workflow-detail workflow-studio-detail">
    <div className="detail-heading"><div><h1>{t('workflow.new')}</h1><p className="heading-description">{t('workflow.graphHint')}</p></div><IconButton label={t('workflow.cancelNew')} disabled={busy} onClick={onClose}><X size={18} /></IconButton></div>
    <div className="workflow-editor">
      <form id={draftKey} className="workflow-settings" onSubmit={save}>
        <label>{t('workflow.name')}<input value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder={t('workflow.nameExample')} required autoFocus /></label>
        <label>{t('common.projectDirectory')}<DirectoryField value={cwd} onChange={value => { if (!busy) setCwd(value); }} perform={perform} /></label>
      </form>
      <div className="workflow-graph-toolbar"><span>{t('workflow.tasks')} <span className="muted">{steps.length}</span></span><div>
        <button type="button" className="button small" disabled={busy} onClick={() => { const step = makeStep(defaultProvider); setSteps(current => [...current, step]); setSelection({ kind: 'task', id: step.id }); setConnecting(false); setSource(undefined); setGraphError(''); }}><Plus size={14} />{t('workflow.addStep')}</button>
        <button type="button" className={`button small ${connecting ? 'active' : ''}`} aria-pressed={connecting} disabled={busy || (!connecting && steps.length < 2)} onClick={() => { setConnecting(value => !value); setSource(undefined); setGraphError(''); }}><Link2 size={14} />{connecting ? t('common.cancel') : t('workflow.connectSteps')}</button>
      </div></div>
      {connecting && <p className="workflow-connect-hint" role="status">{source ? t('workflow.chooseTarget', { title: steps.find(step => step.id === source)?.title || t('workflow.untitledStep') }) : t('workflow.chooseSource')}</p>}
      {graphError && <p className="workflow-graph-error" role="alert"><CircleAlert size={14} />{graphError}</p>}
      <div className="workflow-studio">
        <ExecutionGraph key={draftKey} graph={workflowGraph(steps, providers)} view="workflow" storageKey={draftKey} selection={selection} connectable={!busy} onConnect={onConnect} onSelect={select} />
        <aside className="workflow-inspector" aria-label={t('workflow.inspector')}>
          {selectedStep && <><div className="workflow-inspector-heading"><h2>{t('workflow.stepDetails')}</h2><IconButton label={t('workflow.deleteTask')} disabled={busy} onClick={() => {
            const next = removeWorkflowStep(steps, selectedStep.id); setSteps(next); setConnecting(false); setSource(undefined); setGraphError('');
            setSelection({ kind: 'task', id: next[0]?.id ?? '' });
          }}><Trash2 size={15} /></IconButton></div>
          <fieldset disabled={busy}><label>{t('common.title')}<input value={selectedStep.title} onChange={event => updateStep(selectedStep.id, { title: event.target.value })} placeholder={t('workflow.stepGoal')} /></label>
          <label>{t('common.agent')}<ProviderSelect providers={providers} value={selectedStep.providerId} onChange={providerId => updateStep(selectedStep.id, { providerId, modelId: defaultModelId(providers.find(item => item.id === providerId)) })} /></label>
          <ModelField provider={provider} value={selectedStep.modelId} disabled={busy} onChange={modelId => updateStep(selectedStep.id, { modelId })} />
          <label>{t('common.task')}<textarea value={selectedStep.prompt} onChange={event => updateStep(selectedStep.id, { prompt: event.target.value })} placeholder={t('workflow.taskHint')} rows={8} /></label></fieldset>
          <p className="workflow-inspector-note">{t('workflow.resultHandoff')}</p></>}
          {selectedEdge && <><div className="workflow-inspector-heading"><h2>{t('workflow.dependency')}</h2></div><p className="workflow-inspector-note">{t('workflow.dependencyHint')}</p>
          <label>{t('workflow.source')}<AppSelect label={t('workflow.source')} value={selectedEdge.source} options={options} disabled={busy} onChange={from => connect(from, selectedEdge.target, selectedEdge)} /></label>
          <div className="workflow-dependency-arrow"><ArrowRight size={16} />{t('workflow.afterComplete')}</div>
          <label>{t('workflow.target')}<AppSelect label={t('workflow.target')} value={selectedEdge.target} options={options} disabled={busy} onChange={to => connect(selectedEdge.source, to, selectedEdge)} /></label>
          <div className="workflow-inspector-actions"><button type="button" className="button small" disabled={busy} onClick={() => connect(selectedEdge.target, selectedEdge.source, selectedEdge)}><ArrowDownUp size={14} />{t('workflow.reverseDependency')}</button>
          <button type="button" className="button danger small" disabled={busy} onClick={() => { setSteps(removeWorkflowDependency(steps, selectedEdge)); setSelection({ kind: 'task', id: selectedEdge.target }); setGraphError(''); }}><Trash2 size={14} />{t('workflow.deleteDependency')}</button></div></>}
          {!selectedStep && !selectedEdge && <p className="workflow-inspector-note">{t('workflow.selectStep')}</p>}
        </aside>
      </div>
      <div className="editor-actions"><span className="workflow-inspector-note">{t('workflow.saveFirst')}</span><button type="button" className="button" disabled={busy} onClick={onClose}>{t('common.cancel')}</button><button type="submit" form={draftKey} className="button primary" disabled={!valid || busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{t('workflow.save')}</button></div>
    </div>
  </section>;
}

export function WorkflowView({ workflow, providers, sessions = [], perform, pending, openSession, openWorkflow }: {
  workflow: Workflow; providers: ProviderInfo[]; sessions?: Session[]; perform: Perform; pending: Set<string>;
  openSession: (id: string) => void; openWorkflow?: (id: string) => void;
}) {
  const { t } = useTranslation('shell');
  const reducedMotion = useReducedMotion();
  const completed = workflow.steps.filter(step => step.status === 'completed').length;
  const resumable = ['failed', 'cancelled', 'interrupted'].includes(workflow.status);
  const recoveryKey = JSON.stringify([workflow.id, workflow.updatedAt, workflow.status]);
  const [confirmedRecovery, setConfirmedRecovery] = useState<string>();
  const [selection, setSelection] = useState<GraphSelection>({ kind: 'task', id: workflow.steps[0]?.id ?? '' });
  const resumeConfirmed = resumable && confirmedRecovery === recoveryKey;
  useEffect(() => { setConfirmedRecovery(undefined); }, [recoveryKey]);
  useEffect(() => { setSelection({ kind: 'task', id: workflow.steps[0]?.id ?? '' }); }, [workflow.id]);
  const step = selection.kind === 'task' ? workflow.steps.find(item => item.id === selection.id) : undefined;
  const dependency = selection.kind === 'relationship' ? workflowDependencies(workflow.steps).find(edge => edge.id === selection.id) : undefined;
  const status = step ? workflow.status === 'draft' ? 'draft' : stepDisplayStatus(step, sessions) : undefined;
  const [edgeActivity, setEdgeActivity] = useState<Map<string, number>>(() => new Map());
  const previousExecutions = useRef<{ workflowId: string; seen: Set<string> } | undefined>(undefined);
  const activitySequence = useRef(0);
  const executionState = JSON.stringify(workflow.steps.map(item => [item.id, stepDisplayStatus(item, sessions), item.sessionId,
    item.attempts?.at(-1)?.id, sessions.find(session => session.id === item.sessionId)?.status]));
  useEffect(() => {
    if (previousExecutions.current?.workflowId !== workflow.id) {
      previousExecutions.current = { workflowId: workflow.id, seen: new Set(workflow.steps.flatMap(item => [
        ...(item.attempts?.map(attempt => attempt.id) ?? []), ...(item.sessionId ? [item.sessionId] : []),
      ])) };
      setEdgeActivity(new Map());
      return;
    }
    const executions = new Map(workflow.steps.flatMap(item => { const execution = stepExecutionId(item, sessions); return execution ? [[item.id, execution] as const] : []; }));
    const newExecutions = new Set([...executions].filter(([, execution]) => !previousExecutions.current!.seen.has(execution)).map(([id]) => id));
    for (const execution of executions.values()) previousExecutions.current.seen.add(execution);
    const activity = new Map<string, number>();
    const dependencies = workflowDependencies(workflow.steps);
    if (!reducedMotion && workflow.status === 'running') for (const dependency of dependencies) {
      if (newExecutions.has(dependency.target) && workflow.steps.find(item => item.id === dependency.source)?.status === 'completed') {
        activity.set(dependency.id, ++activitySequence.current);
      }
    }
    setEdgeActivity(current => {
      const next = new Map([...current].filter(([id]) => dependencies.some(dependency => dependency.id === id && executions.has(dependency.target))));
      for (const [id, seq] of activity) next.set(id, seq);
      return reducedMotion || workflow.status !== 'running' ? new Map() : next;
    });
  }, [executionState, workflow.id, workflow.status, reducedMotion]);
  const endEdgeActivity = (id: string, seq: number) => setEdgeActivity(current => {
    if (current.get(id) !== seq) return current;
    const next = new Map(current); next.delete(id); return next;
  });
  const resume = () => void perform(`resume-${workflow.id}`, async () => {
    if (!resumeConfirmed) return;
    await window.workbench.resumeWorkflow(workflow.id); setConfirmedRecovery(undefined);
  });
  return <section className="workflow-detail workflow-studio-detail">
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
    <div className="workflow-run">
      <div className="run-overview"><div><span className="eyebrow">{t('workflow.progress')}</span><p><strong>{completed}</strong><span>{t('workflow.completedCount', { count: workflow.steps.length })}</span></p></div><div className="run-progress" role="progressbar" aria-label={t('workflow.progressLabel')} aria-valuemin={0} aria-valuemax={workflow.steps.length} aria-valuenow={completed}>{workflow.steps.map(item => { const value = stepDisplayStatus(item, sessions); return <span key={item.id} className={`progress-${value}`} title={`${item.title}: ${statusLabel(value)}`} />; })}</div></div>
      {workflow.status === 'draft' && <div className="info-note"><GitBranch size={16} />{t('workflow.readyNote')}</div>}
      {resumable && <div className="workflow-recovery"><p>{t('workflow.resumeNote')}</p><label className="dependency-option"><input type="checkbox" checked={resumeConfirmed} onChange={event => setConfirmedRecovery(event.target.checked ? recoveryKey : undefined)} /><span>{t('workflow.resumeConfirm')}</span></label><button className="button primary small" disabled={!resumeConfirmed || pending.has(`resume-${workflow.id}`)} onClick={resume}><RefreshCw size={14} />{t('workflow.resume')}</button></div>}
      <div className="workflow-studio">
        <ExecutionGraph key={'workflow:' + workflow.id} graph={workflowGraph(workflow.steps, providers, sessions, workflow.status === 'draft', { edges: previousExecutions.current?.workflowId === workflow.id ? edgeActivity : new Map(), onEnd: endEdgeActivity })} view="workflow" storageKey={'workflow:' + workflow.id} selection={selection} connectable={false} onSelect={setSelection} />
        <aside className="workflow-inspector" aria-label={t('workflow.inspector')}>
          {step && <><div className="workflow-inspector-heading"><h2>{step.title}</h2><Status value={status!} /></div>
          <div className="step-meta"><span>{providers.find(provider => provider.id === step.providerId)?.name ?? step.providerId}</span>{step.modelId && <span>{modelName(providers.find(provider => provider.id === step.providerId), step.modelId)}</span>}</div>
          <h3>{t('common.task')}</h3><pre className="workflow-step-text">{step.prompt}</pre>
          <p className="workflow-inspector-note">{step.dependsOn.length ? t('workflow.dependsOn', { steps: step.dependsOn.map(id => workflow.steps.find(item => item.id === id)?.title ?? id).join(', ') }) : t('workflow.independent')}</p>
          {step.error && <div className="inline-error"><CircleAlert size={14} /><span>{step.error}</span></div>}
          {step.sessionId && <button className="session-link" onClick={() => openSession(step.sessionId!)}><MessageSquare size={13} />{t('workflow.viewOutput')}<ArrowUpRight size={13} /></button>}
          {resumable && ['failed', 'cancelled'].includes(step.status) && <button className="button small workflow-retry" disabled={pending.has(`retry-${workflow.id}-${step.id}`)} onClick={() => void perform(`retry-${workflow.id}-${step.id}`, () => window.workbench.retryWorkflowStep(workflow.id, step.id))}><RefreshCw size={13} />{t('workflow.retryBlocked')}</button>}
          {Boolean(step.attempts?.length) && <details className="attempt-history" open><summary>{t('workflow.attemptCount', { count: step.attempts!.length })}</summary>{step.attempts!.map((attempt, offset) => <div className="attempt-row" key={attempt.id}>
            <span>{t('workflow.attempt', { number: offset + 1 })}</span><Status value={attempt.status === 'running' && attempt.sessionId === step.sessionId ? status! : attempt.status} /><time dateTime={attempt.startedAt}>{formatDate(attempt.startedAt)}</time>
            {attempt.retryOf && <span className="muted">{t('workflow.retry')}</span>}<button className="session-link" onClick={() => openSession(attempt.sessionId)}><MessageSquare size={12} />{t('workflow.viewSession')}</button>{attempt.error && <p className="inline-error">{attempt.error}</p>}
          </div>)}</details>}</>}
          {dependency && <><div className="workflow-inspector-heading"><h2>{t('workflow.dependency')}</h2></div><p className="workflow-inspector-note">{t('workflow.dependencyHint')}</p><div className="workflow-dependency-summary"><strong>{workflow.steps.find(item => item.id === dependency.source)?.title}</strong><ArrowRight size={18} /><strong>{workflow.steps.find(item => item.id === dependency.target)?.title}</strong></div></>}
          {!step && !dependency && <p className="workflow-inspector-note">{t('workflow.selectStep')}</p>}
        </aside>
      </div>
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

export function ProviderGuides({ provider }: { provider: Pick<ProviderInfo, 'id' | 'name' | 'source'> }) {
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
  const cwd = snapshot.workspaces.some(workspace => !workspace.archived && workspace.cwd === directory) ? directory : '';
  const health = useRuntimeHealth(snapshot.providers, cwd);
  const available = health.providers.filter(provider => provider.available).length;
  const directories = snapshot.workspaces.filter((workspace, index, values) => !workspace.archived && values.findIndex(item => !item.archived && item.cwd === workspace.cwd) === index);
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
