import type { CollaborationAttempt, CollaborationEvent, CollaborationMessage, CollaborationTask } from '../shared/collaboration';

export type ResourceDeliveryStatus = 'queued' | 'failed' | 'injected' | 'reported' | 'unconfirmed';
export interface ResourceDeliveryCount { status: ResourceDeliveryStatus; tasks: number; messages: number }
export interface ResourceInputDelivery { artifactId: string; statuses: ResourceDeliveryStatus[]; historical?: boolean }
const statusOrder: ResourceDeliveryStatus[] = ['failed', 'queued', 'unconfirmed', 'injected', 'reported'];
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

function currentAttempt(task: CollaborationTask): CollaborationAttempt | undefined {
  const attempt = task.attemptId ? task.attempts.find(item => item.id === task.attemptId) : task.attempts.at(-1);
  if (attempt && ['pending', 'queued'].includes(task.status) && terminal.has(attempt.status)) return undefined;
  return attempt;
}

function taskInputStatus(task: CollaborationTask, attempt: CollaborationAttempt | undefined, artifactId: string, events: CollaborationEvent[]): ResourceDeliveryStatus {
  if (!attempt) {
    if (['pending', 'queued', 'waiting'].includes(task.status)) return 'queued';
    return task.attempts.length ? 'unconfirmed' : terminal.has(task.status) ? 'failed' : 'unconfirmed';
  }
  const includesInput = attempt.inputArtifactIds.includes(artifactId);
  if (task.participantSnapshot.mode === 'external') {
    if (includesInput && (events.some(event => event.type === 'task.claimed' && event.taskId === task.id && event.attemptId === attempt.id)
      || ['running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(attempt.status))) return 'reported';
  } else if ((includesInput && (attempt.physicalTurns ?? 0) > 0)
    || events.some(event => event.type === 'artifact.injected' && event.taskId === task.id && event.attemptId === attempt.id && event.artifactVersionId === artifactId)) return 'injected';
  if (terminal.has(task.status)) return attempt.physicalTurns === 0 ? 'failed' : 'unconfirmed';
  if ((attempt.physicalTurns ?? 0) > 0 && !includesInput) return 'unconfirmed';
  return attempt.physicalTurns === undefined && !['pending', 'queued'].includes(task.status) ? 'unconfirmed' : 'queued';
}

export function projectResourceDelivery(tasks: CollaborationTask[], messages: CollaborationMessage[], events: CollaborationEvent[]) {
  const participantCounts = new Map<string, ResourceDeliveryCount[]>();
  const taskCounts = new Map<string, ResourceDeliveryCount[]>();
  const inputs = new Map<string, ResourceInputDelivery[]>();
  const addCount = (map: Map<string, ResourceDeliveryCount[]>, id: string, status: ResourceDeliveryStatus, kind: 'tasks' | 'messages') => {
    const counts = map.get(id) ?? [];
    let count = counts.find(item => item.status === status);
    if (!count) { count = { status, tasks: 0, messages: 0 }; counts.push(count); }
    count[kind]++;
    map.set(id, counts);
  };
  const addInput = (taskId: string, artifactId: string, status: ResourceDeliveryStatus) => {
    const taskInputs = inputs.get(taskId) ?? [];
    let input = taskInputs.find(item => item.artifactId === artifactId);
    if (!input) { input = { artifactId, statuses: [] }; taskInputs.push(input); }
    if (!input.statuses.includes(status)) input.statuses.push(status);
    inputs.set(taskId, taskInputs);
  };
  const resourceMessages = messages.filter(message => message.toParticipantId !== 'user' && message.artifactIds.length);
  const attempts = new Map(tasks.map(task => [task.id, currentAttempt(task)]));
  for (const task of tasks) {
    if (task.participantId === 'user') continue;
    const attempt = attempts.get(task.id);
    const carriedByMessages = new Set(resourceMessages.filter(message => message.targetTaskId === task.id
      && (message.targetAttemptId === attempt?.id || ['accepted', 'queued'].includes(message.delivery)))
      .flatMap(message => message.artifactIds));
    const taskInputs = new Set([...task.artifactIds, ...(attempt?.inputArtifactIds.filter(id => !carriedByMessages.has(id)) ?? [])]);
    const statuses = new Set<ResourceDeliveryStatus>();
    for (const id of taskInputs) {
      const status = taskInputStatus(task, attempt, id, events);
      if (task.artifactIds.includes(id)) statuses.add(status);
      addInput(task.id, id, status);
    }
    for (const status of statuses) {
      addCount(participantCounts, task.participantId, status, 'tasks');
      addCount(taskCounts, task.id, status, 'tasks');
    }
  }
  for (const message of resourceMessages) {
    const status = message.delivery === 'accepted' ? 'queued' : message.delivery;
    addCount(participantCounts, message.toParticipantId, status, 'messages');
    if (!message.targetTaskId) continue;
    const task = tasks.find(item => item.id === message.targetTaskId && item.participantId === message.toParticipantId);
    if (!task) continue;
    const attempt = attempts.get(task.id);
    const pending = ['accepted', 'queued'].includes(message.delivery);
    if (!pending && message.targetAttemptId && message.targetAttemptId !== attempt?.id) continue;
    addCount(taskCounts, task.id, status, 'messages');
    for (const artifactId of new Set(message.artifactIds)) addInput(task.id, artifactId, status);
  }
  for (const task of tasks) {
    const historical = new Map<string, CollaborationAttempt>();
    for (const attempt of task.attempts) for (const artifactId of attempt.inputArtifactIds) historical.set(artifactId, attempt);
    for (const [artifactId, attempt] of historical) {
      if (inputs.get(task.id)?.some(input => input.artifactId === artifactId)) continue;
      const status = taskInputStatus({ ...task, status: attempt.status }, attempt, artifactId, events);
      const taskInputs = inputs.get(task.id) ?? [];
      taskInputs.push({ artifactId, statuses: [status], historical: true });
      inputs.set(task.id, taskInputs);
    }
  }
  for (const map of [participantCounts, taskCounts]) for (const counts of map.values()) counts.sort((a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status));
  for (const taskInputs of inputs.values()) for (const input of taskInputs) input.statuses.sort((a, b) => statusOrder.indexOf(a) - statusOrder.indexOf(b));
  return { participantCounts, taskCounts, inputs };
}
