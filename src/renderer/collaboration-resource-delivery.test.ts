import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollaborationAttempt, CollaborationEvent, CollaborationMessage, CollaborationParticipant, CollaborationTask } from '../shared/collaboration';
import { projectResourceDelivery } from './collaboration-resource-delivery';

const participant: CollaborationParticipant = { id: 'recipient', name: 'Recipient', mode: 'managed', roles: [], permissions: { submitTasks: true, sendMessages: true, configureRun: false, publishArtifacts: true } };
const attempt = (overrides: Partial<CollaborationAttempt> = {}): CollaborationAttempt => ({ id: 'attempt', status: 'running', startedAt: '2026-11-04T00:00:00Z', inputArtifactIds: ['material'], outputArtifactIds: [], physicalTurns: 1, ...overrides });
const task = (overrides: Partial<CollaborationTask> = {}): CollaborationTask => ({ id: 'task', runId: 'run', participantId: participant.id, createdBy: 'user', title: 'Review', prompt: 'Review', definitionVersion: 1, participantSnapshot: participant, dependsOn: [], artifactIds: ['material'], status: 'running', attempts: [attempt()], attemptId: 'attempt', createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z', ...overrides });
const message = (overrides: Partial<CollaborationMessage> = {}): CollaborationMessage => ({ id: 'message', runId: 'run', fromParticipantId: 'sender', toParticipantId: participant.id, targetTaskId: 'task', targetAttemptId: 'attempt', kind: 'message', text: 'Review', artifactIds: ['material'], delivery: 'injected', source: 'managed', createdAt: '2026-11-04T00:00:00Z', ...overrides });
const injected = (overrides: Partial<CollaborationEvent> = {}): CollaborationEvent => ({ id: 'event', seq: 1, runId: 'run', type: 'artifact.injected', source: 'managed', taskId: 'task', attemptId: 'attempt', artifactVersionId: 'material', data: {}, createdAt: '2026-11-04T00:00:00Z', ...overrides });

test('material messages retain every delivery state and exclude plain messages and user recipients', () => {
  const deliveries = ['accepted', 'queued', 'failed', 'injected', 'reported'] as const;
  const projection = projectResourceDelivery([], [
    ...deliveries.map(delivery => message({ id: delivery, delivery })),
    message({ id: 'plain', artifactIds: [] }), message({ id: 'to-user', toParticipantId: 'user' }),
  ], []);
  assert.deepEqual(projection.participantCounts.get('recipient'), [
    { status: 'failed', tasks: 0, messages: 1 }, { status: 'queued', tasks: 0, messages: 2 },
    { status: 'injected', tasks: 0, messages: 1 }, { status: 'reported', tasks: 0, messages: 1 },
  ]);
  assert.equal(projection.participantCounts.has('user'), false);
  assert.equal(projectResourceDelivery([task({ artifactIds: [], attempts: [], attemptId: undefined })], [], []).participantCounts.size, 0);
});

test('a physical input receipt survives later execution failure without event history', () => {
  const projection = projectResourceDelivery([task({ status: 'failed', attempts: [attempt({ status: 'failed' })] })], [], []);
  assert.deepEqual(projection.participantCounts.get('recipient'), [{ status: 'injected', tasks: 1, messages: 0 }]);
  assert.deepEqual(projection.inputs.get('task'), [{ artifactId: 'material', statuses: ['injected'] }]);
});

test('material input receipts require a matching current attempt or physical input containing that version', () => {
  const current = task({ artifactIds: ['material', 'other'], attempts: [attempt({ inputArtifactIds: ['other'], physicalTurns: 0 })] });
  const projection = projectResourceDelivery([current], [], [injected(), injected({ artifactVersionId: 'other', attemptId: 'old-attempt' })]);
  assert.deepEqual(projection.participantCounts.get('recipient'), [{ status: 'queued', tasks: 1, messages: 0 }, { status: 'injected', tasks: 1, messages: 0 }]);
  assert.deepEqual(projection.inputs.get('task'), [{ artifactId: 'material', statuses: ['injected'] }, { artifactId: 'other', statuses: ['queued'] }]);
  const wrongVersion = projectResourceDelivery([task({ attempts: [attempt({ inputArtifactIds: ['other'] })] })], [], []);
  assert.deepEqual(wrongVersion.inputs.get('task')?.find(input => input.artifactId === 'material')?.statuses, ['unconfirmed']);
});

test('retry waiting and a new queued attempt do not reuse old input receipts', () => {
  const old = attempt({ status: 'failed' });
  for (const status of ['pending', 'queued'] as const) {
    const projection = projectResourceDelivery([task({ status, attempts: [old] })], [], [injected()]);
    assert.deepEqual(projection.inputs.get('task'), [{ artifactId: 'material', statuses: ['queued'] }]);
  }
  const projection = projectResourceDelivery([task({ status: 'queued', attemptId: 'retry', attempts: [old, attempt({ id: 'retry', status: 'queued', retryOf: 'attempt', physicalTurns: 0 })] })], [], [injected()]);
  assert.deepEqual(projection.inputs.get('task'), [{ artifactId: 'material', statuses: ['queued'] }]);
});

test('known undelivered terminal inputs differ from historical inputs without durable delivery facts', () => {
  const cases = [
    { attempts: [], expected: 'failed' },
    { attempts: [attempt({ status: 'failed', physicalTurns: 0 })], expected: 'failed' },
    { attempts: [attempt({ status: 'failed', physicalTurns: undefined })], expected: 'unconfirmed' },
  ] as const;
  for (const item of cases) {
    const projection = projectResourceDelivery([task({ status: 'failed', attempts: [...item.attempts], attemptId: item.attempts.length ? 'attempt' : undefined })], [], []);
    assert.equal(projection.inputs.get('task')?.[0].statuses[0], item.expected);
  }
});

test('external claim persists as external handoff and resets when waiting for retry', () => {
  const external = task({ participantSnapshot: { ...participant, mode: 'external' }, status: 'failed', attempts: [attempt({ status: 'failed', physicalTurns: 0 })] });
  assert.deepEqual(projectResourceDelivery([external], [], []).inputs.get('task'), [{ artifactId: 'material', statuses: ['reported'] }]);
  assert.deepEqual(projectResourceDelivery([{ ...external, status: 'pending' }], [], [injected({ type: 'task.claimed', source: 'external' })]).inputs.get('task'), [{ artifactId: 'material', statuses: ['queued'] }]);
});

test('message materials included in an attempt are counted as messages rather than extra task dispatches', () => {
  const current = task({ artifactIds: [] });
  const projection = projectResourceDelivery([current], [message()], []);
  assert.deepEqual(projection.participantCounts.get('recipient'), [{ status: 'injected', tasks: 0, messages: 1 }]);
  assert.deepEqual(projection.taskCounts.get('task'), [{ status: 'injected', tasks: 0, messages: 1 }]);
  assert.deepEqual(projection.inputs.get('task'), [{ artifactId: 'material', statuses: ['injected'] }]);
  const explicit = projectResourceDelivery([task()], [message({ delivery: 'failed' })], []);
  assert.deepEqual(explicit.inputs.get('task'), [{ artifactId: 'material', statuses: ['failed', 'injected'] }]);
  const enqueued = task({ artifactIds: [], status: 'queued', attempts: [attempt({ status: 'queued', physicalTurns: 0 })] });
  const unbound = message({ targetTaskId: undefined, targetAttemptId: undefined, delivery: 'queued' });
  const beforeInput = projectResourceDelivery([enqueued], [unbound], []);
  assert.deepEqual(beforeInput.participantCounts.get('recipient'), [{ status: 'queued', tasks: 0, messages: 1 }]);
  assert.deepEqual(beforeInput.inputs.get('task'), [{ artifactId: 'material', statuses: ['queued'] }]);
});

test('retry task badges omit messages delivered to the previous attempt while participant history stays factual', () => {
  const projection = projectResourceDelivery([task({ status: 'pending', attempts: [attempt({ status: 'failed' })] })], [message()], []);
  assert.deepEqual(projection.taskCounts.get('task'), [{ status: 'queued', tasks: 1, messages: 0 }]);
  assert.deepEqual(projection.participantCounts.get('recipient'), [{ status: 'queued', tasks: 1, messages: 0 }, { status: 'injected', tasks: 0, messages: 1 }]);
});

test('historical attempt inputs remain visible without contributing to current dispatch counts', () => {
  const previous = attempt({ id: 'previous', status: 'failed', inputArtifactIds: ['historical'] });
  const current = task({ status: 'queued', attempts: [previous, attempt({ physicalTurns: 0, status: 'queued' })] });
  const projection = projectResourceDelivery([current], [], []);
  assert.deepEqual(projection.taskCounts.get('task'), [{ status: 'queued', tasks: 1, messages: 0 }]);
  assert.deepEqual(projection.inputs.get('task'), [
    { artifactId: 'material', statuses: ['queued'] }, { artifactId: 'historical', statuses: ['injected'], historical: true },
  ]);
});
