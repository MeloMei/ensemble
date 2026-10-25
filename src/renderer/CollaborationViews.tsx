import { useTranslation } from 'react-i18next';
import { translate, formatDate, formatNumber } from '../shared/i18n';
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
const dateLabel = (value: string) => formatDate(value, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const participantName = (run: CollaborationRun, id?: string) => id === 'user' ? translate('collaboration:actor.user') : run.definitionSnapshot.participants.find(item => item.id === id)?.name ?? id ?? translate('collaboration:actor.platform');
const deliveryKeys: Record<string, string> = { accepted: "delivery.accepted", queued: "delivery.queued", injected: "delivery.injected", reported: "delivery.reported", failed: "delivery.failed" };
const eventKeys: Record<string, string> = { 'run.created': "event.run.created", 'run.configured': "event.run.configured", 'run.started': "event.run.started", 'run.paused': "event.run.paused", 'run.running': "event.run.running", 'run.cancelled': "event.run.cancelled", 'run.completed': "event.run.completed", 'task.submitted': "event.task.submitted", 'task.attached': "event.task.attached", 'task.dispatched': "event.task.dispatched", 'task.running': "event.task.running", 'task.claimed': "event.task.claimed", 'task.wait_requested': "event.task.wait_requested", 'task.completed': "event.task.completed", 'task.failed': "event.task.failed", 'task.cancelled': "event.task.cancelled", 'task.pending': "event.task.pending", 'task.queued': "event.task.queued", 'task.waiting': "event.task.waiting", 'message.accepted': "event.message.accepted", 'message.injected': "event.message.injected", 'message.reported': "event.message.reported", 'input.injected': "event.input.injected", 'artifact.published': "event.artifact.published", 'artifact.injected': "event.artifact.injected", 'runtime.bound': "event.runtime.bound", 'runtime.usage': "event.runtime.usage", 'runtime.structured': "event.runtime.structured" };
const eventLabel = (type: string) => eventKeys[type] ? translate(`collaboration:${eventKeys[type]}`) : type;
const deliveryLabel = (delivery: string) => deliveryKeys[delivery] ? translate(`collaboration:${deliveryKeys[delivery]}`) : delivery;
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
  const { t } = useTranslation('collaboration');
  return <ol className="collaboration-setup-steps" aria-label={t('setup.steps')}>{[t('setup.describe'), t('setup.review'), t('action.start')].map((label, index) => <li key={label} className={index + 1 === current ? 'current' : index + 1 < current ? 'complete' : ''} aria-current={index + 1 === current ? 'step' : undefined}><span>{index + 1 < current ? <Check size={12} /> : index + 1}</span>{label}</li>)}</ol>;
}

function CollaborationStart({ onTemplate, onCustom }: { onTemplate: () => void; onCustom: () => void }) {
  const { t } = useTranslation('collaboration');
  return <section className="collaboration-start"><div className="collaboration-start-intro"><Network size={24} /><h1>{t('start.title')}</h1><p>{t('start.description')}</p></div><div className="collaboration-start-options">
    <button className="collaboration-start-option" onClick={onTemplate}><GitBranch size={20} /><span><strong>{t('template.name')}</strong><small>{t('start.templateDescription')}</small><em>{t('setup.describe')} <ChevronRight size={13} /></em></span></button>
    <button className="collaboration-start-option" onClick={onCustom}><Settings2 size={20} /><span><strong>{t('start.custom')}</strong><small>{t('start.customDescription')}</small><em>{t('start.openConfiguration')} <ChevronRight size={13} /></em></span></button>
  </div><p className="collaboration-start-note">{t('start.note')}</p></section>;
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
  const [editing, setEditing] = useState<'new' | string>();
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
    {!state ? <EmptyState icon={<Network size={28} />} title={t('page.unavailable')}>{t('page.reconnect')}</EmptyState> : editing ? <CollaborationEditor key={editing} starter={editing === 'new-template' ? 'template' : editing === 'new-custom' ? 'custom' : 'choose'} providers={snapshot.providers} identities={state.identities} initialCwd={initialCwd} run={editorRun} pending={pending} perform={perform} openProviderSettings={openProviderSettings} onClose={() => setEditing(undefined)} onSaved={id => { setSelectedId(id); setEditing(undefined); }} /> : run ? <CollaborationRunView key={run.id} run={run} state={state} stateVersion={snapshot.collaborationEventSeq} providers={snapshot.providers} sessions={snapshot.sessions} perform={perform} pending={pending} openSession={openSession} onEdit={() => setEditing(run.id)} /> : <CollaborationStart onTemplate={() => setEditing('new-template')} onCustom={() => setEditing('new-custom')} />}
    {connections && <ConnectionDialog providers={snapshot.providers} state={state} initialCwd={run?.definitionSnapshot.cwd ?? initialCwd} perform={perform} pending={pending} onClose={() => setConnections(false)} />}
  </div>;
}

function CollaborationEditor({ providers, identities, initialCwd, run, perform, pending, onClose, onSaved, starter, openProviderSettings }: {
  providers: ProviderInfo[]; identities: PublicCollaborationState['identities']; initialCwd: string; run?: CollaborationRun; perform: Perform; pending: Set<string>; onClose: () => void; onSaved: (id: string) => void; starter: 'choose' | 'template' | 'custom'; openProviderSettings?: () => void;
}) {
  const { t } = useTranslation('collaboration');
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
  if (stage === 'template') return <section className="collaboration-editor"><div className="detail-heading"><div><h1>{t('template.name')}</h1><p>{t('setup.description')}</p></div><IconButton label={t('setup.close')} onClick={onClose}><X size={18} /></IconButton></div><form className="collaboration-editor-body collaboration-template-form" onSubmit={event => { event.preventDefault(); if (setupValid) setStage('details'); }}>
    <SetupSteps current={1} />
    <label>{t('setup.goal')}<textarea rows={4} required autoFocus maxLength={100000} value={goal} onChange={event => setGoal(event.target.value)} placeholder={t('setup.goalPlaceholder')} /><small>{t('setup.goalHelp')}</small></label>
    <label>{t('field.projectDirectory')}<DirectoryField value={cwd} onChange={setCwd} perform={perform} /></label>
    <div className="collaboration-template-roles">{participants.map(participant => <section className="collaboration-template-role" key={participant.id}><div><strong>{participant.name || t('participant.unnamed')}</strong><span>{participant.permissions.workspace?.access === 'read-only' ? t('setup.readOnlyRole') : t('setup.writeRole')}</span></div>{participant.mode === 'managed' ? <><label>{t('field.runtime')}<ProviderSelect providers={participant.permissions.workspace?.access === 'read-only' ? providers.filter(provider => provider.capabilities.permissions) : providers} value={participant.providerId ?? ''} onChange={providerId => setProvider(participant, providerId)} /></label><ModelField provider={providers.find(provider => provider.id === participant.providerId)} value={participant.modelId} onChange={modelId => update(participant.id, { modelId: modelId || undefined })} /></> : <p className="collaboration-observation-note">{t('setup.externalRole')}</p>}{permissionIssues.filter(issue => issue.id === participant.id).map(issue => <p className="collaboration-field-error" role="alert" key={issue.id}>{issue.message}</p>)}</section>)}</div>
    {participants.some(participant => participant.mode === 'managed' && participant.permissions.workspace?.access === 'read-only') && !providers.some(provider => provider.available && provider.capabilities.permissions) && <div className="collaboration-setup-notice" role="status"><p>{t('setup.readOnlyRequired')}</p></div>}
    <p className="collaboration-start-note">{t('setup.runtimeNote')}</p>
    {openProviderSettings && <button className="text-button" type="button" onClick={openProviderSettings}>{t('setup.connectionHelp')} <ArrowUpRight size={13} /></button>}
    <div className="editor-actions"><button className="button" type="button" onClick={onClose}>{t('action.cancel')}</button><button className="button primary" disabled={!setupValid}>{t('setup.review')} <ChevronRight size={14} /></button></div>
  </form></section>;
  return <section className="collaboration-editor"><div className="detail-heading"><div><h1>{run ? t('setup.edit') : t('action.create')}</h1><p>{run ? t('setup.versionNote', { version: run.definitionVersion }) : t('setup.saveFirst')}</p></div><IconButton label={t('setup.close')} disabled={busy} onClick={onClose}><X size={18} /></IconButton></div>
    <form className="collaboration-editor-body" onSubmit={save}>
      {!run && <SetupSteps current={2} />}
      {templated && <div className="collaboration-goal-summary"><div><strong>{t('setup.sharedGoal')}</strong><button className="text-button" type="button" onClick={() => setStage('template')}>{t('setup.back')}</button></div><p>{goal}</p><small>{t('setup.goalSummary')}</small></div>}
      <div className="collaboration-form-grid"><label>{t('field.name')}<input value={name} maxLength={200} required autoFocus onChange={event => setName(event.target.value)} placeholder={t('field.namePlaceholder')} /></label><label>{t('field.projectDirectory')}{run ? <input value={cwd} readOnly /> : <DirectoryField value={cwd} onChange={setCwd} perform={perform} />}</label></div>
      <div className="collaboration-section-heading"><div><h2>{t('participants.title')}</h2><p>{t('participants.description')}</p></div><button className="button small" type="button" disabled={busy} onClick={addParticipant}><Plus size={14} />{t('participant.add')}</button></div>
      {!participants.length && <div className="collaboration-form-empty">{t('participants.empty')}</div>}
      {participants.map(participant => <article className="participant-editor" key={participant.id}>
        <div className="participant-editor-heading"><strong>{participant.name || t('participant.unnamed')}</strong><IconButton label={t('participant.delete', { name: participant.name })} disabled={busy} onClick={() => { setParticipants(items => items.filter(item => item.id !== participant.id).map(item => ({ ...item, permissions: { ...item.permissions, ...(item.permissions.allowedTargets ? { allowedTargets: item.permissions.allowedTargets.filter(id => id !== participant.id) } : {}) } }))); setRelationships(items => items.filter(item => item.from !== participant.id && item.to !== participant.id)); setSteps(items => items.filter(item => item.participantId !== participant.id).map(item => ({ ...item, dependsOn: item.dependsOn.filter(id => !steps.some(step => step.id === id && step.participantId === participant.id)) }))); }}><Trash2 size={14} /></IconButton></div>
        <div className="collaboration-form-grid"><label>{t('field.displayName')}<input value={participant.name} required onChange={event => update(participant.id, { name: event.target.value })} /></label><label>{t('field.connectionMode')}<select value={participant.mode} onChange={event => update(participant.id, { mode: event.target.value as 'managed' | 'external' })}><option value="managed">{t('participant.managedOption')}</option><option value="external">{t('participant.externalOption')}</option></select></label></div>
        <label>{t('field.roles')}<ListInput values={participant.roles} onChange={roles => update(participant.id, { roles })} placeholder={t('field.rolesPlaceholder')} /></label>
        <label>{t('field.instructions')}<textarea rows={2} value={participant.instructions ?? ''} onChange={event => update(participant.id, { instructions: event.target.value })} placeholder={t('field.instructionsPlaceholder')} /></label>
        {participant.mode === 'managed' ? <div className="collaboration-form-grid"><label>{t('field.runtime')}<ProviderSelect providers={providers} value={participant.providerId ?? ''} onChange={providerId => setProvider(participant, providerId)} /></label><ModelField provider={providers.find(item => item.id === participant.providerId)} value={participant.modelId} disabled={busy} onChange={modelId => update(participant.id, { modelId: modelId || undefined })} /></div> : <label>{t('field.identity')}<select value={participant.binding?.identityId ?? ''} onChange={event => update(participant.id, { binding: event.target.value ? { identityId: event.target.value } : undefined })}><option value="">{t('field.identityLater')}</option>{identities.filter(item => !item.revokedAt).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
        <div className="collaboration-form-grid"><label>{t('field.executionDirectory')} <span className="optional">{t('field.defaultProjectDirectory')}</span><input value={participant.cwd ?? ''} placeholder={cwd} onChange={event => update(participant.id, { cwd: event.target.value })} /></label><label>{participant.mode === 'external' ? t('permission.platformFiles') : t('permission.files')}<select value={participant.permissions.workspace?.access ?? 'read-only'} aria-invalid={permissionIssues.some(issue => issue.id === participant.id)} aria-describedby={permissionIssues.some(issue => issue.id === participant.id) ? `permission-issue-${participant.id}` : undefined} onChange={event => setAccess(participant, event.target.value as 'read-only' | 'read-write')}><option value="read-only" disabled={participant.mode === 'managed' && !providers.find(provider => provider.id === participant.providerId)?.capabilities.permissions}>{t('permission.readOnly')}</option><option value="read-write">{t('permission.readWriteRoots')}</option></select></label></div>
        {permissionIssues.filter(issue => issue.id === participant.id).map(issue => <p className="collaboration-field-error" id={`permission-issue-${participant.id}`} role="alert" key={issue.id}>{issue.message}</p>)}
        {participant.mode === 'managed' && !providers.find(provider => provider.id === participant.providerId)?.capabilities.permissions && participant.permissions.workspace?.access === 'read-write' && <p className="collaboration-observation-note">{t('permission.runtimeNote')}</p>}
        {participant.mode === 'external' && <p className="collaboration-observation-note">{t('permission.externalNote')}</p>}
        <fieldset className="collaboration-permissions"><legend>{t('permission.collaboration')}</legend>{([{ key: 'submitTasks', label: t('action.submitTask') }, { key: 'sendMessages', label: t('action.sendMessage') }, { key: 'publishArtifacts', label: t('action.publishArtifact') }, { key: 'configureRun', label: t('permission.configureRun') }] as const).map(permission => <label key={permission.key}><input type="checkbox" checked={participant.permissions[permission.key]} onChange={event => update(participant.id, { permissions: { ...participant.permissions, [permission.key]: event.target.checked } })} />{permission.label}</label>)}</fieldset>
        <details className="collaboration-advanced"><summary>{t('permission.scope')}</summary><label className="collaboration-checkbox"><input type="checkbox" checked={participant.permissions.allowedTargets !== undefined} onChange={event => update(participant.id, { permissions: { ...participant.permissions, allowedTargets: event.target.checked ? [] : undefined } })} />{t('permission.limitTargets')}</label>{participant.permissions.allowedTargets && <div className="collaboration-check-list">{participants.filter(item => item.id !== participant.id).map(target => <label key={target.id}><input type="checkbox" checked={participant.permissions.allowedTargets!.includes(target.id)} onChange={event => update(participant.id, { permissions: { ...participant.permissions, allowedTargets: event.target.checked ? [...participant.permissions.allowedTargets!, target.id] : participant.permissions.allowedTargets!.filter(id => id !== target.id) } })} />{target.name}</label>)}</div>}{participant.mode === 'managed' && Boolean(providers.find(item => item.id === participant.providerId)?.efforts?.length) && <label>{t('field.effort')}<select value={participant.settings?.effort ?? ''} onChange={event => update(participant.id, { settings: { ...participant.settings, effort: event.target.value || undefined } })}><option value="">{t('field.runtimeDefault')}</option>{providers.find(item => item.id === participant.providerId)?.efforts?.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label>}<p>{t('permission.toolsNote')}</p></details>
      </article>)}
      <div className="collaboration-section-heading"><div><h2>{t('relationships.title')}</h2><p>{t('relationships.description')}</p></div><button className="button small" type="button" disabled={participants.length < 2 || busy} onClick={() => setRelationships(items => [...items, { id: requestId(), from: participants[0].id, to: participants[1].id, kind: '', label: '' }])}><Plus size={14} />{t('relationship.add')}</button></div>
      {relationships.map(relation => <div className="relationship-editor" key={relation.id}><select aria-label={t('relationship.from')} value={relation.from} onChange={event => setRelationships(items => items.map(item => item.id === relation.id ? { ...item, from: event.target.value } : item))}>{participants.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronRight size={14} /><select aria-label={t('relationship.to')} value={relation.to} onChange={event => setRelationships(items => items.map(item => item.id === relation.id ? { ...item, to: event.target.value } : item))}>{participants.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><input aria-label={t('relationship.description')} value={relation.kind} onChange={event => setRelationships(items => items.map(item => item.id === relation.id ? { ...item, kind: event.target.value } : item))} placeholder={t('relationship.placeholder')} required /><IconButton label={t('relationship.delete')} onClick={() => setRelationships(items => items.filter(item => item.id !== relation.id))}><Trash2 size={14} /></IconButton></div>)}
      <div className="collaboration-section-heading"><div><h2>{t('tasks.preset')} <span className="optional">{t('field.optional')}</span></h2><p>{t('tasks.presetDescription')}</p></div><button className="button small" type="button" disabled={!participants.length || busy} onClick={() => setSteps(items => [...items, { id: requestId(), title: '', participantId: participants[0].id, prompt: '', dependsOn: [], artifactIds: [] }])}><Plus size={14} />{t('task.add')}</button></div>
      {steps.map(step => <article className="participant-editor" key={step.id}><div className="collaboration-form-grid"><label>{t('task.name')}<input value={step.title} required onChange={event => setSteps(items => items.map(item => item.id === step.id ? { ...item, title: event.target.value } : item))} /></label><label>{t('task.assignee')}<select value={step.participantId} onChange={event => setSteps(items => items.map(item => item.id === step.id ? { ...item, participantId: event.target.value } : item))}>{participants.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div><label>{t('task.requirements')}<textarea rows={3} value={step.prompt} required onChange={event => setSteps(items => items.map(item => item.id === step.id ? { ...item, prompt: event.target.value } : item))} /></label><div className="collaboration-check-list"><span>{t('task.dependencies')}</span>{steps.filter(item => item.id !== step.id).map(target => <label key={target.id}><input type="checkbox" checked={step.dependsOn.includes(target.id)} onChange={event => setSteps(items => items.map(item => item.id === step.id ? { ...item, dependsOn: event.target.checked ? [...item.dependsOn, target.id] : item.dependsOn.filter(id => id !== target.id) } : item))} />{target.title || t('task.unnamed')}</label>)}<IconButton label={t('task.deletePreset')} onClick={() => setSteps(items => items.filter(item => item.id !== step.id).map(item => ({ ...item, dependsOn: item.dependsOn.filter(id => id !== step.id) })))}><Trash2 size={14} /></IconButton></div></article>)}
      <label>{t('field.completion')}<select value={completion} onChange={event => setCompletion(event.target.value as 'manual' | 'all-tasks')}><option value="manual">{t('completion.manual')}</option><option value="all-tasks">{t('completion.allTasks')}</option></select></label>
      <details className="collaboration-advanced"><summary>{t('limits.title')} <span className="optional">{t('limits.help')}</span></summary><div className="collaboration-form-grid">{([{ key: 'maxConcurrentTasks', label: t('limits.concurrent') }, { key: 'maxTasks', label: t('limits.tasks') }, { key: 'maxAttemptsPerTask', label: t('limits.attempts') }, { key: 'maxTaskTurns', label: t('limits.turns') }] as const).map(item => <label key={item.key}>{item.label}<input type="number" min={1} step={1} value={limits[item.key] ?? ''} onChange={event => setLimits(current => ({ ...current, [item.key]: event.target.value ? Number(event.target.value) : undefined }))} /></label>)}</div><p>{t('limits.note')}</p></details>
      <div className="editor-actions"><button className="button" type="button" disabled={busy} onClick={onClose}>{t('action.cancel')}</button><button className="button primary" disabled={!valid || busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{run ? t('action.saveVersion') : t('action.saveAndView')}</button></div>
    </form>
  </section>;
}

interface GraphNodeData extends Record<string, unknown> { title: string; subtitle: string; detail?: string; kind: 'participant' | 'task' | 'artifact'; status?: string; external?: boolean }
type CollaborationNode = Node<GraphNodeData, 'collaboration'>;
type GraphSelection = { kind: 'participant' | 'task' | 'artifact' | 'event' | 'message' | 'relationship'; id: string } | { kind: 'events'; ids: string[] };
interface GraphEdgeData extends Record<string, unknown> { selection?: GraphSelection; configured?: boolean }
type CollaborationEdge = Edge<GraphEdgeData>;
function CollaborationNodeView({ data, selected, isConnectable }: NodeProps<CollaborationNode>) {
  const { t } = useTranslation('collaboration');
  return <div className={`collaboration-node node-${data.kind} ${selected ? 'selected' : ''}`}><Handle type="target" position={Position.Left} isConnectable={isConnectable} /><div className="collaboration-node-eyebrow">{data.kind === 'artifact' ? <FileText size={12} /> : data.kind === 'task' ? <GitBranch size={12} /> : <Network size={12} />}<span>{data.subtitle}</span></div><strong>{data.title}</strong>{data.detail && <p>{data.detail}</p>}<footer>{data.status && <Status value={data.status} />}{data.external && <span>{t('participant.externalConnection')}</span>}</footer><Handle type="source" position={Position.Right} isConnectable={isConnectable} /></div>;
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
      nodes.push(graphNode(participant.id, { kind: 'participant', title: participant.name, subtitle: participant.roles.join(' · ') || translate('collaboration:participant.noRoles'), detail: !current ? translate('collaboration:participant.historical') : participant.mode === 'managed' ? [participant.providerId, participant.modelId].filter(Boolean).join(' · ') : translate('collaboration:participant.platformRecordsOnly'), external: participant.mode === 'external', status: currentTask ? taskDisplayStatus(currentTask, sessions) : undefined }));
    }
    if (events.some(event => event.participantId === 'user' || event.targetParticipantId === 'user')) nodes.push(graphNode('user', { kind: 'participant', title: translate('collaboration:actor.user'), subtitle: translate('collaboration:participant.actionSource'), detail: translate('collaboration:participant.platformActions') }));
    const ids = new Set(nodes.map(node => node.id));
    for (const relation of run.definitionSnapshot.relationships) if (ids.has(relation.from) && ids.has(relation.to)) edges.push(edgeFor(`configured-${relation.id}`, relation.from, relation.to, relation.label || relation.kind, { kind: 'relationship', id: relation.id }, true));
    const groups = new Map<string, { from: string; to: string; type: string; ids: string[] }>();
    for (const event of events) {
      if (!event.participantId || !event.targetParticipantId || !ids.has(event.participantId) || !ids.has(event.targetParticipantId)) continue;
      const key = `${event.participantId}:${event.targetParticipantId}:${event.type}`;
      const group = groups.get(key) ?? { from: event.participantId, to: event.targetParticipantId, type: event.type, ids: [] };
      group.ids.push(event.id); groups.set(key, group);
    }
    for (const [key, group] of groups) edges.push(edgeFor(`observed-${key}`, group.from, group.to, `${eventLabel(group.type)}${group.ids.length > 1 ? ` ×${group.ids.length}` : ''}`, { kind: 'events', ids: group.ids }));
  } else {
    for (const task of tasks) nodes.push(graphNode(`task-${task.id}`, { kind: 'task', title: task.title, subtitle: task.participantSnapshot.name, detail: translate('collaboration:graph.taskDetail', { count: task.attempts.length, version: task.definitionVersion }), status: taskDisplayStatus(task, sessions) }));
    for (const artifact of artifacts) nodes.push(graphNode(`artifact-${artifact.id}`, { kind: 'artifact', title: artifact.name, subtitle: translate('collaboration:graph.artifactVersion', { version: artifact.version, kind: artifact.kind }), detail: artifact.sha256.slice(0, 16) }));
    const taskIds = new Set(tasks.map(task => task.id)), artifactIds = new Set(artifacts.map(artifact => artifact.id));
    for (const task of tasks) {
      for (const dependency of task.dependsOn) if (taskIds.has(dependency)) edges.push(edgeFor(`dependency-${dependency}-${task.id}`, `task-${dependency}`, `task-${task.id}`, translate('collaboration:graph.waitForCompletion'), { kind: 'task', id: task.id }, true));
      const inputs = new Set([...task.artifactIds, ...task.attempts.flatMap(attempt => attempt.inputArtifactIds)]);
      for (const artifactId of inputs) if (artifactIds.has(artifactId)) { const injected = events.some(event => event.type === 'artifact.injected' && event.taskId === task.id && event.artifactVersionId === artifactId); edges.push(edgeFor(`input-${artifactId}-${task.id}`, `artifact-${artifactId}`, `task-${task.id}`, injected ? translate('collaboration:graph.delivered') : translate('collaboration:graph.boundInput'), { kind: 'artifact', id: artifactId }, !injected)); }
    }
    for (const artifact of artifacts) if (artifact.taskId && taskIds.has(artifact.taskId)) edges.push(edgeFor(`output-${artifact.id}`, `task-${artifact.taskId}`, `artifact-${artifact.id}`, translate('collaboration:graph.output'), { kind: 'artifact', id: artifact.id }));
    for (const message of messages) if (message.taskId && message.targetTaskId && message.taskId !== message.targetTaskId && taskIds.has(message.taskId) && taskIds.has(message.targetTaskId)) edges.push(edgeFor(`message-${message.id}`, `task-${message.taskId}`, `task-${message.targetTaskId}`, deliveryLabel(message.delivery), { kind: 'message', id: message.id }));
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
  const { t } = useTranslation('collaboration');
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
      minZoom={0.05} maxZoom={1.8} colorMode={theme}
      ariaLabelConfig={{
        'node.a11yDescription.default': t('graph.nodeDescription'),
        'node.a11yDescription.keyboardDisabled': t('graph.nodeDescription'),
        'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }) => t('graph.nodeMoved', { direction: t(`graph.direction.${direction}`, { defaultValue: direction }), x: formatNumber(x), y: formatNumber(y) }),
        'edge.a11yDescription.default': t('graph.edgeDescription'),
        'controls.ariaLabel': t('graph.controls'),
        'controls.zoomIn.ariaLabel': t('graph.zoomIn'),
        'controls.zoomOut.ariaLabel': t('graph.zoomOut'),
        'controls.fitView.ariaLabel': t('graph.fitView'),
        'controls.interactive.ariaLabel': t('graph.interactive'),
        'minimap.ariaLabel': t('graph.minimap'),
        'handle.ariaLabel': t('graph.handle'),
      }} aria-label={view === 'relationships' ? t('graph.relationshipsLabel') : t('graph.dataLabel')}>
      <FitCompletedLayout layout={canvas.layout?.key === layoutKey ? canvas.layout : undefined} />
      <Background color="var(--border-strong)" gap={24} size={1} /><Controls showInteractive={false} />
    </ReactFlow>
    <div className="collaboration-canvas-tools"><button className="button small" onClick={() => setRevision(value => value + 1)}><RefreshCw size={12} />{t('graph.relayout')}</button></div>
    {!graph.nodes.length && <div className="collaboration-canvas-empty">{t('graph.empty')}</div>}
    {canvas.error && <div className="collaboration-graph-error" role="alert">{t('graph.layoutError', { error: canvas.error })}</div>}
  </div>;
}

function CollaborationRunView({ run, state, stateVersion, providers, sessions, perform, pending, openSession, onEdit }: { run: CollaborationRun; state: PublicCollaborationState; stateVersion?: number; providers: ProviderInfo[]; sessions: Session[]; perform: Perform; pending: Set<string>; openSession: (id: string) => void; onEdit: () => void }) {
  const { t, i18n } = useTranslation('collaboration');
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
  const graph = useMemo(() => buildGraph(run, participants, tasks, messages, artifacts, events, view, sessions), [run, state, events, view, participants, sessions, i18n.resolvedLanguage]);
  const control = (action: string) => void perform(`collaboration-control-${run.id}`, () => call('control_run', { requestId: requestId(), runId: run.id, action }));
  const busy = pending.has(`collaboration-control-${run.id}`);
  return <section className="collaboration-run-view"><div className="collaboration-run-heading"><div><div className="collaboration-heading-kicker"><Network size={12} />{t('run.workspace')}</div><h1>{run.definitionSnapshot.name}</h1><p title={run.definitionSnapshot.cwd}>{pathName(run.definitionSnapshot.cwd)}<span>{t('run.configVersion', { version: run.definitionVersion })}</span><Status value={run.status} /></p></div><div className="collaboration-run-actions"><IconButton label={t('run.editSetup')} onClick={onEdit}><Settings2 size={16} /></IconButton>{run.status === 'draft' ? <button className="button primary small" disabled={busy} onClick={() => control('start')}><Play size={13} />{t('action.start')}</button> : run.status === 'running' ? <button className="button small" disabled={busy} onClick={() => control('pause')}><Pause size={13} />{t('action.pauseDispatch')}</button> : ['paused', 'interrupted', 'failed'].includes(run.status) ? <button className="button small" disabled={busy} onClick={() => control('resume')}><Play size={13} />{t('action.resume')}</button> : null}{['running', 'paused'].includes(run.status) && <><button className="button small" disabled={busy || tasks.some(task => ['running', 'queued', 'waiting', 'pending'].includes(task.status))} onClick={() => control('finish')}><Check size={13} />{t('action.finish')}</button><IconButton label={t('action.stop')} disabled={busy} onClick={() => control('cancel')}><Square size={14} /></IconButton></>}</div></div>
    {run.status === 'draft' && <section className="collaboration-launch-plan" aria-label={t('run.beforeStart')}><SetupSteps current={3} /><div className="collaboration-launch-summary"><div><strong>{t('run.saved')}</strong><p>{tasks.length ? t('run.taskPlan', { count: tasks.length }) : t('run.noPresetTasks')} {t('run.projectOrder')}</p></div><div className="collaboration-launch-participants">{run.definitionSnapshot.participants.map(participant => <span key={participant.id}><strong>{participant.name}</strong><small>{participant.mode === 'external' ? t('participant.externalPlatform') : providers.find(provider => provider.id === participant.providerId)?.name ?? participant.providerId} · {participant.permissions.workspace?.access === 'read-only' || participant.settings?.permission === 'read-only' ? t('permission.readOnly') : t('permission.readWrite')}</small></span>)}</div></div></section>}
    <div className="collaboration-toolbar"><div className="collaboration-view-switch" role="tablist" aria-label={t('run.views')}><button role="tab" aria-selected={view === 'relationships'} className={view === 'relationships' ? 'active' : ''} onClick={() => setView('relationships')}><Network size={14} />{t('run.relationships')}</button><button role="tab" aria-selected={view === 'data'} className={view === 'data' ? 'active' : ''} onClick={() => setView('data')}><GitBranch size={14} />{t('run.dataFlow')}</button></div><div className="collaboration-toolbar-actions"><button className="button small" onClick={() => setComposer('task')}><Plus size={13} />{t('action.submitTask')}</button><button className="button small" onClick={() => setComposer('artifact')}><FileText size={13} />{t('action.publishMaterial')}</button><IconButton label={t('action.sendCollaborationMessage')} onClick={() => setComposer('message')}><MessageSquare size={15} /></IconButton><IconButton label={selectionOpen ? t('detail.collapse') : t('detail.expand')} disabled={!selection} aria-expanded={selectionOpen} onClick={() => setSelectionOpen(value => !value)}><PanelRight size={15} /></IconButton></div></div>
    <div className="collaboration-legend"><span><i className="configured" />{t('graph.configuredLegend')}</span><span><i />{t('graph.observedLegend')}</span><span>{t('graph.taskCount', { count: tasks.length })} · {t('graph.artifactCount', { count: artifacts.length })}</span>{view === 'relationships' && <small>{t('graph.connectHint')}</small>}</div>
    {run.error && <div className="collaboration-inline-error">{run.error}</div>}
    <div className={`collaboration-graph-body ${selectionOpen ? 'with-selection' : ''}`}><CollaborationCanvas graph={graph} view={view} onSelect={selectRecord} onConnect={value => { if (value.source !== value.target && run.definitionSnapshot.participants.some(item => item.id === value.source) && run.definitionSnapshot.participants.some(item => item.id === value.target)) setConnection(value); }} />{selection && <SelectionPanel selection={selection} open={selectionOpen} sessions={sessions} run={run} participants={participants} tasks={tasks} messages={messages} artifacts={artifacts} events={events} providers={providers} openSession={openSession} perform={perform} pending={pending} onSelect={selectRecord} onClose={() => setSelectionOpen(false)} />}</div>
    <div className={`collaboration-timeline ${timeline ? 'expanded' : ''}`}>
      <button className="collaboration-timeline-heading" onClick={() => setTimeline(value => !value)} aria-expanded={timeline} aria-controls={`collaboration-events-${run.id}`}><ChevronRight size={13} /><strong>{t('timeline.title')}</strong><span>{t('timeline.count', { count: events.length })}</span></button>
      <div className="collaboration-timeline-content" data-open={timeline} aria-hidden={!timeline} inert={!timeline} id={`collaboration-events-${run.id}`}><div className="collaboration-timeline-clip"><div className="collaboration-timeline-events">
        <div className="collaboration-timeline-list">{events.map(event => <button key={event.id} className={selection?.kind === 'event' && selection.id === event.id ? 'selected' : ''} onClick={() => selectRecord({ kind: 'event', id: event.id })}>
          <span className="collaboration-event-marker" aria-hidden="true">{eventStatus(event) ? <Status value={eventStatus(event)!} /> : <span className="event-dot" />}</span><span className="event-sequence">#{event.seq}</span><time>{formatDate(event.createdAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><strong>{eventLabel(event.type)}</strong><span className="event-participants">{participantName(run, event.participantId)}{event.targetParticipantId ? ` → ${participantName(run, event.targetParticipantId)}` : ''}</span>{event.source === 'external' && <small>{t('source.external')}</small>}
        </button>)}</div>
        {!events.length && !eventError && <p>{t('timeline.empty')}</p>}{more && <button className="text-button" onClick={() => void perform('collaboration-load-events', loadEvents)}>{t('timeline.loadMore')}</button>}{eventError && <p className="collaboration-inline-error">{eventError}<button className="text-button" onClick={() => void loadEvents()}>{t('action.retryRead')}</button></p>}
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
  const participant = selection.kind === 'participant' ? participants.find(item => item.id === selection.id) : undefined;
  const task = selection.kind === 'task' ? tasks.find(item => item.id === selection.id) : undefined;
  const artifact = selection.kind === 'artifact' ? artifacts.find(item => item.id === selection.id) : undefined;
  const message = selection.kind === 'message' ? messages.find(item => item.id === selection.id) : undefined;
  const relation = selection.kind === 'relationship' ? run.definitionSnapshot.relationships.find(item => item.id === selection.id) : undefined;
  const selectedEvents = selection.kind === 'event' ? events.filter(item => item.id === selection.id) : selection.kind === 'events' ? events.filter(item => selection.ids.includes(item.id)) : [];
  const artifactLink = (id: string) => { const item = artifacts.find(value => value.id === id); return <button className="collaboration-detail-link" key={id} onClick={() => onSelect({ kind: 'artifact', id })}><FileText size={12} />{item ? `${item.name} · v${item.version}` : id}<ArrowUpRight size={12} /></button>; };
  const title = participant?.name ?? task?.title ?? artifact?.name ?? (message ? t('detail.message') : relation ? t('relationships.title') : selectedEvents.length ? t('detail.events') : t('detail.title'));
  return <aside className="collaboration-selection" aria-label={t('detail.label')} data-open={open} aria-hidden={!open} inert={!open}><header><strong>{title}</strong><IconButton label={t('detail.close')} onClick={onClose}><X size={15} /></IconButton></header><div className="collaboration-selection-scroll">
    {participant && <><DetailField label={t('field.roles')}>{participant.roles.join(' · ') || t('field.unspecified')}</DetailField><DetailField label={t('field.connectionMode')}>{participant.mode === 'external' ? t('participant.external') : t('participant.managed')}</DetailField>{participant.providerId && <DetailField label={t('field.runtimeModel')}>{providers.find(item => item.id === participant.providerId)?.name ?? participant.providerId}{participant.modelId ? ` · ${modelName(providers.find(item => item.id === participant.providerId), participant.modelId)}` : ''}</DetailField>}<DetailField label={t('field.responsibilities')}>{participant.instructions || t('field.notProvided')}</DetailField><DetailField label={t('field.permissions')}><div className="collaboration-permission-summary">{([[t('action.submitTask'), participant.permissions.submitTasks], [t('action.sendMessage'), participant.permissions.sendMessages], [t('action.publishArtifact'), participant.permissions.publishArtifacts], [t('permission.configure'), participant.permissions.configureRun]] as const).map(([label, allowed]) => <span key={label}>{t(allowed ? 'permission.allowed' : 'permission.denied', { permission: label })}</span>)}<span>{t('permission.fileSummary', { access: participant.permissions.workspace?.access === 'read-write' ? t('permission.readWriteRoots') : t('permission.readOnly') })}</span></div></DetailField>{participant.mode === 'external' && <p className="collaboration-observation-note">{t('participant.externalRecordsNote')}</p>}<DetailField label={t('field.tasks')}>{tasks.filter(item => item.participantId === participant.id).map(item => <button key={item.id} className="collaboration-detail-link" onClick={() => onSelect({ kind: 'task', id: item.id })}>{item.title}<Status value={taskDisplayStatus(item, sessions)} /></button>)}</DetailField></>}
    {task && <><DetailField label={t('task.assignee')}>{task.participantSnapshot.name} · {t('run.configVersion', { version: task.definitionVersion })}</DetailField><DetailField label={t('task.status')}><Status value={taskDisplayStatus(task, sessions)} /></DetailField><DetailField label={t('task.prompt')}><pre>{task.prompt}</pre></DetailField>{task.error && <p className="collaboration-inline-error">{task.error}</p>}<DetailField label={t('task.inputs')}>{task.artifactIds.length ? task.artifactIds.map(artifactLink) : t('task.noInputs')}</DetailField>{task.result && <DetailField label={t('task.result')}><pre>{task.result}</pre></DetailField>}{task.sessionId && <button className="button small" onClick={() => openSession(task.sessionId!)}><MessageSquare size={13} />{t('action.openSession')}<ArrowUpRight size={13} /></button>}<DetailField label={t('task.attempts')}>{task.attempts.length ? task.attempts.map((attempt, index) => <div className="collaboration-attempt" key={attempt.id}><strong>{t('attempt.label', { kind: attempt.continuationOf ? t('attempt.continuation') : attempt.retryOf ? t('attempt.retry') : t('attempt.execution'), number: index + 1 })} <Status value={attempt.status === 'running' ? taskDisplayStatus(task, sessions) : attempt.status} /></strong><time>{dateLabel(attempt.startedAt)}{attempt.physicalTurns !== undefined ? t('attempt.turns', { count: attempt.physicalTurns }) : ''}</time>{attempt.nativeId && <code title={attempt.nativeId}>nativeId: {attempt.nativeId}</code>}{attempt.error && <p>{attempt.error}</p>}{attempt.inputArtifactIds.map(artifactLink)}{attempt.outputArtifactIds.map(artifactLink)}{attempt.sessionId && attempt.sessionId !== task.sessionId && <button className="text-button" onClick={() => openSession(attempt.sessionId!)}>{t('attempt.openSession')}</button>}</div>) : t('task.notStarted')}</DetailField>{['running', 'queued', 'waiting', 'pending'].includes(task.status) && <button className="button small" disabled={pending.has(`collaboration-task-${task.id}`)} onClick={() => void perform(`collaboration-task-${task.id}`, () => call('control_task', { requestId: requestId(), runId: run.id, taskId: task.id, action: 'cancel' }))}><Square size={12} />{t('task.stop')}</button>}{['failed', 'cancelled', 'interrupted'].includes(task.status) && <button className="button small" disabled={pending.has(`collaboration-task-${task.id}`)} onClick={() => void perform(`collaboration-task-${task.id}`, () => call('control_task', { requestId: requestId(), runId: run.id, taskId: task.id, action: 'retry' }))}><RefreshCw size={12} />{t('task.retry')}</button>}</>}
    {artifact && <><DetailField label={t('artifact.version')}>v{artifact.version} · {artifact.kind}</DetailField><DetailField label={t('artifact.publisher')}>{participantName(run, artifact.participantId)}</DetailField><DetailField label={t('artifact.versionId')}><code>{artifact.id}</code></DetailField><DetailField label="SHA256"><code>{artifact.sha256}</code></DetailField>{artifact.revision && <DetailField label={t('artifact.revision')}><code>{artifact.revision}</code></DetailField>}<DetailField label={t('artifact.publishedAt')}>{dateLabel(artifact.createdAt)}</DetailField>{artifact.taskId && <button className="collaboration-detail-link" onClick={() => onSelect({ kind: 'task', id: artifact.taskId! })}><GitBranch size={12} />{t('artifact.producer')}<ArrowUpRight size={12} /></button>}{artifact.path && <DetailField label={t('artifact.importFile')}><code>{artifact.path}</code></DetailField>}{artifact.content !== undefined && <DetailField label={t('artifact.content')}><pre>{artifact.content}</pre></DetailField>}<DetailField label={t('artifact.consumers')}>{tasks.filter(item => item.artifactIds.includes(artifact.id) || item.attempts.some(attempt => attempt.inputArtifactIds.includes(artifact.id))).map(item => <button className="collaboration-detail-link" key={item.id} onClick={() => onSelect({ kind: 'task', id: item.id })}>{item.title}<ArrowUpRight size={12} /></button>)}</DetailField></>}
    {artifact?.path && artifact.content === undefined && <ArtifactFileContent key={artifact.id} artifact={artifact} perform={perform} pending={pending} />}
    {message && <><DetailField label={t('message.direction')}>{participantName(run, message.fromParticipantId)} → {participantName(run, message.toParticipantId)}</DetailField><DetailField label={t('message.delivery')}>{deliveryLabel(message.delivery)}{message.source === 'external' ? t('message.externalSuffix') : ''}</DetailField><DetailField label={t('message.content')}><pre>{message.text}</pre></DetailField>{message.artifactIds.map(artifactLink)}{message.error && <p className="collaboration-inline-error">{message.error}</p>}</>}
    {relation && <><DetailField label={t('relationship.userSetup')}>{participantName(run, relation.from)} → {participantName(run, relation.to)}</DetailField><DetailField label={t('relationship.description')}>{relation.label || relation.kind}</DetailField><p className="collaboration-observation-note">{t('relationship.note')}</p><button className="button small" disabled={pending.has(`collaboration-relation-${relation.id}`)} onClick={() => void perform(`collaboration-relation-${relation.id}`, async () => { await call('update_run', { requestId: requestId(), runId: run.id, expectedVersion: run.definitionVersion, relationships: run.definitionSnapshot.relationships.filter(item => item.id !== relation.id) }); onClose(); })}><Trash2 size={12} />{t('relationship.remove')}</button></>}
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
    {kind !== 'artifact' && <label>{kind === 'task' ? t('task.assignee') : t('message.recipient')}<select value={participantId} onChange={event => setParticipantId(event.target.value)}>{run.definitionSnapshot.participants.map(item => <option key={item.id} value={item.id}>{item.name}{item.roles.length ? ` · ${item.roles.join(' / ')}` : ''}</option>)}</select></label>}
    {kind === 'artifact' && <div className="collaboration-view-switch"><button type="button" className={artifactMode === 'text' ? 'active' : ''} onClick={() => setArtifactMode('text')}>{t('artifact.enterContent')}</button><button type="button" className={artifactMode === 'file' ? 'active' : ''} onClick={() => setArtifactMode('file')}>{t('artifact.importFile')}</button></div>}
    {kind !== 'artifact' || artifactMode === 'text' ? <label>{kind === 'task' ? t('task.scope') : kind === 'message' ? t('message.text') : t('artifact.text')}<textarea value={text} required rows={6} onChange={event => setText(event.target.value)} /></label> : <label>{t('artifact.path')}<input value={path} required onChange={event => setPath(event.target.value)} placeholder={t('artifact.pathPlaceholder', { cwd: run.definitionSnapshot.cwd })} /><small>{t('artifact.copyNote')}</small></label>}
    {kind === 'task' && tasks.length > 0 && <fieldset className="collaboration-check-list"><legend>{t('task.dependencies')}</legend>{tasks.map(task => <label key={task.id}><input type="checkbox" checked={dependsOn.includes(task.id)} onChange={event => setDependsOn(ids => event.target.checked ? [...ids, task.id] : ids.filter(id => id !== task.id))} />{task.title}</label>)}</fieldset>}
    {kind !== 'artifact' && artifacts.length > 0 && <fieldset className="collaboration-check-list"><legend>{t('task.inputVersions')}</legend>{artifacts.map(artifact => <label key={artifact.id}><input type="checkbox" checked={artifactIds.includes(artifact.id)} onChange={event => setArtifactIds(ids => event.target.checked ? [...ids, artifact.id] : ids.filter(id => id !== artifact.id))} />{artifact.name} · v{artifact.version}<code>{artifact.sha256.slice(0, 8)}</code></label>)}</fieldset>}
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
  return <Modal title={t('connection.title')} subtitle={t('connection.description')} busy={busy} onClose={onClose}>{issued ? <div className="collaboration-connection-result"><p>{t('connection.issued', { name: issued.identity.name })}</p><label>{t('connection.clientFormat')}<select value={client} onChange={event => { setClient(event.target.value); setCopied(false); }}><option value="claude">{t('connection.stdio')}</option><option value="codex">Codex TOML</option><option value="opencode">OpenCode JSON</option><option value="deepseek-harness">DeepSeek Harness YAML overlay</option><option value="http">{t('connection.http')}</option></select></label><pre>{connectionText(issued, client)}</pre><button className="button" onClick={() => void perform('collaboration-copy-config', async () => { await navigator.clipboard.writeText(connectionText(issued, client)); setCopied(true); })}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? t('action.copied') : t('action.copyConfiguration')}</button><p className="collaboration-observation-note">{t('connection.clientNote')}</p><div className="modal-actions"><button className="button primary" onClick={onClose}>{t('connection.saved')}</button></div></div> : <><form onSubmit={event => { event.preventDefault(); if (!name.trim() || !splitRoots(roots).length || busy) return; void perform('collaboration-issue-identity', async () => { setIssued(await call('issue_identity', { name: name.trim(), policy: { createRuns, workspaceRoots: splitRoots(roots), providerIds } }) as IdentityConfiguration); }); }}><label>{t('connection.identityName')}<input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder={t('connection.identityPlaceholder')} required /></label><label>{t('connection.roots')}<textarea rows={2} value={roots} onChange={event => setRoots(event.target.value)} placeholder={t('connection.rootsPlaceholder')} required /></label><label className="collaboration-checkbox"><input type="checkbox" checked={createRuns} onChange={event => setCreateRuns(event.target.checked)} />{t('connection.canCreateRuns')}</label><fieldset className="collaboration-check-list"><legend>{t('connection.runtimes')}</legend>{providers.map(provider => <label key={provider.id}><input type="checkbox" checked={providerIds.includes(provider.id)} onChange={event => setProviderIds(ids => event.target.checked ? [...ids, provider.id] : ids.filter(id => id !== provider.id))} />{provider.name}</label>)}</fieldset><div className="modal-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>{t('action.cancel')}</button><button className="button primary" disabled={!name.trim() || !splitRoots(roots).length || busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <KeyRound size={14} />}{t('connection.issue')}</button></div></form>{Boolean(state?.identities.length) && <div className="collaboration-identities"><h3>{t('connection.identities')}</h3>{state!.identities.map(identity => <div key={identity.id}><span><strong>{identity.name}</strong><small>{identity.revokedAt ? t('connection.revoked') : t('connection.valid')}</small></span>{!identity.revokedAt && <button className="text-button" disabled={pending.has(`collaboration-revoke-${identity.id}`)} onClick={() => void perform(`collaboration-revoke-${identity.id}`, () => call('revoke_identity', { identityId: identity.id }))}>{t('connection.revoke')}</button>}</div>)}</div>}</>}</Modal>;
}
