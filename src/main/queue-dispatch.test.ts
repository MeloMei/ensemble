import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ProviderSteerRejected, type ProviderAdapter } from './providers/types';
import { createWorkbenchService } from './workbench-service';

const info = { id: 'controlled', name: 'Controlled', source: 'plugin' as const, available: true, detail: '',
  capabilities: { resume: true, approvals: false, steer: true } };

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(10);
  }
  assert.fail('the queue did not reach the expected state');
}

test('queue dispatch confirms the active attempt before stopping and runs the selected item next', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ensemble-queue-interrupt-'));
  const prompts: string[] = [];
  const provider: ProviderAdapter = {
    info,
    async run({ prompt, signal }) {
      prompts.push(prompt);
      if (prompt === 'first') await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  };
  const service = await createWorkbenchService({ dataPath: cwd, command: process.execPath, bridgePath: join(cwd, 'bridge.cjs'), publish() {}, providers: [provider] });
  try {
    const id = await service.engine.createSession({ cwd, title: 'dispatch', providerId: info.id });
    service.engine.sendPrompt(id, { text: 'first' });
    await until(() => prompts.length === 1);
    service.engine.sendPrompt(id, { text: 'later' });
    service.engine.sendPrompt(id, { text: 'next' });
    const session = () => service.engine.getSession(id);
    const [later, next] = session().queue!;
    const attemptId = session().attempts!.at(-1)!.id;
    assert.equal(service.engine.interruptForQueuedPrompt(id, next.id, [later.id, next.id], 'old-turn', randomUUID()), 'blocked');
    assert.equal(service.engine.interruptForQueuedPrompt(id, next.id, [next.id, later.id], attemptId, randomUUID()), 'queue-changed');
    assert.deepEqual(prompts, ['first']);
    const commandId = randomUUID();
    assert.equal(service.engine.interruptForQueuedPrompt(id, next.id, [later.id, next.id], attemptId, commandId), 'moved');
    await until(() => prompts.length === 3 && session().status === 'completed');
    assert.deepEqual(prompts, ['first', 'next', 'later']);
    assert.equal(service.engine.interruptForQueuedPrompt(id, next.id, [later.id, next.id], attemptId, commandId), 'moved');
    assert.deepEqual(prompts, ['first', 'next', 'later']);
  } finally { await service.shutdown(); await rm(cwd, { recursive: true, force: true }); }
});

test('queue steering records final acknowledgements and retains uncertain text across restart without replay', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ensemble-queue-steer-'));
  let finish!: () => void;
  let rejectSteer!: () => void;
  const invoked: string[] = [];
  const steered: string[] = [];
  const provider: ProviderAdapter = {
    info,
    async run({ prompt, signal }) {
      invoked.push(prompt);
      if (prompt === 'first') await new Promise<void>(resolve => {
        finish = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
    async steer(_id, text) {
      steered.push(text);
      if (text === 'rejected') throw new ProviderSteerRejected('provider declined');
      if (text === 'uncertain') await new Promise<void>((_resolve, reject) => {
        rejectSteer = () => reject(new Error('connection lost'));
      });
      return { nativeThreadId: 'thread', nativeTurnId: 'turn' };
    },
  };
  const options = { dataPath: cwd, command: process.execPath, bridgePath: join(cwd, 'bridge.cjs'), publish() {}, providers: [provider] };
  let service = await createWorkbenchService(options);
  try {
    const id = await service.engine.createSession({ cwd, title: 'steer', providerId: info.id });
    service.engine.sendPrompt(id, { text: 'first' });
    await until(() => invoked.length === 1);
    const session = () => service.engine.getSession(id);
    const attempt = session().attempts!.at(-1)!.id;
    const enqueue = (text: string) => {
      service.engine.sendPrompt(id, { text });
      return session().queue!.at(-1)!.id;
    };
    const sent = enqueue('sent');
    const sentId = randomUUID();
    assert.equal(await service.engine.steerQueuedPrompt(id, sent, 0, attempt, sentId), 'sent');
    assert.equal(await service.engine.steerQueuedPrompt(id, sent, 0, attempt, sentId), 'sent');
    assert.equal(session().messages.at(-1)?.nativeTurnId, 'turn');
    const rejected = enqueue('rejected');
    const rejectedId = randomUUID();
    assert.equal(await service.engine.steerQueuedPrompt(id, rejected, 0, attempt, rejectedId), 'rejected');
    assert.equal(await service.engine.steerQueuedPrompt(id, rejected, 0, attempt, rejectedId), 'rejected');
    assert.equal(session().queue![0].steeringUnconfirmed, undefined);
    service.engine.removeQueuedPrompt(id, rejected, 1);
    const uncertain = enqueue('uncertain');
    const uncertainId = randomUUID();
    const dispatch = service.engine.steerQueuedPrompt(id, uncertain, 0, attempt, uncertainId);
    await until(() => steered.length === 3);
    finish();
    await service.engine.waitSession(id);
    assert.throws(() => service.engine.removeQueuedPrompt(id, uncertain, 1), /正在确认/);
    rejectSteer();
    assert.equal(await dispatch, 'unconfirmed');
    await service.shutdown();
    service = await createWorkbenchService(options);
    assert.equal(session().queue![0].steeringUnconfirmed, true);
    assert.equal(await service.engine.steerQueuedPrompt(id, uncertain, 0, attempt, uncertainId), 'unconfirmed');
    service.engine.setSessionQueuePaused(id, false);
    assert.deepEqual(invoked, ['first']);
    assert.deepEqual(steered, ['sent', 'rejected', 'uncertain']);
    service.engine.removeQueuedPrompt(id, uncertain, 1);
  } finally { rejectSteer?.(); finish?.(); await service.shutdown(); await rm(cwd, { recursive: true, force: true }); }
});
