import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ProviderInfo } from '../shared/types';
import type { ProviderAdapter } from './providers/types';
import { createWorkbenchService, type WorkbenchService } from './workbench-service';

async function createFixture(run: ProviderAdapter['run'] = async () => {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ensemble-session-views-')));
  const firstProject = join(directory, 'views-project-a'), secondProject = join(directory, 'views-project-b');
  await Promise.all([mkdir(firstProject), mkdir(secondProject)]);
  const info: ProviderInfo = { id: 'views-fixture', name: 'Views fixture', source: 'plugin', available: true,
    detail: 'fixture-binary@v1', capabilities: { resume: true, approvals: false } };
  const options = { dataPath: join(directory, 'data'), command: process.execPath, bridgePath: join(directory, 'bridge.cjs'),
    providers: [{ info, run }], publish() {} };
  let current: WorkbenchService | undefined;
  try { current = await createWorkbenchService(options); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return {
    directory, firstProject, secondProject, info,
    get service() { assert(current, 'Fixture backend is closed'); return current; },
    async restart() { await current!.shutdown(); current = undefined; current = await createWorkbenchService(options); },
    async close() { try { await current?.shutdown(); } finally { await rm(directory, { recursive: true, force: true }); } },
  };
}

test('service read acknowledgements persist exact revisions without clearing failures or newer results', async () => {
  const fixture = await createFixture(async context => {
    if (context.prompt === 'fail') throw new Error('Fixture requested failure');
    context.emit({ type: 'text', itemId: 'result', text: 'Fixture completed' });
  });
  try {
    const id = await fixture.service.engine.createSession({ title: 'Attention fixture', providerId: fixture.info.id, cwd: fixture.firstProject });
    await fixture.service.call('workbench:send-prompt', [id, { text: 'fail' }, 'attention-failure']); await fixture.service.engine.waitSession(id);
    const failed = fixture.service.engine.getSession(id);
    assert.equal(failed.status, 'failed'); assert.equal(failed.attention?.reason, 'failure');
    assert(failed.attention && failed.attention.revision > failed.attention.seenRevision);
    const failureRevision = failed.attention.revision;
    await fixture.service.call('workbench:mark-session-seen', [id, failureRevision]);
    let state = fixture.service.engine.getSession(id);
    assert.equal(state.status, 'failed'); assert.equal(state.error, 'Fixture requested failure');
    assert.equal(state.attempts?.at(-1)?.status, 'failed'); assert.equal(state.attention?.seenRevision, failureRevision);
    await fixture.restart();
    state = fixture.service.engine.getSession(id);
    assert.equal(state.status, 'failed'); assert.equal(state.attention?.revision, failureRevision); assert.equal(state.attention?.seenRevision, failureRevision);

    await fixture.service.call('workbench:set-session-queue-paused', [id, false]);
    await fixture.service.call('workbench:send-prompt', [id, { text: 'complete' }, 'attention-new-result']); await fixture.service.engine.waitSession(id);
    const completed = fixture.service.engine.getSession(id);
    assert.equal(completed.status, 'completed'); assert.equal(completed.attention?.reason, 'result');
    assert(completed.attention && completed.attention.revision > failureRevision);
    const resultRevision = completed.attention.revision;
    await fixture.service.call('workbench:mark-session-seen', [id, failureRevision]);
    assert.equal(fixture.service.engine.getSession(id).attention?.seenRevision, failureRevision);
    await assert.rejects(fixture.service.call('workbench:mark-session-seen', [id, resultRevision + 1]), /尚未收到/);
    await fixture.service.call('workbench:mark-session-seen', [id, 0]);
    assert.equal(fixture.service.engine.getSession(id).attention?.seenRevision, failureRevision);
    await fixture.restart();
    state = fixture.service.engine.getSession(id);
    assert.equal(state.attention?.revision, resultRevision); assert.equal(state.attention?.seenRevision, failureRevision);
    assert.equal(state.attention?.reason, 'result');
    await fixture.service.call('workbench:mark-session-seen', [id, resultRevision]);
    await fixture.restart();
    assert.equal(fixture.service.engine.getSession(id).attention?.seenRevision, resultRevision);
  } finally { await fixture.close(); }
});
test('service Stop forwarding fences a delayed request to its captured attempt', async () => {
  let firstStarted!: () => void, secondStarted!: () => void, releaseFirst!: () => void;
  const first = new Promise<void>(resolve => { firstStarted = resolve; });
  const second = new Promise<void>(resolve => { secondStarted = resolve; });
  const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let runs = 0, cancelled = false;
  const fixture = await createFixture(async context => {
    if (++runs === 1) { firstStarted(); await gate; return; }
    secondStarted();
    await new Promise<void>(resolve => context.signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
  });
  try {
    const id = await fixture.service.engine.createSession({ title: 'Stop route', providerId: fixture.info.id, cwd: fixture.firstProject });
    await fixture.service.call('workbench:send-prompt', [id, { text: 'first' }, 'route-first']); await first;
    const previousAttempt = fixture.service.engine.getSession(id).attempts!.at(-1)!.id;
    releaseFirst(); await fixture.service.engine.waitSession(id);
    await fixture.service.call('workbench:send-prompt', [id, { text: 'second' }, 'route-second']); await second;
    const currentAttempt = fixture.service.engine.getSession(id).attempts!.at(-1)!.id;
    await assert.rejects(fixture.service.call('workbench:cancel-session', [id, 'delayed-stop', previousAttempt]), /回合已结束/);
    assert.equal(cancelled, false); assert.equal(fixture.service.engine.getSession(id).status, 'running');
    await fixture.service.call('workbench:cancel-session', [id, 'current-stop', currentAttempt]);
    await fixture.service.engine.waitSession(id);
    assert.equal(cancelled, true); assert.equal(fixture.service.engine.getSession(id).status, 'cancelled');
  } finally { releaseFirst(); await fixture.close(); }
});
