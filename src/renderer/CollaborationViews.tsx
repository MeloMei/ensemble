import { AgentIcon } from './AgentIcon';
import { AppSelect } from './AppSelect';
import { Tooltip } from './Tooltip';
import { useTranslation } from 'react-i18next';
import { translate, formatDate, formatNumber } from '../shared/i18n';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowUpRight, Check, ChevronRight, CircleHelp, Clock3, Copy, FileCheck2, FileText, GitBranch, KeyRound, LoaderCircle, Maximize, MessageSquare, Minus, Network, PanelRight, Pause, Play, Plus, RefreshCw, Settings2, Square, Trash2, X } from 'lucide-react';
import type { Connection } from '@xyflow/react';
import { copyGraphView } from './graph-view-state';
import { validateWorkflowDependency } from './workflow-graph';
import { ExecutionGraph, edgeFor, graphNode, type CollaborationNode, type CollaborationEdge, type GraphSelection } from './ExecutionGraph';
import type { CollaborationArtifactVersion, CollaborationDefinition, CollaborationEvent, CollaborationMessage, CollaborationParticipant, CollaborationRun, CollaborationTask, CollaborationTaskTemplate } from '../shared/collaboration';
import type { McpServerConfig, ProviderInfo, PublicCollaborationState, Session, Snapshot } from '../shared/types';
import { DirectoryField, EmptyState, IconButton, Modal, ModelField, ProviderSelect, Status, defaultModelId, modelName, pathName, relativeTime, validModelSelection, type Perform } from './ui';
import { createImplementationReviewDraft, participantPermissionIssue, withCollaborationGoal } from './collaboration-template';
import { projectResourceDelivery, type ResourceDeliveryCount } from './collaboration-resource-delivery';
import '@xyflow/react/dist/style.css';
import './CollaborationViews.css';

const call = (operation: string, input: unknown) => window.workbench.collaborationCall(operation, input);
const requestId = () => crypto.randomUUID();
const relationshipKinds = ['reports-to', 'supervises', 'collaborates-with'];
const relationshipLabel = (kind: string) => relationshipKinds.includes(kind) ? translate(`collaboration:studio.kind.${kind}`) : kind;
const splitValues = (text: string) => [...new Set(text.split(/[,，\n]/).map(value => value.trim()).filter(Boolean))];
const splitRoots = (text: string) => [...new Set(text.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
const dateLabel = (value: string) => formatDate(value, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const participantName = (run: CollaborationRun, id?: string) => id === 'user' ? translate('collaboration:actor.user') : run.definitionSnapshot.participants.find(item => item.id === id)?.name ?? id ?? translate('collaboration:actor.platform');
const deliveryKeys: Record<string, string> = { accepted: "delivery.accepted", queued: "delivery.queued", injected: "delivery.injected", reported: "delivery.reported", failed: "delivery.failed" };
const eventKeys: Record<string, string> = { 'run.created': "event.run.created", 'run.configured': "event.run.configured", 'run.started': "event.run.started", 'run.paused': "event.run.paused", 'run.running': "event.run.running", 'run.cancelled': "event.run.cancelled", 'run.completed': "event.run.completed", 'task.submitted': "event.task.submitted", 'task.attached': "event.task.attached", 'task.dispatched': "event.task.dispatched", 'task.running': "event.task.running", 'task.claimed': "event.task.claimed", 'task.wait_requested': "event.task.wait_requested", 'task.completed': "event.task.completed", 'task.failed': "event.task.failed", 'task.cancelled': "event.task.cancelled", 'task.pending': "event.task.pending", 'task.queued': "event.task.queued", 'task.waiting': "event.task.waiting", 'message.accepted': "event.message.accepted", 'message.injected': "event.message.injected", 'message.reported': "event.message.reported", 'input.injected': "event.input.injected", 'artifact.published': "event.artifact.published", 'artifact.injected': "event.artifact.injected", 'runtime.bound': "event.runtime.bound", 'runtime.usage': "event.runtime.usage", 'runtime.structured': "event.runtime.structured" };
const eventLabel = (type: string) => eventKeys[type] ? translate(`collaboration:${eventKeys[type]}`) : type;
const deliveryLabel = (delivery: string) => deliveryKeys[delivery] ? translate(`collaboration:${deliveryKeys[delivery]}`) : delivery;
function taskDisplayStatus(task: CollaborationTask, sessions: Session[]) {
  if (task.status === 'waiting' && task.waitingForTaskIds?.length) return 'waiting_children';
  if (task.status === 'running') {
    const session = sessions.find(item => item.id === task.sessionId);
    if (session?.status === 'waiting_approval' || session?.status === 'waiting_children') return session.status;
  }
  return task.status;
}
function taskExecutionId(task?: CollaborationTask) {
  if (task?.attemptId) return JSON.stringify([task.id, task.attemptId]);
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
  const { t } = useTranslation('collaboration');
  return <ol className="collaboration-setup-steps" aria-label={t('setup.steps')}>{[t('setup.describe'), t('setup.review'), t('action.start')].map((label, index) => <li key={label} className={index + 1 === current ? 'current' : index + 1 < current ? 'complete' : ''} aria-current={index + 1 === current ? 'step' : undefined}><span>{index + 1 < current ? <Check size={12} /> : index + 1}</span>{label}</li>)}</ol>;
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
  const { t } = useTranslation('collaboration');
  const state = snapshot.collaboration;
  const [selectedId, setSelectedId] = useState<string>();
  const [editing, setEditing] = useState<string>();
  const [connections, setConnections] = useState(false);
  const runs = [...(state?.runs ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const run = runs.find(item => item.id === selectedId) ?? runs[0];
  useEffect(() => { if (run && run.id !== selectedId) setSelectedId(run.id); }, [run?.id, selectedId]);
  const editorRun = editing ? runs.find(item => item.id === editing) : undefined;
  return <div className="collaboration-page">
    <aside className="collaboration-list"><div className="sidebar-heading"><h2>{t('page.title')}</h2><IconButton label={t('action.create')} onClick={() => setEditing('new')}><Plus size={17} /></IconButton></div><p>{t('page.description')}</p>
      <div className="collaboration-run-list">{runs.map(item => <button className={`collaboration-run-item ${run?.id === item.id && !editing ? 'selected' : ''}`} key={item.id} aria-current={run?.id === item.id && !editing ? 'page' : undefined} onClick={() => { setSelectedId(item.id); setEditing(undefined); }}><strong>{item.definitionSnapshot.name}</strong><small>{pathName(item.definitionSnapshot.cwd)} · v{item.definitionVersion}</small><span><Status value={item.status} /><time>{relativeTime(item.updatedAt)}</time></span></button>)}{!runs.length && <p className="collaboration-list-empty">{t('page.emptyRuns')}</p>}</div>
      <button className="button primary" onClick={() => setEditing('new')}><Plus size={14} />{t('action.create')}</button><button className="button subtle" onClick={() => setConnections(true)}><KeyRound size={14} />{t('connection.title')}</button>
    </aside>
    {!state ? <EmptyState icon={<Network size={28} />} title={t('page.unavailable')}>{t('page.reconnect')}</EmptyState> : editing ? <CollaborationEditor key={editing} providers={snapshot.providers} identities={state.identities} initialCwd={initialCwd} run={editorRun} runTasks={state.tasks.filter(task => task.runId === editorRun?.id)} pending={pending} perform={perform} openProviderSettings={openProviderSettings} onClose={() => setEditing(undefined)} onSaved={id => { setSelectedId(id); setEditing(undefined); }} /> : run ? <CollaborationRunView key={run.id} run={run} state={state} stateVersion={snapshot.collaborationEventSeq} providers={snapshot.providers} sessions={snapshot.sessions} perform={perform} pending={pending} openSession={openSession} onEdit={() => setEditing(run.id)} /> : <CollaborationEditor key="first-draft" providers={snapshot.providers} identities={state.identities} initialCwd={initialCwd} pending={pending} perform={perform} openProviderSettings={openProviderSettings} onClose={() => setEditing(undefined)} onSaved={id => { setSelectedId(id); setEditing(undefined); }} />}
    {connections && <ConnectionDialog providers={snapshot.providers} state={state} initialCwd={run?.definitionSnapshot.cwd ?? initialCwd} perform={perform} pending={pending} onClose={() => setConnections(false)} />}
  </div>;
}

function CollaborationEditor({ providers, identities, initialCwd, run, perform, pending, onClose, onSaved, runTasks = [], openProviderSettings }: {
  providers: ProviderInfo[]; identities: PublicCollaborationState['identities']; initialCwd: string; run?: CollaborationRun; perform: Perform; pending: Set<string>; onClose: () => void; onSaved: (id: string) => void; runTasks?: CollaborationTask[]; openProviderSettings?: () => void;
}) {
  const { t, i18n } = useTranslation('collaboration');
  const reducedMotion = useReducedMotion();
  const [initial] = useState(() => run?.definitionSnapshot ?? implementationReviewDefaults(providers, initialCwd));
  const [draftKey] = useState(() => {
    const id = `collaboration:draft:${requestId()}`;
    if (run) {
      copyGraphView(`collaboration:${run.id}:relationships`, `${id}:relationships`);
      const taskIds = Object.fromEntries(runTasks.filter(task => task.templateId).map(task => [`task-${task.id}`, `task-${task.templateId}`]));
      copyGraphView(`collaboration:${run.id}:data`, `${id}:data`, taskIds);
    }
    return id;
  });
  const [templated, setTemplated] = useState(!run);
  const [goal, setGoal] = useState('');
  const goalField = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = goalField.current;
    if (!element) return;
    const resize = () => {
      element.style.height = '0px';
      element.style.height = `${goal ? Math.min(Math.max(element.scrollHeight + 2, 32), 112) : 32}px`;
    };
    resize();
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth; resize();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [goal]);
  const [name, setName] = useState(initial?.name ?? '');
  const [cwd, setCwd] = useState(initial?.cwd ?? initialCwd);
  const [participants, setParticipants] = useState<CollaborationParticipant[]>(initial?.participants ?? []);
  const [relationships, setRelationships] = useState<CollaborationDefinition['relationships']>(initial?.relationships ?? []);
  const [steps, setSteps] = useState<CollaborationTaskTemplate[]>(initial?.steps ?? []);
  const [limits, setLimits] = useState(initial?.limits ?? {});
  const [completion, setCompletion] = useState(initial?.completion ?? 'manual');
  const [view, setView] = useState<'relationships' | 'data'>('relationships');
  const [selection, setSelection] = useState<GraphSelection>();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [graphError, setGraphError] = useState('');
  const key = run ? `collaboration-update-${run.id}` : 'collaboration-create';
  const busy = pending.has(key);
  const select = (value?: GraphSelection) => { setSelection(value); setInspectorOpen(true); };
  const update = (id: string, patch: Partial<CollaborationParticipant>) => !busy && setParticipants(items => items.map(item => item.id === id ? { ...item, ...patch } : item));
  const updateRelationship = (id: string, patch: Partial<CollaborationDefinition['relationships'][number]>) => !busy && setRelationships(items => items.map(item => item.id === id ? { ...item, ...patch } : item));
  const setAccess = (participant: CollaborationParticipant, access: 'read-only' | 'read-write') => update(participant.id, { permissions: { ...participant.permissions, workspace: { cwd: participant.permissions.workspace?.cwd ?? participant.cwd ?? cwd, access } }, settings: { ...participant.settings, permission: access === 'read-only' ? 'read-only' : providers.find(provider => provider.id === participant.providerId)?.capabilities.permissions ? 'review' : undefined } });
  const setProvider = (participant: CollaborationParticipant, providerId: string) => {
    const provider = providers.find(item => item.id === providerId);
    update(participant.id, { providerId, modelId: defaultModelId(provider), settings: { ...participant.settings, effort: undefined, permission: participant.settings?.permission === 'review' && !provider?.capabilities.permissions ? undefined : participant.settings?.permission } });
  };
  const permissionIssues = participants.flatMap(participant => { const issue = participantPermissionIssue(participant, providers.find(provider => provider.id === participant.providerId)); return issue ? [{ id: participant.id, message: issue }] : []; });
  const selectionsValid = participants.every(item => item.mode === 'external' || validModelSelection(providers.find(provider => provider.id === item.providerId), item.modelId));
  const valid = Boolean(name.trim() && cwd.trim() && (!templated || goal.trim()) && (!goal.trim() || steps.length > 0) && participants.length && !permissionIssues.length && selectionsValid && participants.every(item => item.name.trim()) && relationships.every(relation => relation.kind.trim() && relation.from !== relation.to) && steps.every(step => step.title.trim() && step.prompt.trim() && participants.some(item => item.id === step.participantId)));
  const save = (event: FormEvent) => {
    event.preventDefault(); if (!valid || busy) return;
    void perform(key, async () => {
      const definition = withCollaborationGoal({ name: name.trim(), cwd: cwd.trim(), participants: participants.map(item => ({ ...item, name: item.name.trim(), cwd: item.cwd?.trim() || cwd.trim(), permissions: { ...item.permissions, workspace: { cwd: item.cwd?.trim() || cwd.trim(), access: item.permissions.workspace?.access ?? 'read-only' } } })), relationships, steps, limits, completion }, goal);
      const { cwd: _immutableCwd, ...versionInput } = definition;
      const result = await call(run ? 'update_run' : 'create_run', run
        ? { requestId: requestId(), ...versionInput, runId: run.id, expectedVersion: run.definitionVersion }
        : { requestId: requestId(), ...definition, start: false }) as { runId: string };
      const savedId = result.runId ?? run!.id;
      copyGraphView(`${draftKey}:relationships`, `collaboration:${savedId}:relationships`);
      try {
        const saved = await call('get_run', { runId: savedId }) as { tasks: CollaborationTask[] };
        const taskIds = Object.fromEntries(saved.tasks.filter(task => task.templateId).map(task => [`task-${task.templateId}`, `task-${task.id}`]));
        copyGraphView(`${draftKey}:data`, `collaboration:${savedId}:data`, taskIds);
      } catch { /* The saved draft remains available if its optional layout readback fails. */ }
      onSaved(savedId);
    });
  };
  const removeStep = (id: string) => setSteps(items => items.filter(item => item.id !== id).map(item => ({ ...item, dependsOn: item.dependsOn.filter(dependency => dependency !== id) })));
  const removeParticipant = (id: string) => {
    const removedSteps = new Set(steps.filter(step => step.participantId === id).map(step => step.id));
    setParticipants(items => items.filter(item => item.id !== id).map(item => ({ ...item, permissions: { ...item.permissions, ...(item.permissions.allowedTargets ? { allowedTargets: item.permissions.allowedTargets.filter(target => target !== id) } : {}) } })));
    setRelationships(items => items.filter(item => item.from !== id && item.to !== id));
    setSteps(items => items.filter(item => !removedSteps.has(item.id)).map(item => ({ ...item, dependsOn: item.dependsOn.filter(dependency => !removedSteps.has(dependency)) })));
    setSelection(undefined); setInspectorOpen(false);
  };
  const addParticipant = () => {
    const provider = providers.find(item => item.available && item.capabilities.permissions) ?? providers.find(item => item.available);
    const participant: CollaborationParticipant = { id: requestId(), name: `Agent ${participants.length + 1}`, mode: 'managed', roles: [], providerId: provider?.id, modelId: defaultModelId(provider), settings: provider?.capabilities.permissions ? { permission: 'read-only' } : {}, permissions: { submitTasks: false, sendMessages: false, configureRun: false, publishArtifacts: false, workspace: { cwd, access: 'read-only' } } };
    setParticipants(items => [...items, participant]); setView('relationships'); select({ kind: 'participant', id: participant.id });
  };
  const chooseTemplate = () => {
    const template = implementationReviewDefaults(providers, cwd);
    setName(template.name); setParticipants(template.participants); setRelationships(template.relationships); setSteps(template.steps); setLimits(template.limits); setCompletion(template.completion ?? 'all-tasks');
    setTemplated(true); setSelection(undefined); setView('relationships'); setGraphError('');
  };
  const blank = () => { setName(''); setParticipants([]); setRelationships([]); setSteps([]); setLimits({}); setCompletion('manual'); setTemplated(false); setGoal(''); setSelection(undefined); setInspectorOpen(false); setGraphError(''); };
  const addRelationship = (source = participants[0]?.id, target = participants[1]?.id) => {
    if (!source || !target || source === target) return;
    const relation = { id: requestId(), from: source, to: target, kind: 'reports-to' };
    setRelationships(items => [...items, relation]); select({ kind: 'relationship', id: relation.id });
  };
  const updateDependency = (source: string, target: string, enabled: boolean) => {
    const error = validateWorkflowDependency(steps, source, target);
    if (enabled && (error === 'self' || error === 'cycle')) { setGraphError(t('studio.dependencyCycle')); return; }
    setGraphError('');
    setSteps(items => items.map(item => item.id === target ? { ...item, dependsOn: enabled ? [...new Set([...item.dependsOn, source])] : item.dependsOn.filter(id => id !== source) } : item));
  };
  const connect = (connection: Connection) => {
    if (busy || !connection.source || !connection.target || connection.source === connection.target) return;
    if (view === 'relationships') {
      if (participants.some(item => item.id === connection.source) && participants.some(item => item.id === connection.target)) addRelationship(connection.source, connection.target);
    } else {
      const source = connection.source.replace(/^task-/, ''), target = connection.target.replace(/^task-/, '');
      if (steps.some(item => item.id === source) && steps.some(item => item.id === target)) { updateDependency(source, target, true); select({ kind: 'task', id: target }); }
    }
  };
  const graph = useMemo(() => view === 'relationships' ? {
    nodes: participants.map(participant => graphNode(participant.id, { kind: 'participant', title: participant.name || t('participant.unnamed'), subtitle: participant.roles.join(' · ') || t('participant.noRoles'), detail: participant.mode === 'external' ? t('participant.externalConnection') : [providers.find(provider => provider.id === participant.providerId)?.name ?? participant.providerId, participant.modelId].filter(Boolean).join(' · '), external: participant.mode === 'external', recipientProviderId: participant.providerId })),
    edges: relationships.map(relation => edgeFor(`configured-${relation.id}`, relation.from, relation.to, relation.label || relationshipLabel(relation.kind), { kind: 'relationship', id: relation.id }, true)),
  } : {
    nodes: steps.map(step => graphNode(`task-${step.id}`, { kind: 'task', title: step.title || t('task.unnamed'), subtitle: participants.find(item => item.id === step.participantId)?.name ?? '', detail: step.prompt.slice(0, 100) })),
    edges: steps.flatMap(step => step.dependsOn.map(dependency => edgeFor(`dependency-${dependency}-${step.id}`, `task-${dependency}`, `task-${step.id}`, t('graph.waitForCompletion'), { kind: 'task', id: step.id }, true))),
  }, [view, participants, relationships, steps, providers, i18n.resolvedLanguage]);
  const selectedStep = selection?.kind === 'task' ? steps.find(step => step.id === selection.id) : undefined;
  const participant = selection?.kind === 'participant' ? participants.find(item => item.id === selection.id) : selectedStep ? participants.find(item => item.id === selectedStep.participantId) : undefined;
  const relation = selection?.kind === 'relationship' ? relationships.find(item => item.id === selection.id) : undefined;
  const participantSteps = selectedStep ? [selectedStep] : participant ? steps.filter(step => step.participantId === participant.id) : [];
  const storageKey = `${draftKey}:${view}`;
  return <section className="collaboration-editor collaboration-studio">
    <form onSubmit={save} className="collaboration-studio-form">
      <header className="collaboration-studio-heading"><div><div className="collaboration-heading-kicker"><Network size={12} />{t('studio.title')}</div><h1>{run ? t('setup.edit') : t('action.create')}</h1></div><div className="collaboration-studio-actions"><button className="button small" type="button" disabled={busy} onClick={onClose}>{t('action.cancel')}</button><button className="button primary small" disabled={!valid || busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{run ? t('action.saveVersion') : t('studio.saveDraft')}</button></div></header>
      <fieldset disabled={busy} className="collaboration-studio-fields">
        <div className="collaboration-studio-overview"><label>{t('field.name')}<input value={name} maxLength={200} required onChange={event => setName(event.target.value)} placeholder={t('field.namePlaceholder')} /></label><label>{t('field.projectDirectory')}{run ? <input value={cwd} readOnly /> : <DirectoryField value={cwd} onChange={setCwd} perform={perform} />}</label><label className="collaboration-studio-goal">{t('setup.goal')}<textarea ref={goalField} rows={1} maxLength={100000} value={goal} required={templated} onChange={event => setGoal(event.target.value)} placeholder={run ? t('studio.goalUpdate') : t('setup.goalPlaceholder')} />{goal.trim() && !steps.length && <small role="status">{t('studio.goalNeedsTasks')}</small>}</label></div>
        <div className="collaboration-toolbar"><div className="collaboration-view-switch" role="tablist" aria-label={t('run.views')}><button type="button" role="tab" aria-selected={view === 'relationships'} className={view === 'relationships' ? 'active' : ''} onClick={() => setView('relationships')}><Network size={14} />{t('run.relationships')}</button><button type="button" role="tab" aria-selected={view === 'data'} className={view === 'data' ? 'active' : ''} onClick={() => setView('data')}><GitBranch size={14} />{t('studio.executionOrder')}</button></div><div className="collaboration-toolbar-actions"><button className="button small" type="button" onClick={addParticipant}><Plus size={13} />{t('studio.addAgent')}</button><button className="button small" type="button" disabled={participants.length < 2} onClick={() => { setView('relationships'); addRelationship(); }}><GitBranch size={13} />{t('relationship.add')}</button><IconButton label={t('studio.overview')} onClick={() => select()}><Settings2 size={15} /></IconButton><IconButton label={inspectorOpen ? t('detail.collapse') : t('detail.expand')} aria-expanded={inspectorOpen} onClick={() => setInspectorOpen(value => !value)}><PanelRight size={15} /></IconButton></div></div>
        <div className="collaboration-studio-hint"><span>{view === 'relationships' ? t('studio.relationshipHint') : t('studio.executionHint')}</span>{!run && <div><button className="text-button" type="button" onClick={chooseTemplate}>{t('template.name')}</button><button className="text-button" type="button" onClick={blank}>{t('studio.blank')}</button></div>}</div>
        {graphError && <p className="collaboration-inline-error" role="alert">{graphError}</p>}
        <div className="collaboration-studio-workspace"><ExecutionGraph key={storageKey} storageKey={storageKey} graph={graph} view={view} selection={selection} connectable={!busy} onSelect={select} onConnect={connect} onPaneClick={() => setInspectorOpen(false)}>{!graph.nodes.length && <div className="collaboration-studio-empty"><Network size={28} /><strong>{view === 'relationships' ? t('studio.emptyTitle') : t('studio.emptyTasks')}</strong><p>{view === 'relationships' ? t('studio.emptyDescription') : t('studio.emptyTasksDescription')}</p><button className="button primary small" type="button" disabled={busy} onClick={addParticipant}><Plus size={14} />{t('studio.addAgent')}</button></div>}</ExecutionGraph>
          <AnimatePresence initial={false}>{inspectorOpen && <motion.aside key="inspector" className="collaboration-studio-inspector collaboration-editor-body" initial={reducedMotion ? false : { opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={reducedMotion ? undefined : { opacity: 0, x: 12 }} transition={{ duration: 0.16 }} aria-label={t('studio.inspector')}><div className="collaboration-studio-inspector-heading"><strong>{selectedStep ? t('studio.taskDetails') : participant ? t('studio.agentDetails') : relation ? t('studio.relationshipDetails') : t('studio.overview')}</strong><IconButton label={t('detail.collapse')} onClick={() => setInspectorOpen(false)}><X size={15} /></IconButton></div>
          {participant ? <div key={selectedStep?.id ?? participant.id}>
        {!selectedStep && <><div className="participant-editor-heading"><strong>{participant.name || t('participant.unnamed')}</strong><IconButton label={t('participant.delete', { name: participant.name })} disabled={busy} onClick={() => removeParticipant(participant.id)}><Trash2 size={14} /></IconButton></div>
        <div className="collaboration-form-grid"><label>{t('field.displayName')}<input value={participant.name} required onChange={event => update(participant.id, { name: event.target.value })} /></label></div>
        <label>{t('field.roles')}<ListInput values={participant.roles} onChange={roles => update(participant.id, { roles })} placeholder={t('field.rolesPlaceholder')} /></label>
        <label>{t('field.instructions')}<textarea rows={2} value={participant.instructions ?? ''} onChange={event => update(participant.id, { instructions: event.target.value })} placeholder={t('field.instructionsPlaceholder')} /></label>
        {participant.mode === 'managed' ? <div className="collaboration-form-grid"><label>{t('field.runtime')}<ProviderSelect providers={providers} value={participant.providerId ?? ''} onChange={providerId => setProvider(participant, providerId)} /></label><ModelField provider={providers.find(item => item.id === participant.providerId)} value={participant.modelId} disabled={busy} onChange={modelId => update(participant.id, { modelId: modelId || undefined })} /></div> : <label>{t('field.identity')}<AppSelect disabled={busy} label={t('field.identity')} value={participant.binding?.identityId ?? ''} onChange={value => update(participant.id, { binding: value ? { identityId: value } : undefined })} options={[{ value: '', label: t('field.identityLater') }, ...identities.filter(item => !item.revokedAt).map(item => ({ value: item.id, label: item.name }))]} /></label>}
        <details className="collaboration-advanced"><summary>{t('studio.agentAdvanced')}</summary><label>{t('field.connectionMode')}<AppSelect disabled={busy} label={t('field.connectionMode')} value={participant.mode} onChange={value => update(participant.id, { mode: value as 'managed' | 'external' })} options={[{ value: 'managed', label: t('participant.managedOption') }, { value: 'external', label: t('participant.externalOption') }]} /></label>
        <div className="collaboration-form-grid"><label>{t('field.executionDirectory')} <span className="optional">{t('field.defaultProjectDirectory')}</span><input value={participant.cwd ?? ''} placeholder={cwd} onChange={event => update(participant.id, { cwd: event.target.value })} /></label><label>{participant.mode === 'external' ? t('permission.platformFiles') : t('permission.files')}<AppSelect disabled={busy} label={participant.mode === 'external' ? t('permission.platformFiles') : t('permission.files')} value={participant.permissions.workspace?.access ?? 'read-only'} aria-invalid={permissionIssues.some(issue => issue.id === participant.id)} aria-describedby={permissionIssues.some(issue => issue.id === participant.id) ? `permission-issue-${participant.id}` : undefined} onChange={value => setAccess(participant, value as 'read-only' | 'read-write')} options={[{ value: 'read-only', label: t('permission.readOnly'), disabled: participant.mode === 'managed' && !providers.find(provider => provider.id === participant.providerId)?.capabilities.permissions }, { value: 'read-write', label: t('permission.readWriteRoots') }]} /></label></div>
        {permissionIssues.filter(issue => issue.id === participant.id).map(issue => <p className="collaboration-field-error" id={`permission-issue-${participant.id}`} role="alert" key={issue.id}>{issue.message}</p>)}
        {participant.mode === 'managed' && !providers.find(provider => provider.id === participant.providerId)?.capabilities.permissions && participant.permissions.workspace?.access === 'read-write' && <p className="collaboration-observation-note">{t('permission.runtimeNote')}</p>}
        {participant.mode === 'external' && <p className="collaboration-observation-note">{t('permission.externalNote')}</p>}
        <fieldset className="collaboration-permissions"><legend>{t('permission.collaboration')}</legend>{([{ key: 'submitTasks', label: t('action.submitTask') }, { key: 'sendMessages', label: t('action.sendMessage') }, { key: 'publishArtifacts', label: t('action.publishArtifact') }, { key: 'configureRun', label: t('permission.configureRun') }] as const).map(permission => <label key={permission.key}><input type="checkbox" checked={participant.permissions[permission.key]} onChange={event => update(participant.id, { permissions: { ...participant.permissions, [permission.key]: event.target.checked } })} />{permission.label}</label>)}</fieldset>
        <details className="collaboration-advanced"><summary>{t('permission.scope')}</summary><label className="collaboration-checkbox"><input type="checkbox" checked={participant.permissions.allowedTargets !== undefined} onChange={event => update(participant.id, { permissions: { ...participant.permissions, allowedTargets: event.target.checked ? [] : undefined } })} />{t('permission.limitTargets')}</label>{participant.permissions.allowedTargets && <div className="collaboration-check-list">{participants.filter(item => item.id !== participant.id).map(target => <label key={target.id}><input type="checkbox" checked={participant.permissions.allowedTargets!.includes(target.id)} onChange={event => update(participant.id, { permissions: { ...participant.permissions, allowedTargets: event.target.checked ? [...participant.permissions.allowedTargets!, target.id] : participant.permissions.allowedTargets!.filter(id => id !== target.id) } })} />{target.name}</label>)}</div>}{participant.mode === 'managed' && Boolean(providers.find(item => item.id === participant.providerId)?.efforts?.length) && <label>{t('field.effort')}<AppSelect disabled={busy} label={t('field.effort')} value={participant.settings?.effort ?? ''} onChange={value => update(participant.id, { settings: { ...participant.settings, effort: value || undefined } })} options={[{ value: '', label: t('field.runtimeDefault') }, ...(providers.find(item => item.id === participant.providerId)?.efforts?.map(effort => ({ value: effort, label: effort })) ?? [])]} /></label>}<p>{t('permission.toolsNote')}</p></details></details></>}
          <div className="collaboration-section-heading"><h2>{selectedStep ? t('studio.taskDetails') : t('tasks.preset')}</h2>{!selectedStep && <button className="button small" type="button" onClick={() => setSteps(items => [...items, { id: requestId(), title: '', participantId: participant.id, prompt: '', dependsOn: [], artifactIds: [] }])}><Plus size={13} />{t('task.add')}</button>}</div><p className="collaboration-studio-explanation">{t('studio.taskHint')}</p>
{participantSteps.map(step => <article className="participant-editor" key={step.id}><div className="collaboration-form-grid"><label>{t('task.name')}<input value={step.title} required onChange={event => setSteps(items => items.map(item => item.id === step.id ? { ...item, title: event.target.value } : item))} /></label><label>{t('task.assignee')}<AppSelect disabled={busy} label={t('task.assignee')} value={step.participantId} onChange={value => setSteps(items => items.map(item => item.id === step.id ? { ...item, participantId: value } : item))} options={participants.map(item => ({ value: item.id, label: item.name }))} /></label></div><label>{t('task.requirements')}<textarea rows={3} value={step.prompt} required onChange={event => setSteps(items => items.map(item => item.id === step.id ? { ...item, prompt: event.target.value } : item))} /></label><div className="collaboration-check-list"><span>{t('task.dependencies')}</span>{steps.filter(item => item.id !== step.id).map(target => <label key={target.id}><input type="checkbox" checked={step.dependsOn.includes(target.id)} disabled={!step.dependsOn.includes(target.id) && validateWorkflowDependency(steps, target.id, step.id) === 'cycle'} onChange={event => updateDependency(target.id, step.id, event.target.checked)} />{target.title || t('task.unnamed')}</label>)}<IconButton label={t('task.deletePreset')} onClick={() => removeStep(step.id)}><Trash2 size={14} /></IconButton></div></article>)}
          </div> : relation ? <div key={relation.id} className="collaboration-studio-relation"><label>{t('relationship.from')}<AppSelect disabled={busy} label={t('relationship.from')} value={relation.from} onChange={from => updateRelationship(relation.id, { from })} options={participants.map(item => ({ value: item.id, label: item.name, disabled: item.id === relation.to }))} /></label><button className="button small" type="button" onClick={() => updateRelationship(relation.id, { from: relation.to, to: relation.from })}><RefreshCw size={13} />{t('studio.reverseDirection')}</button><label>{t('relationship.to')}<AppSelect disabled={busy} label={t('relationship.to')} value={relation.to} onChange={to => updateRelationship(relation.id, { to })} options={participants.map(item => ({ value: item.id, label: item.name, disabled: item.id === relation.from }))} /></label><label>{t('studio.relationshipType')}<AppSelect disabled={busy} label={t('studio.relationshipType')} value={relationshipKinds.includes(relation.kind) ? relation.kind : 'custom'} onChange={kind => updateRelationship(relation.id, { kind: kind === 'custom' ? '' : kind, label: undefined })} options={[...relationshipKinds.map(kind => ({ value: kind, label: relationshipLabel(kind) })), { value: 'custom', label: t('studio.customType') }]} /></label><label>{t('studio.relationshipLabel')}<input value={relation.label ?? ''} onChange={event => updateRelationship(relation.id, { label: event.target.value || undefined })} placeholder={relationshipLabel(relation.kind)} /></label><p className="collaboration-studio-explanation">{t('studio.relationshipSemantics')}</p><details className="collaboration-advanced" open={!relationshipKinds.includes(relation.kind)}><summary>{t('studio.customType')}</summary><label>{t('relationship.description')}<input value={relation.kind} required onChange={event => updateRelationship(relation.id, { kind: event.target.value })} /></label></details><button className="button small danger" type="button" onClick={() => { setRelationships(items => items.filter(item => item.id !== relation.id)); setSelection(undefined); setInspectorOpen(false); }}><Trash2 size={13} />{t('relationship.delete')}</button></div> : <div><p className="collaboration-studio-explanation">{run ? t('setup.versionNote', { version: run.definitionVersion }) : t('studio.saveFirst')}</p>
      <label>{t('field.completion')}<AppSelect disabled={busy} label={t('field.completion')} value={completion} onChange={value => setCompletion(value as 'manual' | 'all-tasks')} options={[{ value: 'manual', label: t('completion.manual') }, { value: 'all-tasks', label: t('completion.allTasks') }]} /></label>
      <details className="collaboration-advanced"><summary>{t('limits.title')} <span className="optional">{t('limits.help')}</span></summary><div className="collaboration-form-grid">{([{ key: 'maxConcurrentTasks', label: t('limits.concurrent') }, { key: 'maxTasks', label: t('limits.tasks') }, { key: 'maxAttemptsPerTask', label: t('limits.attempts') }, { key: 'maxTaskTurns', label: t('limits.turns') }] as const).map(item => <label key={item.key}>{item.label}<input type="number" min={1} step={1} value={limits[item.key] ?? ''} onChange={event => setLimits(current => ({ ...current, [item.key]: event.target.value ? Number(event.target.value) : undefined }))} /></label>)}</div><p>{t('limits.note')}</p></details>
          {openProviderSettings && <button className="text-button" type="button" onClick={openProviderSettings}>{t('setup.connectionHelp')}</button>}
          {permissionIssues.map(issue => <button className="collaboration-studio-issue" type="button" key={issue.id} onClick={() => select({ kind: 'participant', id: issue.id })}>{issue.message}</button>)}
          </div>}
          </motion.aside>}</AnimatePresence>
        </div>
      </fieldset>
      <footer className="collaboration-studio-footer"><span>{t('studio.selectionHint')}</span><span>{t('studio.summary', { agents: participants.length, tasks: steps.length, relations: relationships.length })}</span>{permissionIssues.length > 0 && <button className="text-button" type="button" onClick={() => select({ kind: 'participant', id: permissionIssues[0].id })}>{t('studio.permissionIssues', { count: permissionIssues.length })}</button>}</footer>
    </form>
  </section>;
}


function handoffEdgeId(event: CollaborationEvent, view: 'relationships' | 'data') {
  if (!['message.injected', 'message.reported', 'artifact.injected'].includes(event.type)) return;
  if (view === 'relationships' && event.participantId && event.targetParticipantId) return `observed-${event.participantId}:${event.targetParticipantId}:${event.type}`;
  if (view === 'data' && event.type === 'artifact.injected' && event.artifactVersionId && event.taskId) return `input-${event.artifactVersionId}-${event.taskId}`;
  if (view === 'data' && event.messageId) return `message-${event.messageId}`;
}

function buildGraph(run: CollaborationRun, participants: CollaborationParticipant[], tasks: CollaborationTask[], messages: CollaborationMessage[], artifacts: CollaborationArtifactVersion[], events: CollaborationEvent[], view: 'relationships' | 'data', sessions: Session[]) {
  const nodes: CollaborationNode[] = [], edges: CollaborationEdge[] = [];
  const resourceDelivery = projectResourceDelivery(tasks, messages, events);
  if (view === 'relationships') {
    for (const participant of participants) {
      const active = tasks.filter(task => task.participantId === participant.id);
      const current = run.definitionSnapshot.participants.some(item => item.id === participant.id);
      const currentTask = active.find(task => task.status === 'running') ?? active.find(task => ['waiting', 'queued'].includes(task.status));
      nodes.push(graphNode(participant.id, { kind: 'participant', title: participant.name, subtitle: participant.roles.join(' · ') || translate('collaboration:participant.noRoles'), detail: !current ? translate('collaboration:participant.historical') : participant.mode === 'managed' ? [participant.providerId, participant.modelId].filter(Boolean).join(' · ') : translate('collaboration:participant.platformRecordsOnly'), external: participant.mode === 'external', status: currentTask ? taskDisplayStatus(currentTask, sessions) : undefined, recipientProviderId: participant.providerId, executionId: taskExecutionId(currentTask), executionActive: currentTask?.status === 'running', resourceDelivery: resourceDelivery.participantCounts.get(participant.id) }));
    }
    if (events.some(event => event.participantId === 'user' || event.targetParticipantId === 'user')) nodes.push(graphNode('user', { kind: 'participant', title: translate('collaboration:actor.user'), subtitle: translate('collaboration:participant.actionSource'), detail: translate('collaboration:participant.platformActions') }));
    const ids = new Set(nodes.map(node => node.id));
    for (const relation of run.definitionSnapshot.relationships) if (ids.has(relation.from) && ids.has(relation.to)) edges.push(edgeFor(`configured-${relation.id}`, relation.from, relation.to, relation.label || relationshipLabel(relation.kind), { kind: 'relationship', id: relation.id }, true));
    const groups = new Map<string, { from: string; to: string; type: string; ids: string[] }>();
    for (const event of events) {
      if (!event.participantId || !event.targetParticipantId || !ids.has(event.participantId) || !ids.has(event.targetParticipantId)) continue;
      const key = `${event.participantId}:${event.targetParticipantId}:${event.type}`;
      const group = groups.get(key) ?? { from: event.participantId, to: event.targetParticipantId, type: event.type, ids: [] };
      group.ids.push(event.id); groups.set(key, group);
    }
    for (const [key, group] of groups) edges.push(edgeFor(`observed-${key}`, group.from, group.to, `${eventLabel(group.type)}${group.ids.length > 1 ? ` ×${group.ids.length}` : ''}`, { kind: 'events', ids: group.ids }));
  } else {
    for (const task of tasks) nodes.push(graphNode(`task-${task.id}`, { kind: 'task', title: task.title, subtitle: task.participantSnapshot.name, detail: translate('collaboration:graph.taskDetail', { count: task.attempts.length, version: task.definitionVersion }), status: taskDisplayStatus(task, sessions), recipientProviderId: task.participantSnapshot.providerId, executionId: taskExecutionId(task), executionActive: task.status === 'running', resourceDelivery: resourceDelivery.taskCounts.get(task.id) }));
    for (const artifact of artifacts) nodes.push(graphNode(`artifact-${artifact.id}`, { kind: 'artifact', title: artifact.name, subtitle: translate('collaboration:graph.artifactVersion', { version: artifact.version, kind: artifact.kind }), detail: artifact.sha256.slice(0, 16) }));
    const taskIds = new Set(tasks.map(task => task.id)), artifactIds = new Set(artifacts.map(artifact => artifact.id));
    for (const task of tasks) {
      for (const dependency of task.dependsOn) if (taskIds.has(dependency)) edges.push(edgeFor(`dependency-${dependency}-${task.id}`, `task-${dependency}`, `task-${task.id}`, translate('collaboration:graph.waitForCompletion'), { kind: 'task', id: task.id }, true));
      for (const input of resourceDelivery.inputs.get(task.id) ?? []) if (artifactIds.has(input.artifactId)) {
        const delivered = input.statuses.some(status => status === 'injected' || status === 'reported');
        const stateLabel = input.statuses.map(status => translate(`collaboration:resource.delivery.${status}`)).join(' · ');
        const inputEdge = edgeFor(`input-${input.artifactId}-${task.id}`, `artifact-${input.artifactId}`, `task-${task.id}`, input.historical ? translate('collaboration:resource.historicalInput', { status: stateLabel }) : stateLabel, { kind: 'artifact', id: input.artifactId }, !delivered, delivered);
        if (input.historical) inputEdge.data = { ...inputEdge.data, historicalResourceInput: true };
        inputEdge.className = [inputEdge.className, ...input.statuses.map(status => `collaboration-resource-edge-${status}`)].filter(Boolean).join(' ');
        edges.push(inputEdge);
      }
    }
    for (const artifact of artifacts) if (artifact.taskId && taskIds.has(artifact.taskId)) edges.push(edgeFor(`output-${artifact.id}`, `task-${artifact.taskId}`, `artifact-${artifact.id}`, translate('collaboration:graph.output'), { kind: 'artifact', id: artifact.id }));
    for (const message of messages) if (message.taskId && message.targetTaskId && message.taskId !== message.targetTaskId && taskIds.has(message.taskId) && taskIds.has(message.targetTaskId)) edges.push(edgeFor(`message-${message.id}`, `task-${message.taskId}`, `task-${message.targetTaskId}`, deliveryLabel(message.delivery), { kind: 'message', id: message.id }, false, ['injected', 'reported'].includes(message.delivery)));
  }
  return { nodes, edges };
}


function CollaborationRunView({ run, state, stateVersion, providers, sessions, perform, pending, openSession, onEdit }: { run: CollaborationRun; state: PublicCollaborationState; stateVersion?: number; providers: ProviderInfo[]; sessions: Session[]; perform: Perform; pending: Set<string>; openSession: (id: string) => void; onEdit: () => void }) {
  const { t, i18n } = useTranslation('collaboration');
  const reducedMotion = useReducedMotion();
  const tasks = state.tasks.filter(item => item.runId === run.id), messages = state.messages.filter(item => item.runId === run.id), artifacts = state.artifacts.filter(item => item.runId === run.id);
  const [view, setView] = useState<'relationships' | 'data'>('relationships');
  const [handoffs, setHandoffs] = useState<{ view: typeof view; events: CollaborationEvent[] }>({ view, events: [] });
  const feedbackContext = useRef({ view, afterSeq: stateVersion ?? 0, reducedMotion });
  feedbackContext.current.reducedMotion = reducedMotion;
  const changeView = (next: typeof view) => {
    if (next === view) return;
    feedbackContext.current = { view: next, afterSeq: stateVersion ?? 0, reducedMotion };
    setHandoffs({ view: next, events: [] });
    setView(next);
  };
  const finishHandoff = useCallback((seq: number) => setHandoffs(current => ({ ...current, events: current.events.filter(event => event.seq !== seq) })), []);
  useEffect(() => {
    if (reducedMotion) { setHandoffs(current => current.events.length ? { ...current, events: [] } : current); return; }
    if (!handoffs.events.length) return;
    const timer = window.setTimeout(() => setHandoffs(current => ({ ...current, events: [] })), 700);
    return () => window.clearTimeout(timer);
  }, [handoffs, reducedMotion]);
  const [selection, setSelection] = useState<GraphSelection>();
  const [selectionOpen, setSelectionOpen] = useState(false);
  const selectRecord = (value: GraphSelection) => { setSelection(value); setSelectionOpen(true); };
  const [composer, setComposer] = useState<'task' | 'message' | 'artifact'>();
  const [connection, setConnection] = useState<Connection>();
  const [events, setEvents] = useState<CollaborationEvent[]>([]);
  const [eventError, setEventError] = useState('');
  const [more, setMore] = useState(false);
  const [timeline, setTimeline] = useState(true);
  const historyCursor = useRef(0);
  const liveCursor = useRef(stateVersion);
  const initialEventRead = useRef(true);
  const failedEventRead = useRef<'history' | 'live' | undefined>(undefined);
  const eventRead = useRef<{ active: boolean; historyRequested: boolean; liveRequested?: typeof feedbackContext.current; promise?: Promise<void> }>({ active: true, historyRequested: false });
  const revision = [stateVersion, run.updatedAt, ...tasks.map(item => item.updatedAt), ...messages.map(item => `${item.id}:${item.delivery}`), artifacts.length].join('|');
  const loadEvents = useCallback((source: 'history' | 'live') => {
    const read = eventRead.current;
    if (source === 'history') read.historyRequested = true;
    else read.liveRequested = feedbackContext.current;
    if (read.promise) return read.promise;
    const drain = async () => {
      while (read.active && (read.historyRequested || read.liveRequested)) {
        const source = read.liveRequested && liveCursor.current !== undefined ? 'live' : 'history';
        const afterSeq = source === 'live' ? liveCursor.current! : historyCursor.current;
        const requestedView = read.liveRequested;
        if (source === 'live') read.liveRequested = undefined;
        else read.historyRequested = false;
        try {
          const incoming = await window.workbench.queryCollaborationEvents(run.id, afterSeq, 500);
          if (!read.active) return;
          const context = feedbackContext.current;
          const fresh = source === 'live' && !context.reducedMotion && requestedView === context
            ? incoming.filter(event => event.seq > Math.max(afterSeq, context.afterSeq) && handoffEdgeId(event, context.view)) : [];
          if (fresh.length) setHandoffs(current => ({ view: context.view, events: [...(current.view === context.view ? current.events : []), ...fresh] }));
          const nextSeq = Math.max(afterSeq, incoming.at(-1)?.seq ?? afterSeq);
          if (source === 'live') {
            liveCursor.current = nextSeq;
            if (incoming.length === 500) read.liveRequested ??= requestedView;
          } else {
            historyCursor.current = nextSeq;
            setMore(incoming.length === 500);
            if (liveCursor.current === undefined) {
              if (incoming.length === 500) read.historyRequested = true;
              else liveCursor.current = nextSeq;
            }
          }
          setEvents(previous => [...new Map([...previous, ...incoming].map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq));
          if (!failedEventRead.current || failedEventRead.current === source) { failedEventRead.current = undefined; setEventError(''); }
        } catch (reason) {
          if (read.active) { failedEventRead.current = source; setEventError(reason instanceof Error ? reason.message : String(reason)); }
          break;
        }
      }
    };
    read.promise = drain().finally(() => { read.promise = undefined; });
    return read.promise;
  }, [run.id]);
  useEffect(() => {
    const read = eventRead.current;
    read.active = true;
    return () => { read.active = false; read.historyRequested = false; read.liveRequested = undefined; };
  }, []);
  useEffect(() => {
    const source = initialEventRead.current ? 'history' : 'live';
    initialEventRead.current = false;
    void loadEvents(source);
  }, [revision, loadEvents]);
  const participants = useMemo(() => recordedParticipants(run, state, events), [run, state, events]);
  const graph = useMemo(() => {
    const result = buildGraph(run, participants, tasks, messages, artifacts, events, view, sessions);
    if (reducedMotion || handoffs.view !== view || !handoffs.events.length) return result;
    return { ...result, edges: result.edges.map(edge => ({ ...edge, data: { ...edge.data,
      handoffSeqs: edge.data?.configured || edge.data?.historicalResourceInput ? [] : handoffs.events.filter(event => handoffEdgeId(event, view) === edge.id).map(event => event.seq), onHandoffEnd: finishHandoff,
    } })) };
  }, [run, state, events, view, participants, sessions, i18n.resolvedLanguage, handoffs, reducedMotion, finishHandoff]);
  const control = (action: string) => void perform(`collaboration-control-${run.id}`, () => call('control_run', { requestId: requestId(), runId: run.id, action }));
  const busy = pending.has(`collaboration-control-${run.id}`);
  return <section className="collaboration-run-view"><div className="collaboration-run-heading"><div><div className="collaboration-heading-kicker"><Network size={12} />{t('run.workspace')}</div><h1>{run.definitionSnapshot.name}</h1><p title={run.definitionSnapshot.cwd}>{pathName(run.definitionSnapshot.cwd)}<span>{t('run.configVersion', { version: run.definitionVersion })}</span><Status value={run.status} /></p></div><div className="collaboration-run-actions"><IconButton label={t('run.editSetup')} onClick={onEdit}><Settings2 size={16} /></IconButton>{run.status === 'draft' ? <button className="button primary small" disabled={busy} onClick={() => control('start')}><Play size={13} />{t('action.start')}</button> : run.status === 'running' ? <button className="button small" disabled={busy} onClick={() => control('pause')}><Pause size={13} />{t('action.pauseDispatch')}</button> : ['paused', 'interrupted', 'failed'].includes(run.status) ? <button className="button small" disabled={busy} onClick={() => control('resume')}><Play size={13} />{t('action.resume')}</button> : null}{['running', 'paused'].includes(run.status) && <><button className="button small" disabled={busy || tasks.some(task => ['running', 'queued', 'waiting', 'pending'].includes(task.status))} onClick={() => control('finish')}><Check size={13} />{t('action.finish')}</button><IconButton label={t('action.stop')} disabled={busy} onClick={() => control('cancel')}><Square size={14} /></IconButton></>}</div></div>
    {run.status === 'draft' && <section className="collaboration-launch-plan" aria-label={t('run.beforeStart')}><SetupSteps current={3} /><div className="collaboration-launch-summary"><div><strong>{t('run.saved')}</strong><p>{tasks.length ? t('run.taskPlan', { count: tasks.length }) : t('run.noPresetTasks')} {t('run.projectOrder')}</p></div><div className="collaboration-launch-participants">{run.definitionSnapshot.participants.map(participant => <span key={participant.id}><strong>{participant.name}</strong><small>{participant.mode === 'external' ? t('participant.externalPlatform') : providers.find(provider => provider.id === participant.providerId)?.name ?? participant.providerId} · {participant.permissions.workspace?.access === 'read-only' || participant.settings?.permission === 'read-only' ? t('permission.readOnly') : t('permission.readWrite')}</small></span>)}</div></div></section>}
    <div className="collaboration-toolbar"><div className="collaboration-view-switch" role="tablist" aria-label={t('run.views')}><button role="tab" aria-selected={view === 'relationships'} className={view === 'relationships' ? 'active' : ''} onClick={() => changeView('relationships')}><Network size={14} />{t('run.relationships')}</button><button role="tab" aria-selected={view === 'data'} className={view === 'data' ? 'active' : ''} onClick={() => changeView('data')}><GitBranch size={14} />{t('run.dataFlow')}</button></div><div className="collaboration-toolbar-actions"><button className="button small" onClick={() => setComposer('task')}><Plus size={13} />{t('action.submitTask')}</button><button className="button small" onClick={() => setComposer('artifact')}><FileText size={13} />{t('action.publishMaterial')}</button><IconButton label={t('action.sendCollaborationMessage')} onClick={() => setComposer('message')}><MessageSquare size={15} /></IconButton><IconButton label={selectionOpen ? t('detail.collapse') : t('detail.expand')} disabled={!selection} aria-expanded={selectionOpen} onClick={() => setSelectionOpen(value => !value)}><PanelRight size={15} /></IconButton></div></div>
    <div className="collaboration-legend"><span><i className="configured" />{t('graph.configuredLegend')}</span><span><i />{t('graph.observedLegend')}</span><span>{t('graph.taskCount', { count: tasks.length })} · {t('graph.artifactCount', { count: artifacts.length })}</span>{view === 'relationships' && <small>{t('graph.connectHint')}</small>}</div>
    {run.error && <div className="collaboration-inline-error">{run.error}</div>}
    <div className={`collaboration-graph-body ${selectionOpen ? 'with-selection' : ''}`}><ExecutionGraph key={`collaboration:${run.id}:${view}`} storageKey={`collaboration:${run.id}:${view}`} graph={graph} view={view} selection={selectionOpen ? selection : undefined} onSelect={selectRecord} onConnect={value => { if (value.source !== value.target && run.definitionSnapshot.participants.some(item => item.id === value.source) && run.definitionSnapshot.participants.some(item => item.id === value.target)) setConnection(value); }} />{selection && <SelectionPanel selection={selection} open={selectionOpen} sessions={sessions} run={run} participants={participants} tasks={tasks} messages={messages} artifacts={artifacts} events={events} providers={providers} openSession={openSession} perform={perform} pending={pending} onSelect={selectRecord} onClose={() => setSelectionOpen(false)} />}</div>
    <div className={`collaboration-timeline ${timeline ? 'expanded' : ''}`}>
      <button className="collaboration-timeline-heading" onClick={() => setTimeline(value => !value)} aria-expanded={timeline} aria-controls={`collaboration-events-${run.id}`}><ChevronRight size={13} /><strong>{t('timeline.title')}</strong><span>{t('timeline.count', { count: events.length })}</span></button>
      <div className="collaboration-timeline-content" data-open={timeline} aria-hidden={!timeline} inert={!timeline} id={`collaboration-events-${run.id}`}><div className="collaboration-timeline-clip"><div className="collaboration-timeline-events">
        <div className="collaboration-timeline-list">{events.map(event => <button key={event.id} className={selection?.kind === 'event' && selection.id === event.id ? 'selected' : ''} onClick={() => selectRecord({ kind: 'event', id: event.id })}>
          <span className="collaboration-event-marker" aria-hidden="true">{eventStatus(event) ? <Status value={eventStatus(event)!} /> : <span className="event-dot" />}</span><span className="event-sequence">#{event.seq}</span><time>{formatDate(event.createdAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><strong>{eventLabel(event.type)}</strong><span className="event-participants">{participantName(run, event.participantId)}{event.targetParticipantId ? ` → ${participantName(run, event.targetParticipantId)}` : ''}</span>{event.source === 'external' && <small>{t('source.external')}</small>}
        </button>)}</div>
        {!events.length && !eventError && <p>{t('timeline.empty')}</p>}{more && <button className="text-button" onClick={() => void perform('collaboration-load-events', () => loadEvents('history'))}>{t('timeline.loadMore')}</button>}{eventError && <p className="collaboration-inline-error">{eventError}<button className="text-button" onClick={() => void loadEvents(failedEventRead.current ?? 'live')}>{t('action.retryRead')}</button></p>}
      </div></div></div>
    </div>
    {composer && <RunComposer kind={composer} run={run} tasks={tasks} artifacts={artifacts} perform={perform} pending={pending} onClose={() => setComposer(undefined)} />}
    {connection?.source && connection.target && <RelationshipDialog run={run} from={connection.source} to={connection.target} perform={perform} pending={pending} onClose={() => setConnection(undefined)} />}
  </section>;
}

function DetailField({ label, children }: { label: string; children: ReactNode }) { return <div className="collaboration-detail-field"><span>{label}</span><div>{children}</div></div>; }
function ArtifactFileContent({ artifact, perform, pending }: { artifact: CollaborationArtifactVersion; perform: Perform; pending: Set<string> }) {
  const { t } = useTranslation('collaboration');
  const [loaded, setLoaded] = useState<CollaborationArtifactVersion>();
  const key = `collaboration-read-artifact-${artifact.id}`;
  return loaded ? loaded.content !== undefined ? <DetailField label={t('artifact.fileContent')}><pre>{loaded.content}</pre></DetailField> : <p className="collaboration-observation-note">{t('artifact.noPreview')}</p> : <button className="button small" disabled={pending.has(key)} onClick={() => void perform(key, async () => setLoaded(await call('get_artifact', { runId: artifact.runId, artifactVersionId: artifact.id }) as CollaborationArtifactVersion))}>{pending.has(key) ? <LoaderCircle className="spin" size={12} /> : <FileText size={12} />}{t('artifact.readAndVerify')}</button>;
}
function SelectionPanel({ selection, open, sessions, run, participants, tasks, messages, artifacts, events, providers, openSession, perform, pending, onSelect, onClose }: {
  selection: GraphSelection; open: boolean; sessions: Session[]; run: CollaborationRun; participants: CollaborationParticipant[]; tasks: CollaborationTask[]; messages: CollaborationMessage[]; artifacts: CollaborationArtifactVersion[]; events: CollaborationEvent[]; providers: ProviderInfo[]; openSession: (id: string) => void; perform: Perform; pending: Set<string>; onSelect: (selection: GraphSelection) => void; onClose: () => void;
}) {
  const { t } = useTranslation('collaboration');
  const panel = useRef<HTMLElement>(null);
  const selectionKey = selection.kind === 'events' ? `events:${selection.ids.join(',')}` : `${selection.kind}:${selection.id}`;
  const previousOpen = useRef(open);
  const focusedDetail = useRef<{ key: string; element: HTMLElement } | undefined>(undefined);
  useLayoutEffect(() => {
    const element = panel.current;
    const toggle = element?.closest('.collaboration-run-view')?.querySelector<HTMLButtonElement>('.collaboration-toolbar-actions button[aria-expanded]');
    if (!open && element?.contains(document.activeElement)) toggle?.focus({ preventScroll: true });
    if (open && !previousOpen.current && focusedDetail.current?.key === selectionKey && document.activeElement === toggle && focusedDetail.current.element.isConnected) focusedDetail.current.element.focus({ preventScroll: true });
    previousOpen.current = open;
  }, [open, selectionKey]);
  const participant = selection.kind === 'participant' ? participants.find(item => item.id === selection.id) : undefined;
  const task = selection.kind === 'task' ? tasks.find(item => item.id === selection.id) : undefined;
  const artifact = selection.kind === 'artifact' ? artifacts.find(item => item.id === selection.id) : undefined;
  const message = selection.kind === 'message' ? messages.find(item => item.id === selection.id) : undefined;
  const relation = selection.kind === 'relationship' ? run.definitionSnapshot.relationships.find(item => item.id === selection.id) : undefined;
  const selectedEvents = selection.kind === 'event' ? events.filter(item => item.id === selection.id) : selection.kind === 'events' ? events.filter(item => selection.ids.includes(item.id)) : [];
  const artifactLink = (id: string) => { const item = artifacts.find(value => value.id === id); return <button className="collaboration-detail-link" key={id} onClick={() => onSelect({ kind: 'artifact', id })}><FileText size={12} />{item ? `${item.name} · v${item.version}` : id}<ArrowUpRight size={12} /></button>; };
  const title = participant?.name ?? task?.title ?? artifact?.name ?? (message ? t('detail.message') : relation ? t('relationships.title') : selectedEvents.length ? t('detail.events') : t('detail.title'));
  return <aside ref={panel} className="collaboration-selection" aria-label={t('detail.label')} data-open={open} aria-hidden={!open} inert={!open} onFocusCapture={event => { if (event.target instanceof HTMLElement) focusedDetail.current = { key: selectionKey, element: event.target }; }}><header><strong>{title}</strong><IconButton label={t('detail.close')} onClick={onClose}><X size={15} /></IconButton></header><div className="collaboration-selection-scroll">
    {participant && <><DetailField label={t('field.roles')}>{participant.roles.join(' · ') || t('field.unspecified')}</DetailField><DetailField label={t('field.connectionMode')}>{participant.mode === 'external' ? t('participant.external') : t('participant.managed')}</DetailField>{participant.providerId && <DetailField label={t('field.runtimeModel')}>{providers.find(item => item.id === participant.providerId)?.name ?? participant.providerId}{participant.modelId ? ` · ${modelName(providers.find(item => item.id === participant.providerId), participant.modelId)}` : ''}</DetailField>}<DetailField label={t('field.responsibilities')}>{participant.instructions || t('field.notProvided')}</DetailField><DetailField label={t('field.permissions')}><div className="collaboration-permission-summary">{([[t('action.submitTask'), participant.permissions.submitTasks], [t('action.sendMessage'), participant.permissions.sendMessages], [t('action.publishArtifact'), participant.permissions.publishArtifacts], [t('permission.configure'), participant.permissions.configureRun]] as const).map(([label, allowed]) => <span key={label}>{t(allowed ? 'permission.allowed' : 'permission.denied', { permission: label })}</span>)}<span>{t('permission.fileSummary', { access: participant.permissions.workspace?.access === 'read-write' ? t('permission.readWriteRoots') : t('permission.readOnly') })}</span></div></DetailField>{participant.mode === 'external' && <p className="collaboration-observation-note">{t('participant.externalRecordsNote')}</p>}<DetailField label={t('field.tasks')}>{tasks.filter(item => item.participantId === participant.id).map(item => <button key={item.id} className="collaboration-detail-link" onClick={() => onSelect({ kind: 'task', id: item.id })}>{item.title}<Status value={taskDisplayStatus(item, sessions)} /></button>)}</DetailField></>}
    {task && <><DetailField label={t('task.assignee')}>{task.participantSnapshot.name} · {t('run.configVersion', { version: task.definitionVersion })}</DetailField><DetailField label={t('task.status')}><Status value={taskDisplayStatus(task, sessions)} /></DetailField><DetailField label={t('task.prompt')}><pre>{task.prompt}</pre></DetailField>{task.error && <p className="collaboration-inline-error">{task.error}</p>}<DetailField label={t('task.inputs')}>{task.artifactIds.length ? task.artifactIds.map(artifactLink) : t('task.noInputs')}</DetailField>{task.result && <DetailField label={t('task.result')}><pre>{task.result}</pre></DetailField>}{task.sessionId && <button className="button small" onClick={() => openSession(task.sessionId!)}><MessageSquare size={13} />{t('action.openSession')}<ArrowUpRight size={13} /></button>}<DetailField label={t('task.attempts')}>{task.attempts.length ? task.attempts.map((attempt, index) => <div className="collaboration-attempt" key={attempt.id}><strong>{t('attempt.label', { kind: attempt.continuationOf ? t('attempt.continuation') : attempt.retryOf ? t('attempt.retry') : t('attempt.execution'), number: index + 1 })} <Status value={attempt.status === 'running' ? taskDisplayStatus(task, sessions) : attempt.status} /></strong><time>{dateLabel(attempt.startedAt)}{attempt.physicalTurns !== undefined ? t('attempt.turns', { count: attempt.physicalTurns }) : ''}</time>{attempt.nativeId && <code title={attempt.nativeId}>nativeId: {attempt.nativeId}</code>}{attempt.error && <p>{attempt.error}</p>}{attempt.inputArtifactIds.map(artifactLink)}{attempt.outputArtifactIds.map(artifactLink)}{attempt.sessionId && attempt.sessionId !== task.sessionId && <button className="text-button" onClick={() => openSession(attempt.sessionId!)}>{t('attempt.openSession')}</button>}</div>) : t('task.notStarted')}</DetailField>{['running', 'queued', 'waiting', 'pending'].includes(task.status) && <button className="button small" disabled={pending.has(`collaboration-task-${task.id}`)} onClick={() => void perform(`collaboration-task-${task.id}`, () => call('control_task', { requestId: requestId(), runId: run.id, taskId: task.id, action: 'cancel' }))}><Square size={12} />{t('task.stop')}</button>}{['failed', 'cancelled', 'interrupted'].includes(task.status) && <button className="button small" disabled={pending.has(`collaboration-task-${task.id}`)} onClick={() => void perform(`collaboration-task-${task.id}`, () => call('control_task', { requestId: requestId(), runId: run.id, taskId: task.id, action: 'retry' }))}><RefreshCw size={12} />{t('task.retry')}</button>}</>}
    {artifact && <><DetailField label={t('artifact.version')}>v{artifact.version} · {artifact.kind}</DetailField><DetailField label={t('artifact.publisher')}>{participantName(run, artifact.participantId)}</DetailField><DetailField label={t('artifact.versionId')}><code>{artifact.id}</code></DetailField><DetailField label="SHA256"><code>{artifact.sha256}</code></DetailField>{artifact.revision && <DetailField label={t('artifact.revision')}><code>{artifact.revision}</code></DetailField>}<DetailField label={t('artifact.publishedAt')}>{dateLabel(artifact.createdAt)}</DetailField>{artifact.taskId && <button className="collaboration-detail-link" onClick={() => onSelect({ kind: 'task', id: artifact.taskId! })}><GitBranch size={12} />{t('artifact.producer')}<ArrowUpRight size={12} /></button>}{artifact.path && <DetailField label={t('artifact.importFile')}><code>{artifact.path}</code></DetailField>}{artifact.content !== undefined && <DetailField label={t('artifact.content')}><pre>{artifact.content}</pre></DetailField>}<DetailField label={t('artifact.consumers')}>{tasks.filter(item => item.artifactIds.includes(artifact.id) || item.attempts.some(attempt => attempt.inputArtifactIds.includes(artifact.id))).map(item => <button className="collaboration-detail-link" key={item.id} onClick={() => onSelect({ kind: 'task', id: item.id })}>{item.title}<ArrowUpRight size={12} /></button>)}</DetailField></>}
    {artifact?.path && artifact.content === undefined && <ArtifactFileContent key={artifact.id} artifact={artifact} perform={perform} pending={pending} />}
    {message && <><DetailField label={t('message.direction')}>{participantName(run, message.fromParticipantId)} → {participantName(run, message.toParticipantId)}</DetailField><DetailField label={t('message.delivery')}>{deliveryLabel(message.delivery)}{message.source === 'external' ? t('message.externalSuffix') : ''}</DetailField><DetailField label={t('message.content')}><pre>{message.text}</pre></DetailField>{message.artifactIds.map(artifactLink)}{message.error && <p className="collaboration-inline-error">{message.error}</p>}</>}
    {relation && <><DetailField label={t('relationship.userSetup')}>{participantName(run, relation.from)} → {participantName(run, relation.to)}</DetailField><DetailField label={t('relationship.description')}>{relation.label || relationshipLabel(relation.kind)}</DetailField><p className="collaboration-observation-note">{t('relationship.note')}</p><button className="button small" disabled={pending.has(`collaboration-relation-${relation.id}`)} onClick={() => void perform(`collaboration-relation-${relation.id}`, async () => { await call('update_run', { requestId: requestId(), runId: run.id, expectedVersion: run.definitionVersion, relationships: run.definitionSnapshot.relationships.filter(item => item.id !== relation.id) }); onClose(); })}><Trash2 size={12} />{t('relationship.remove')}</button></>}
    {selectedEvents.map(event => <article className="collaboration-event-detail" key={event.id}><h3>#{event.seq} {eventLabel(event.type)}</h3><time>{dateLabel(event.createdAt)}</time><DetailField label={t('event.source')}>{participantName(run, event.participantId)}{event.targetParticipantId ? ` → ${participantName(run, event.targetParticipantId)}` : ''} · {event.source === 'external' ? t('source.external') : event.source === 'managed' ? t('source.managed') : t('source.platform')}</DetailField>{event.taskId && <button className="collaboration-detail-link" onClick={() => onSelect({ kind: 'task', id: event.taskId! })}>{t('event.viewTask')}<ArrowUpRight size={12} /></button>}{event.messageId && <button className="collaboration-detail-link" onClick={() => onSelect({ kind: 'message', id: event.messageId! })}>{t('event.viewMessage')}<ArrowUpRight size={12} /></button>}{event.artifactVersionId && artifactLink(event.artifactVersionId)}{event.cause && <DetailField label={t('event.cause')}><code>{event.cause}</code></DetailField>}<DetailField label={t('event.data')}><pre>{JSON.stringify(event.data, null, 2)}</pre></DetailField></article>)}
    {selection.kind === 'participant' && selection.id === 'user' && <p className="collaboration-observation-note">{t('participant.userNote')}</p>}
  </div></aside>;
}

function RunComposer({ kind, run, tasks, artifacts, perform, pending, onClose }: { kind: 'task' | 'message' | 'artifact'; run: CollaborationRun; tasks: CollaborationTask[]; artifacts: CollaborationArtifactVersion[]; perform: Perform; pending: Set<string>; onClose: () => void }) {
  const { t } = useTranslation('collaboration');
  const [participantId, setParticipantId] = useState(run.definitionSnapshot.participants[0]?.id ?? '');
  const [title, setTitle] = useState(''), [text, setText] = useState(''), [path, setPath] = useState('');
  const [artifactMode, setArtifactMode] = useState<'text' | 'file'>('text');
  const [artifactIds, setArtifactIds] = useState<string[]>([]), [dependsOn, setDependsOn] = useState<string[]>([]);
  const busy = pending.has(`collaboration-compose-${run.id}`);
  const labels = { task: t('action.submitTask'), message: t('action.sendCollaborationMessage'), artifact: t('action.publishMaterial') };
  const valid = kind === 'artifact' ? Boolean(title.trim() && (artifactMode === 'text' ? text.trim() : path.trim())) : Boolean(participantId && text.trim() && (kind !== 'task' || title.trim()));
  return <Modal title={labels[kind]} subtitle={kind === 'artifact' ? t('composer.artifactNote') : t('composer.actionNote')} busy={busy} onClose={onClose}><form onSubmit={event => { event.preventDefault(); if (!valid || busy) return; void perform(`collaboration-compose-${run.id}`, async () => { const base = { requestId: requestId(), runId: run.id }; if (kind === 'task') await call('submit_task', { ...base, participantId, title: title.trim(), prompt: text.trim(), dependsOn, artifactIds }); else if (kind === 'message') await call('send_message', { ...base, toParticipantId: participantId, text: text.trim(), kind: 'message', artifactIds }); else await call('publish_artifact', { ...base, name: title.trim(), kind: artifactMode === 'text' ? 'document' : 'file', ...(artifactMode === 'text' ? { content: text } : { path: path.trim() }) }); onClose(); }); }}>
    {kind !== 'message' && <label>{kind === 'task' ? t('task.name') : t('artifact.name')}<input value={title} required onChange={event => setTitle(event.target.value)} autoFocus /></label>}
    {kind !== 'artifact' && <label>{kind === 'task' ? t('task.assignee') : t('message.recipient')}<AppSelect label={kind === 'task' ? t('task.assignee') : t('message.recipient')} value={participantId} onChange={setParticipantId} options={run.definitionSnapshot.participants.map(item => ({ value: item.id, label: item.name, description: item.roles.length ? item.roles.join(' / ') : undefined }))} /></label>}
    {kind === 'artifact' && <div className="collaboration-view-switch"><button type="button" className={artifactMode === 'text' ? 'active' : ''} onClick={() => setArtifactMode('text')}>{t('artifact.enterContent')}</button><button type="button" className={artifactMode === 'file' ? 'active' : ''} onClick={() => setArtifactMode('file')}>{t('artifact.importFile')}</button></div>}
    {kind !== 'artifact' || artifactMode === 'text' ? <label>{kind === 'task' ? t('task.scope') : kind === 'message' ? t('message.text') : t('artifact.text')}<textarea value={text} required rows={6} onChange={event => setText(event.target.value)} /></label> : <label>{t('artifact.path')}<input value={path} required onChange={event => setPath(event.target.value)} placeholder={t('artifact.pathPlaceholder', { cwd: run.definitionSnapshot.cwd })} /><small>{t('artifact.copyNote')}</small></label>}
    {kind === 'task' && tasks.length > 0 && <fieldset className="collaboration-check-list"><legend>{t('task.dependencies')}</legend>{tasks.map(task => <label key={task.id}><input type="checkbox" checked={dependsOn.includes(task.id)} onChange={event => setDependsOn(ids => event.target.checked ? [...ids, task.id] : ids.filter(id => id !== task.id))} />{task.title}</label>)}</fieldset>}
    {kind !== 'artifact' && artifacts.length > 0 && <fieldset className="collaboration-check-list"><legend>{t('task.inputVersions')}</legend>{artifacts.map(artifact => <label className="collaboration-artifact-input" data-bound={artifactIds.includes(artifact.id)} key={artifact.id}><input type="checkbox" checked={artifactIds.includes(artifact.id)} onChange={event => setArtifactIds(ids => event.target.checked ? [...ids, artifact.id] : ids.filter(id => id !== artifact.id))} />{artifact.name} · v{artifact.version}<code>{artifact.sha256.slice(0, 8)}</code></label>)}</fieldset>}
    <div className="modal-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>{t('action.cancel')}</button><button className="button primary" disabled={!valid || busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{labels[kind]}</button></div>
  </form></Modal>;
}

function RelationshipDialog({ run, from, to, perform, pending, onClose }: { run: CollaborationRun; from: string; to: string; perform: Perform; pending: Set<string>; onClose: () => void }) {
  const { t } = useTranslation('collaboration');
  const [kind, setKind] = useState(''); const busy = pending.has('collaboration-add-relationship');
  return <Modal title={t('relationship.create')} subtitle={`${participantName(run, from)} → ${participantName(run, to)}`} busy={busy} onClose={onClose}><form onSubmit={event => { event.preventDefault(); if (!kind.trim() || busy) return; void perform('collaboration-add-relationship', async () => { await call('update_run', { requestId: requestId(), runId: run.id, expectedVersion: run.definitionVersion, relationships: [...run.definitionSnapshot.relationships, { id: requestId(), from, to, kind: kind.trim() }] }); onClose(); }); }}><label>{t('relationship.description')}<input autoFocus value={kind} onChange={event => setKind(event.target.value)} placeholder={t('relationship.customPlaceholder')} required /></label><p className="collaboration-observation-note">{t('relationship.saveNote')}</p><div className="modal-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>{t('action.cancel')}</button><button className="button primary" disabled={!kind.trim() || busy}>{t('relationship.save')}</button></div></form></Modal>;
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
  const { t } = useTranslation('collaboration');
  const [name, setName] = useState(''), [roots, setRoots] = useState(initialCwd), [createRuns, setCreateRuns] = useState(true);
  const [providerIds, setProviderIds] = useState(providers.filter(item => item.available).map(item => item.id));
  const [issued, setIssued] = useState<IdentityConfiguration>(), [client, setClient] = useState('claude'), [copied, setCopied] = useState(false);
  const busy = pending.has('collaboration-issue-identity');
  return <Modal title={t('connection.title')} subtitle={t('connection.description')} busy={busy} onClose={onClose}>{issued ? <div className="collaboration-connection-result"><p>{t('connection.issued', { name: issued.identity.name })}</p><label>{t('connection.clientFormat')}<AppSelect label={t('connection.clientFormat')} value={client} onChange={value => { setClient(value); setCopied(false); }} options={[{ value: 'claude', label: t('connection.stdio') }, { value: 'codex', label: 'Codex TOML' }, { value: 'opencode', label: 'OpenCode JSON' }, { value: 'deepseek-harness', label: 'DeepSeek Harness YAML overlay' }, { value: 'http', label: t('connection.http') }]} /></label><pre>{connectionText(issued, client)}</pre><button className="button" onClick={() => void perform('collaboration-copy-config', async () => { await navigator.clipboard.writeText(connectionText(issued, client)); setCopied(true); })}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? t('action.copied') : t('action.copyConfiguration')}</button><p className="collaboration-observation-note">{t('connection.clientNote')}</p><div className="modal-actions"><button className="button primary" onClick={onClose}>{t('connection.saved')}</button></div></div> : <><form onSubmit={event => { event.preventDefault(); if (!name.trim() || !splitRoots(roots).length || busy) return; void perform('collaboration-issue-identity', async () => { setIssued(await call('issue_identity', { name: name.trim(), policy: { createRuns, workspaceRoots: splitRoots(roots), providerIds } }) as IdentityConfiguration); }); }}><label>{t('connection.identityName')}<input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder={t('connection.identityPlaceholder')} required /></label><label>{t('connection.roots')}<textarea rows={2} value={roots} onChange={event => setRoots(event.target.value)} placeholder={t('connection.rootsPlaceholder')} required /></label><label className="collaboration-checkbox"><input type="checkbox" checked={createRuns} onChange={event => setCreateRuns(event.target.checked)} />{t('connection.canCreateRuns')}</label><fieldset className="collaboration-check-list"><legend>{t('connection.runtimes')}</legend>{providers.map(provider => <label key={provider.id}><input type="checkbox" checked={providerIds.includes(provider.id)} onChange={event => setProviderIds(ids => event.target.checked ? [...ids, provider.id] : ids.filter(id => id !== provider.id))} />{provider.name}</label>)}</fieldset><div className="modal-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>{t('action.cancel')}</button><button className="button primary" disabled={!name.trim() || !splitRoots(roots).length || busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <KeyRound size={14} />}{t('connection.issue')}</button></div></form>{Boolean(state?.identities.length) && <div className="collaboration-identities"><h3>{t('connection.identities')}</h3>{state!.identities.map(identity => <div key={identity.id}><span><strong>{identity.name}</strong><small>{identity.revokedAt ? t('connection.revoked') : t('connection.valid')}</small></span>{!identity.revokedAt && <button className="text-button" disabled={pending.has(`collaboration-revoke-${identity.id}`)} onClick={() => void perform(`collaboration-revoke-${identity.id}`, () => call('revoke_identity', { identityId: identity.id }))}>{t('connection.revoke')}</button>}</div>)}</div>}</>}</Modal>;
}
