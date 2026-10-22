import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from './store';
import { WorkbenchEngine } from './engine';
import { CollaborationCore, type CollaborationPrincipal } from './collaboration-core';
import { COLLABORATION_MCP_TOOLS, collaborationOperationSchemas } from './mcp-tool-catalog';
import { createImplementationReviewDraft, participantPermissionIssue } from '../renderer/collaboration-template';
import type { CollaborationParticipant } from '../shared/collaboration';
import type { ProviderAdapter, TurnContext } from './providers/types';

const user: CollaborationPrincipal = { kind: 'user' };
const permissions = { submitTasks: true, sendMessages: true, configureRun: true, publishArtifacts: true };
const participant = (id: string, mode: 'managed' | 'external' = 'managed'): CollaborationParticipant => ({
  id, name: id, mode, roles: [`用户职责 ${id}`], ...(mode === 'managed' ? { providerId: 'fixture' } : {}), permissions,
});
async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 400; index++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('collaboration did not settle');
}
async function fixture(run: (context: TurnContext) => Promise<void> = async context => { context.emit({ type: 'text', itemId: 'one', text: 'actual result' }); }) {
  const cwd = await mkdtemp(join(tmpdir(), 'workbench-core-'));
  const store = new StateStore(join(cwd, 'data', 'state.json')); await store.load();
  const engine = new WorkbenchEngine(store, join(cwd, 'plugins'), () => {});
  const adapter: ProviderAdapter = { info: { id: 'fixture', name: 'Controlled', source: 'plugin', available: true, detail: 'no model',
    capabilities: { resume: true, approvals: true, permissions: true } }, run };
  engine.setProviders([adapter], [], []);
  const core = new CollaborationCore(store, engine);
  return { cwd, store, engine, core,
    async create(participants: CollaborationParticipant[] = [participant('work')], extra: Record<string, unknown> = {}) {
      return await core.call(user, 'create_run', { requestId: 'create-run', name: 'user configured', cwd, participants, relationships: [], start: true, ...extra }) as { runId: string; version: number };
    }, async close() { await engine.shutdown(); await rm(cwd, { recursive: true, force: true }); } };
}

test('MCP mutation schemas require stable request IDs before accepting native tool calls', async () => {
  const reads = new Set(['get_context', 'get_run', 'get_artifact', 'wait_events']);
  for (const tool of COLLABORATION_MCP_TOOLS) {
    if (reads.has(tool.name)) assert.equal('requestId' in tool.schema, false, tool.name);
    else {
      assert.equal(tool.schema.requestId.isOptional(), false, tool.name);
      assert.match(tool.schema.requestId.description ?? '', /stable identifier/i);
    }
  }
  const publish = collaborationOperationSchemas.get('publish_artifact')!;
  assert.equal(publish.safeParse({ runId: 'run', taskId: 'task', name: 'actual-file', path: '/workspace/result.json' }).success, false);
  assert.equal(publish.safeParse({ requestId: 'publish-result-v1', runId: 'run', taskId: 'task', name: 'actual-file', path: '/workspace/result.json' }).success, true);
});

test('arbitrary roles, immutable artifact versions and actual injected data survive one SQLite transaction pipeline', async () => {
  let prompt = '';
  const f = await fixture(async context => { prompt = context.prompt; context.emit({ type: 'external-id', id: 'native-real' });
    context.emit({ type: 'structured', event: { id: 'tool', kind: 'tool', title: 'real tool', status: 'completed', output: 'real output' } });
    context.emit({ type: 'text', itemId: 'result', text: 'verified outcome' }); });
  try {
    const { runId } = await f.create();
    const one = await f.core.call(user, 'publish_artifact', { requestId: 'plan-v1', runId, name: 'plan', content: 'PLAN V1' }) as { id: string; artifactId: string };
    const two = await f.core.call(user, 'publish_artifact', { requestId: 'plan-v2', runId, name: 'plan', artifactId: one.artifactId, content: 'PLAN V2' }) as { id: string };
    const submitted = await f.core.call(user, 'submit_task', { requestId: 'once', runId, participantId: 'work', title: 'build', prompt: 'implement', artifactIds: [one.id] }) as { taskId: string };
    const replay = await f.core.call(user, 'submit_task', { requestId: 'once', runId, participantId: 'work', title: 'build', prompt: 'implement', artifactIds: [one.id] });
    assert.deepEqual(replay, submitted);
    await assert.rejects(f.core.call(user, 'submit_task', { requestId: 'once', runId, participantId: 'work', title: 'build', prompt: 'changed' }), /requestId/);
    await until(() => f.store.state.collaboration.tasks.find(task => task.id === submitted.taskId)?.status === 'completed');
    const task = f.store.state.collaboration.tasks[0];
    assert.match(prompt, /PLAN V1/); assert.doesNotMatch(prompt, /PLAN V2/);
    assert.deepEqual(task.participantSnapshot.roles, ['用户职责 work']);
    assert.equal(task.attempts[0].nativeId, 'native-real'); assert.ok(task.attempts[0].engineAttemptId);
    const events = f.core.queryEvents(user, { runId });
    assert.ok(events.find(event => event.type === 'input.injected' && event.data.prompt === prompt));
    assert.ok(events.find(event => event.type === 'artifact.injected' && event.artifactVersionId === one.id));
    assert.ok(events.find(event => event.type === 'runtime.structured'));
    assert.equal(events.some(event => event.type === 'artifact.injected' && event.artifactVersionId === two.id), false);
    assert.equal(f.store.state.collaboration.runs[0].status, 'running', 'dynamic runs require explicit finish');
    await f.core.call(user, 'control_run', { requestId: 'finish', runId, action: 'finish' });
    assert.equal(f.store.state.collaboration.runs[0].status, 'completed');
  } finally { await f.close(); }
});

test('a managed caller yields its physical turn and resumes its original native session after an arbitrary participant executes', async () => {
  let core!: CollaborationCore; let phases = 0; let workTask = ''; let coordinatorNative = '';
  const f = await fixture(async context => {
    const current = core.managedCaller(context.session.id, context.session.attempts!.at(-1)!.id)!;
    assert.ok(current);
    context.emit({ type: 'external-id', id: context.session.externalId ?? `native-${context.session.id}` });
    const identity = current as Extract<CollaborationPrincipal, { kind: 'managed' }>;
    if (identity.participantId === 'coordinate') {
      if (phases++ === 0) {
        coordinatorNative = `native-${context.session.id}`;
        const submitted = await core.call(current, 'submit_task', { requestId: 'delegated', runId: identity.runId, participantId: 'execute', title: 'worker', prompt: 'do work' }) as { taskId: string };
        workTask = submitted.taskId;
        const waiting = await core.call(current, 'wait_events', { runId: identity.runId, taskIds: [workTask], timeoutMs: 30000 }) as { disposition: string };
        assert.equal(waiting.disposition, 'turn_must_finish');
        context.emit({ type: 'text', itemId: 'result', text: 'handed over' });
      } else {
        assert.equal(context.session.externalId, coordinatorNative); assert.match(context.prompt, /WORK=12/);
        context.emit({ type: 'text', itemId: 'result', text: 'FINAL=13' });
      }
    } else context.emit({ type: 'text', itemId: 'result', text: 'WORK=12' });
  }); core = f.core;
  try {
    const readOnlyCoordinator = { ...participant('coordinate'), settings: { permission: 'read-only' as const }, permissions: { ...permissions, workspace: { cwd: f.cwd, access: 'read-only' as const } } };
    const { runId } = await f.create([readOnlyCoordinator, participant('execute')], { limits: { maxAttemptsPerTask: 1, maxTaskTurns: 3 } });
    const { taskId } = await core.call(user, 'submit_task', { requestId: 'start-coordinate', runId, participantId: 'coordinate', title: 'coordinate', prompt: 'start' }) as { taskId: string };
    await until(() => f.store.state.collaboration.tasks.find(task => task.id === taskId)?.status === 'completed');
    const task = f.store.state.collaboration.tasks.find(task => task.id === taskId)!;
    assert.equal(task.result, 'FINAL=13'); assert.equal(task.attempts.length, 2); assert.equal(phases, 2);
    assert.equal(task.attempts[1].retryOf, undefined); assert.equal(task.attempts[1].continuationOf, task.attempts[0].id);
    assert.equal(task.attempts[0].outputArtifactIds.length, 1);
    assert.equal(task.attempts.reduce((sum, attempt) => sum + (attempt.physicalTurns ?? 0), 0), 2);
    assert.equal(f.store.state.collaboration.tasks.find(task => task.id === workTask)?.parentTaskId, taskId);
    assert.ok(f.store.events(runId).some(event => event.type === 'artifact.injected' && event.targetParticipantId === 'coordinate'));
  } finally { await f.close(); }
});

test('an ordinary read-only session cannot grant itself writable workers by creating a run', async () => {
  let core!: CollaborationCore;
  const f = await fixture(async context => {
    await assert.rejects(core.call({ kind: 'session', sessionId: context.session.id, attemptId: context.session.attempts!.at(-1)!.id }, 'create_run', {
      requestId: 'no-escalation', name: 'attempted', cwd: f.cwd, callerParticipantId: 'source', start: true, relationships: [],
      participants: [{ ...participant('source'), settings: { permission: 'read-only' }, permissions: { ...permissions, workspace: { cwd: f.cwd, access: 'read-only' } } }, participant('writable')],
    }), /不能通过创建协作扩大执行权限/);
    context.emit({ type: 'text', itemId: 'result', text: 'permission preserved' });
  }); core = f.core;
  try {
    const id = await f.engine.createSession({ title: 'read-only', providerId: 'fixture', cwd: f.cwd });
    f.engine.updateSession(id, { settings: { permission: 'read-only' } }); f.engine.sendMessage(id, 'try delegation');
    await until(() => f.engine.getSession(id).status === 'completed'); assert.equal(f.store.state.collaboration.runs.length, 0);
  } finally { await f.close(); }
});

test('external tasks require a user-granted identity and exact attempt, and revoked or stale claims cannot submit results', async () => {
  const f = await fixture();
  try {
    f.store.atomic(state => state.collaboration.identities.push({ id: 'external', name: 'any client', tokenHash: 'not-secret', createdAt: new Date().toISOString(), policy: { createRuns: false, workspaceRoots: [f.cwd] } }));
    const external = { kind: 'external', identityId: 'external' } as const;
    const e = { ...participant('remote', 'external'), binding: { identityId: 'external' } };
    const { runId } = await f.create([e]);
    await assert.rejects(f.core.call(external, 'create_run', { requestId: 'forbidden', name: 'no', cwd: f.cwd, participants: [e], relationships: [], callerParticipantId: e.id }), /创建运行/);
    const { taskId } = await f.core.call(user, 'submit_task', { requestId: 'external-work', runId, participantId: 'remote', title: 'external work', prompt: 'calculate' }) as { taskId: string };
    await until(() => f.store.state.collaboration.tasks[0].status === 'queued');
    const claim = await f.core.call(external, 'claim_task', { requestId: 'claim', runId, taskId }) as { attemptId: string };
    await assert.rejects(f.core.call(external, 'submit_result', { requestId: 'wrong', runId, taskId, attemptId: 'wrong', status: 'completed', text: 'fake' }), /有效/);
    await f.core.call(external, 'submit_result', { requestId: 'done', runId, taskId, attemptId: claim.attemptId, status: 'completed', text: 'REMOTE=7' });
    assert.equal(f.store.state.collaboration.tasks[0].result, 'REMOTE=7');
    await assert.rejects(f.core.call(external, 'submit_result', { requestId: 'late', runId, taskId, attemptId: claim.attemptId, status: 'completed', text: 'overwrite' }), /有效/);
    await f.core.call(external, 'update_run', { requestId: 'config', runId, expectedVersion: 1, name: 'renamed by user-authorized configure' });
    f.store.atomic(state => { state.collaboration.grants[0].revokedAt = new Date().toISOString(); });
    await assert.rejects(f.core.call(external, 'get_run', { runId }), /授权/);
  } finally { await f.close(); }
});

test('actual failed retries consume attempt allowance while normal continuation does not', async () => {
  const f = await fixture(async () => { throw new Error('controlled runtime failure'); });
  try {
    const { runId } = await f.create(undefined, { limits: { maxAttemptsPerTask: 1, maxTaskTurns: 3 } });
    const { taskId } = await f.core.call(user, 'submit_task', { requestId: 'fail-once', runId, participantId: 'work', title: 'fail once', prompt: 'fail' }) as { taskId: string };
    await until(() => f.store.state.collaboration.tasks[0].status === 'failed');
    await assert.rejects(f.core.call(user, 'control_task', { requestId: 'retry', runId, taskId, action: 'retry' }), /尝试次数/);
    assert.equal(f.store.state.collaboration.tasks[0].attempts.length, 1);
  } finally { await f.close(); }
});

test('waiting for explicit tasks ignores unrelated progress and reports timeout even when events exist', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async context => { await gate; context.emit({ type: 'text', itemId: 'result', text: 'finished' }); });
  try {
    const { runId } = await f.create();
    const { taskId } = await f.core.call(user, 'submit_task', { requestId: 'gated', runId, participantId: 'work', title: 'gated', prompt: 'work' }) as { taskId: string };
    const timed = await f.core.call(user, 'wait_events', { runId, taskIds: [taskId], timeoutMs: 10 }) as { timedOut: boolean; events: unknown[] };
    assert.equal(timed.timedOut, true); assert.ok(timed.events.length > 0);
    let returned = false;
    const pending = f.core.call(user, 'wait_events', { runId, taskIds: [taskId], timeoutMs: 1000 }).then(value => { returned = true; return value as { timedOut: boolean; tasks: { result: string }[] }; });
    await f.core.call(user, 'publish_artifact', { requestId: 'unrelated-progress', runId, name: 'unrelated progress', content: 'no result yet' });
    assert.equal(returned, false); release();
    const result = await pending; assert.equal(result.timedOut, false); assert.equal(result.tasks[0].result, 'finished');
  } finally { release(); await f.close(); }
});

test('stopping the backend records interrupted work and explicit resume preserves native identity without rerunning completed tasks', async () => {
  const f = await fixture(async context => {
    context.emit({ type: 'external-id', id: 'native-before-stop' });
    await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  let resumed: WorkbenchEngine | undefined;
  try {
    const { runId } = await f.create();
    const { taskId } = await f.core.call(user, 'submit_task', { requestId: 'unfinished', runId, participantId: 'work', title: 'unfinished', prompt: 'work' }) as { taskId: string };
    await until(() => f.store.state.collaboration.tasks[0].attempts[0]?.nativeId === 'native-before-stop');
    await f.engine.shutdown();
    const store = new StateStore(f.store.path); await store.load();
    assert.equal(store.state.collaboration.runs[0].status, 'interrupted');
    assert.equal(store.state.collaboration.tasks[0].status, 'interrupted');
    assert.equal(store.state.collaboration.tasks[0].attempts[0].status, 'interrupted');
    let calls = 0; resumed = new WorkbenchEngine(store, f.engine.pluginPath, () => {});
    const core = new CollaborationCore(store, resumed);
    resumed.setProviders([{ info: { id: 'fixture', name: 'fixture', source: 'plugin', available: true, detail: '', capabilities: { resume: true, approvals: true } },
      async run(context) { calls++; assert.equal(context.session.externalId, 'native-before-stop'); context.emit({ type: 'text', itemId: 'result', text: 'resumed' }); } }], [], []);
    await resumed.prepareExecutionKeys(); assert.equal(calls, 0);
    await core.call(user, 'control_run', { requestId: 'resume', runId, action: 'resume' });
    await until(() => store.state.collaboration.tasks.find(task => task.id === taskId)?.status === 'completed');
    assert.equal(calls, 1); assert.equal(store.state.collaboration.tasks[0].attempts[0].status, 'interrupted');
    assert.equal(store.state.collaboration.tasks[0].attempts[1].retryOf, store.state.collaboration.tasks[0].attempts[0].id);
  } finally { await resumed?.shutdown(); await f.close(); }
});

test('new role versions affect new tasks while hard limits without provider support are explicitly rejected', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.create(undefined, { limits: { maxInputTokens: 1 } }), /硬上限/);
    await assert.rejects(f.create(undefined, { limits: { unimplementedBudget: 1 } }), /Unrecognized/);
    await assert.rejects(f.create([{ ...participant('unavailable tool policy'), permissions: { ...permissions, allowedTools: ['read'] } }]), /白名单/);
    const { runId } = await f.create([participant('a')], { start: false });
    await f.core.call(user, 'submit_task', { requestId: 'before', runId, participantId: 'a', title: 'before', prompt: 'one' });
    await f.core.call(user, 'update_run', { requestId: 'configuration-v2', runId, expectedVersion: 1, participants: [{ ...participant('a'), roles: ['全新职责'], permissions: { ...permissions, submitTasks: false } }] });
    await f.core.call(user, 'submit_task', { requestId: 'after', runId, participantId: 'a', title: 'after', prompt: 'two' });
    assert.deepEqual(f.store.state.collaboration.tasks.map(task => task.definitionVersion), [1, 2]);
    assert.deepEqual(f.store.state.collaboration.tasks.map(task => task.participantSnapshot.roles), [['用户职责 a'], ['全新职责']]);
    assert.deepEqual(f.store.state.collaboration.tasks.map(task => task.participantSnapshot.permissions.submitTasks), [true, false]);
  } finally { await f.close(); }
});

test('immutable file artifacts preserve their bytes when the source changes', async () => {
  const f = await fixture();
  try {
    const { runId } = await f.create(); const source = join(f.cwd, 'plan.txt'); await writeFile(source, 'original version');
    const artifact = await f.core.call(user, 'publish_artifact', { requestId: 'plan-file', runId, name: 'plan', path: source }) as { id: string; path: string };
    await writeFile(source, 'later changed');
    const loaded = await f.core.call(user, 'get_artifact', { runId, artifactVersionId: artifact.id }) as { content: string };
    assert.equal(loaded.content, 'original version'); assert.equal(await readFile(artifact.path, 'utf8'), 'original version');
    const unrelated = await mkdtemp(join(tmpdir(), 'workbench-unrelated-'));
    try { const file = join(unrelated, 'outside.txt'); await writeFile(file, 'outside'); await assert.rejects(f.core.call(user, 'publish_artifact', { requestId: 'outside-file', runId, name: 'outside', path: file }), /授权目录/); }
    finally { await rm(unrelated, { recursive: true, force: true }); }
  } finally { await f.close(); }
});

test('draft template edits synchronize the launch plan without rewriting manual tasks or executed history', async () => {
  const turns: { prompt: string; permission?: string }[] = [];
  const f = await fixture(async context => {
    turns.push({ prompt: context.prompt, permission: context.session.settings?.permission });
    context.emit({ type: 'text', itemId: 'result', text: 'controlled result' });
  });
  const step = (id: string, prompt: string, dependsOn: string[] = []) => ({ id, title: prompt, participantId: 'work', prompt, dependsOn, artifactIds: [] });
  try {
    const { runId } = await f.create(undefined, { start: false, completion: 'all-tasks',
      steps: [step('keep', 'OLD-TARGET', ['remove']), step('remove', 'REMOVED-TARGET')] });
    const initial = f.store.state.collaboration.tasks.map(task => ({ id: task.id, templateId: task.templateId }));
    const keepId = initial.find(task => task.templateId === 'keep')!.id;
    const { taskId: manualId } = await f.core.call(user, 'submit_task', {
      requestId: 'manual', runId, participantId: 'work', title: 'Manual task', prompt: 'MANUAL-TARGET', dependsOn: [keepId],
    }) as { taskId: string };
    const before = structuredClone(f.store.state.collaboration);
    await assert.rejects(f.core.call(user, 'update_run', {
      requestId: 'invalid-edit', runId, expectedVersion: 1, steps: [step('remove', 'REMOVED-TARGET')],
    }), /仍被其他任务、消息或资料引用/);
    assert.deepEqual(f.store.state.collaboration, before, 'a rejected deletion rolls back the definition and every task');
    const readOnly = { ...participant('work'), name: 'Updated worker', settings: { permission: 'read-only' as const },
      permissions: { ...permissions, workspace: { cwd: f.cwd, access: 'read-only' as const } } };
    await f.core.call(user, 'update_run', { requestId: 'edit', runId, expectedVersion: 1, participants: [readOnly],
      steps: [step('keep', 'NEW-TARGET'), step('added', 'ADDED-TARGET', ['keep'])] });
    const tasks = f.store.state.collaboration.tasks;
    const kept = tasks.find(task => task.templateId === 'keep')!, added = tasks.find(task => task.templateId === 'added')!;
    assert.equal(kept.id, keepId);
    assert.equal(kept.prompt, 'NEW-TARGET'); assert.deepEqual(kept.dependsOn, []);
    assert.equal(kept.definitionVersion, 2); assert.equal(kept.participantSnapshot.settings?.permission, 'read-only');
    assert.deepEqual(added.dependsOn, [keepId]);
    assert.equal(tasks.some(task => task.templateId === 'remove'), false);
    assert.deepEqual(tasks.find(task => task.id === manualId), before.tasks.find(task => task.id === manualId));
    await f.core.call(user, 'control_run', { requestId: 'start-edited', runId, action: 'start' });
    await until(() => f.store.state.collaboration.runs[0].status === 'completed');
    assert.equal(turns.length, 3);
    assert.ok(turns.every(turn => !turn.prompt.includes('OLD-TARGET') && !turn.prompt.includes('REMOVED-TARGET')));
    assert.equal(turns.find(turn => turn.prompt.includes('NEW-TARGET'))?.permission, 'read-only');
    assert.equal(turns.find(turn => turn.prompt.includes('ADDED-TARGET'))?.permission, 'read-only');
    assert.equal(turns.find(turn => turn.prompt.includes('MANUAL-TARGET'))?.permission, undefined);
    const history = structuredClone(f.store.state.collaboration.tasks);
    await f.core.call(user, 'update_run', { requestId: 'after-execution', runId, expectedVersion: 2, steps: [] });
    assert.deepEqual(f.store.state.collaboration.tasks, history);
  } finally { await f.close(); }
});

test('deadline updates remove, extend and shorten the active timer while a run is paused', async t => {
  const f = await fixture(async context => {
    await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  try {
    const { runId } = await f.create();
    await f.core.call(user, 'submit_task', { requestId: 'gated', runId, participantId: 'work', title: 'Gated task', prompt: 'wait' });
    await until(() => f.store.state.collaboration.tasks[0].status === 'running');
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    const deadline = (milliseconds: number) => new Date(Date.now() + milliseconds).toISOString();
    await f.core.call(user, 'update_run', { requestId: 'add-deadline', runId, expectedVersion: 1, limits: { deadlineAt: deadline(1000) } });
    await f.core.call(user, 'update_run', { requestId: 'remove-deadline', runId, expectedVersion: 2, limits: {} });
    t.mock.timers.tick(1000);
    assert.equal(f.store.state.collaboration.runs[0].status, 'running');
    assert.equal(f.store.state.collaboration.tasks[0].status, 'running');
    await f.core.call(user, 'update_run', { requestId: 'another-deadline', runId, expectedVersion: 3, limits: { deadlineAt: deadline(1000) } });
    await f.core.call(user, 'update_run', { requestId: 'extend-deadline', runId, expectedVersion: 4, limits: { deadlineAt: deadline(2000) } });
    t.mock.timers.tick(1000);
    assert.equal(f.store.state.collaboration.runs[0].status, 'running');
    await f.core.call(user, 'control_run', { requestId: 'pause', runId, action: 'pause' });
    await f.core.call(user, 'update_run', { requestId: 'shorten-deadline', runId, expectedVersion: 5, limits: { deadlineAt: deadline(100) } });
    t.mock.timers.tick(100);
    assert.equal(f.store.state.collaboration.runs[0].status, 'failed');
    assert.equal(f.store.state.collaboration.tasks[0].status, 'cancelled');
    assert.match(f.store.state.collaboration.runs[0].error ?? '', /截止时间/);
  } finally { t.mock.timers.reset(); await f.close(); }
});

test('implementation-review starter waits for start and passes the goal and output to a read-only reviewer', async () => {
  const turns: { prompt: string; permission?: string }[] = [];
  const f = await fixture(async context => {
    turns.push({ prompt: context.prompt, permission: context.session.settings?.permission });
    context.emit({ type: 'text', itemId: 'result', text: turns.length === 1 ? 'Implemented the requested whitespace fix; focused check passed.' : 'Reviewed the actual change without modifying files.' });
  });
  try {
    const provider = f.engine.snapshot().providers[0];
    const goal = 'Trim surrounding search whitespace while keeping empty-query behavior.';
    const definition = createImplementationReviewDraft({ cwd: f.cwd, implementer: provider, reviewer: provider, goal });
    const unsupported = { ...provider, capabilities: { ...provider.capabilities, permissions: false } };
    assert.match(participantPermissionIssue(definition.participants[1], unsupported) ?? '', /不支持.*只读/);
    assert.equal(definition.participants[1].permissions.workspace?.access, 'read-only');
    const { runId } = await f.core.call(user, 'create_run', { requestId: 'starter-draft', ...definition, start: false }) as { runId: string };
    assert.equal(turns.length, 0);
    assert.equal(f.store.state.collaboration.runs.find(run => run.id === runId)?.status, 'draft');
    assert.ok(f.store.state.collaboration.tasks.every(task => task.status === 'pending'));
    await f.core.call(user, 'control_run', { requestId: 'starter-start', runId, action: 'start' });
    await until(() => f.store.state.collaboration.runs.find(run => run.id === runId)?.status === 'completed');
    assert.equal(turns.length, 2);
    assert.deepEqual(turns.map(turn => turn.permission), ['review', 'read-only']);
    assert.ok(turns.every(turn => turn.prompt.includes(goal)));
    assert.match(turns[1].prompt, /Implemented the requested whitespace fix/);
    const tasks = f.store.state.collaboration.tasks.filter(task => task.runId === runId);
    assert.deepEqual(tasks[1].dependsOn, [tasks[0].id]);
    assert.deepEqual(tasks[1].attempts[0].inputArtifactIds, tasks[0].attempts[0].outputArtifactIds);
  } finally { await f.close(); }
});

test('fixed workflows use the same task scheduler and pass proven predecessor artifact versions', async () => {
  const turns: string[] = []; const f = await fixture(async context => {
    turns.push(context.prompt); context.emit({ type: 'text', itemId: 'result', text: turns.length === 1 ? 'FIRST=21' : 'SECOND=22' });
  });
  try {
    const id = await f.engine.createWorkflow({ name: 'fixed', cwd: f.cwd, steps: [
      { id: 'a', title: 'a', providerId: 'fixture', prompt: 'first', dependsOn: [] },
      { id: 'b', title: 'b', providerId: 'fixture', prompt: 'second', dependsOn: ['a'] },
    ] }); f.engine.startWorkflow(id);
    await until(() => f.engine.snapshot().workflows[0].status === 'completed');
    assert.equal(turns.length, 2); assert.match(turns[1], /FIRST=21/);
    assert.equal(f.store.state.collaboration.runs.length, 1); assert.equal(f.store.state.collaboration.tasks.length, 2);
    assert.ok(f.store.state.collaboration.tasks.every(task => task.attempts[0].engineAttemptId));
  } finally { await f.close(); }
});

test('an ordinary platform session can bind itself as the caller and continue in its original native session', async () => {
  let core!: CollaborationCore, runId = '', rootId = '', phases = 0;
  const f = await fixture(async context => {
    context.emit({ type: 'external-id', id: context.session.externalId ?? `native-${context.session.id}` });
    const attemptId = context.session.attempts!.at(-1)!.id;
    if (context.session.id === rootId && phases++ === 0) {
      const run = await core.call({ kind: 'session', sessionId: rootId, attemptId }, 'create_run', {
        requestId: 'from-ordinary', name: 'source chat', cwd: f.cwd, participants: [participant('source'), participant('worker')], relationships: [], callerParticipantId: 'source', start: true,
      }) as { runId: string }; runId = run.runId;
      const identity = core.managedCaller(rootId, attemptId)!;
      const child = await core.call(identity, 'submit_task', { requestId: 'one-child', runId, participantId: 'worker', title: 'work', prompt: 'work' }) as { taskId: string };
      await core.call(identity, 'wait_events', { runId, taskIds: [child.taskId] });
    } else if (context.session.id === rootId) {
      assert.equal(context.session.externalId, `native-${rootId}`); assert.match(context.prompt, /CHILD=32/);
      context.emit({ type: 'text', itemId: 'result', text: 'ROOT=33' });
    } else context.emit({ type: 'text', itemId: 'result', text: 'CHILD=32' });
  }); core = f.core;
  try {
    rootId = await f.engine.createSession({ title: 'ordinary', providerId: 'fixture', cwd: f.cwd }); f.engine.sendMessage(rootId, 'begin');
    await until(() => f.store.state.collaboration.tasks.some(task => task.participantId === 'source' && task.status === 'completed'));
    assert.equal(phases, 2); assert.equal(f.store.state.collaboration.tasks.find(task => task.participantId === 'source')?.result, 'ROOT=33');
    assert.ok(f.store.events(runId).some(event => event.type === 'task.attached'));
  } finally { await f.close(); }
});
