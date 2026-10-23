import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { CollaborationCaller, Session } from '../shared/types';
import type { ProviderAdapter, TurnContext } from './providers/types';
import { WorkbenchEngine } from './engine';
import { CollaborationCore } from './collaboration-core';
import { StateStore } from './store';
import { WorkspaceFiles } from './workspace-files';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 3));
async function until(predicate: () => boolean) {
  for (let index = 0; index < 300; index++) { if (predicate()) return; await tick(); }
  assert.fail('state did not settle');
}
function gate() { let open!: () => void; const done = new Promise<void>(resolve => { open = resolve; }); return { open, done }; }
async function fixture(run: (context: TurnContext) => Promise<void>, extra: Partial<ProviderAdapter> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'workbench-collaboration-'));
  const store = new StateStore(join(cwd, 'state.json'));
  const engine = new WorkbenchEngine(store, join(cwd, 'plugins'), () => {});
  new CollaborationCore(store, engine);
  const adapter: ProviderAdapter = { info: { id: 'test', name: 'Test', source: 'plugin', available: true, detail: 'fixture',
    capabilities: { resume: true, approvals: true, rewind: true, effort: true, permissions: true } }, run, ...extra };
  engine.setProviders([adapter], [], []);
  return { engine, adapter, store, cwd, async cleanup() { await engine.shutdown(); await rm(cwd, { recursive: true, force: true }); } };
}
const caller = (context: TurnContext): CollaborationCaller => ({ sessionId: context.session.id, attemptId: context.session.attempts!.at(-1)!.id });

test('overlapping non-Git directories are refused before creating an orphan worker', async () => {
  let engine!: WorkbenchEngine; let nested = '';
  const f = await fixture(async context => {
    await assert.rejects(engine.collaborate(caller(context), 'create_worker', {
      requestId: 'nested-root', title: 'nested', providerId: 'test', cwd: nested, prompt: 'work',
    }), /目录.*重叠/);
    context.emit({ type: 'text', itemId: 'result', text: 'refused' });
  });
  engine = f.engine; nested = join(f.cwd, 'nested'); await mkdir(nested);
  try {
    const id = await engine.createSession({ title: 'parent', providerId: 'test', cwd: f.cwd });
    engine.sendMessage(id, 'delegate');
    await until(() => engine.snapshot().sessions[0].status === 'completed');
    assert.equal(engine.snapshot().sessions.length, 1);
  } finally { await f.cleanup(); }
});

test('owned worktree-root and subdirectory work yields, replays receipts once and resumes the original parent before workflow settlement', async () => {
  const order: string[] = [];
  const running = new Set<string>();
  let engine!: WorkbenchEngine;
  let parentId = '';
  let workerId = '';
  let staleCaller!: CollaborationCaller;
  let childCwd = '';
  let rounds = 0;
  const f = await fixture(async context => {
    assert(!running.has(context.session.cwd), 'two physical writers overlapped');
    running.add(context.session.cwd);
    try {
      context.emit({ type: 'external-id', id: context.session.externalId ?? `native-${context.session.id}` });
      if (!context.session.parentSessionId && rounds++ === 0) {
        parentId = context.session.id; staleCaller = caller(context); order.push('parent-dispatch');
        const input = { requestId: 'create-once', title: 'child', providerId: 'test', prompt: 'child task', cwd: childCwd };
        const [first, replay] = await Promise.all([engine.collaborate(caller(context), 'create_worker', input), engine.collaborate(caller(context), 'create_worker', { ...input })]);
        assert.deepEqual(first, replay);
        workerId = (first as { sessionId: string }).sessionId;
        await assert.rejects(engine.collaborate(caller(context), 'create_worker', { ...input, prompt: 'different task' }), /requestId/);
        const wait = await engine.collaborate(caller(context), 'wait_workers', { sessionIds: [workerId], timeoutMs: 30000 }) as { disposition: string };
        assert.equal(wait.disposition, 'parent_turn_must_finish');
        context.emit({ type: 'text', itemId: 'reply', text: 'dispatched' });
      } else if (context.session.parentSessionId) {
        order.push('child'); assert(order.includes('cleanup-parent'));
        await assert.rejects(engine.collaborate(caller(context), 'create_worker', { requestId: 'nested', title: 'grandchild', providerId: 'test', prompt: 'no' }), /不可继续派工/);
        context.emit({ type: 'text', itemId: 'reply', text: 'CHILD_RESULT=11' });
      } else {
        order.push('parent-resume');
        assert.equal(context.session.externalId, `native-${parentId}`);
        assert.match(context.prompt, /CHILD_RESULT=11/);
        assert.equal(engine.snapshot().workflows[0].steps[0].status, 'running');
        context.emit({ type: 'text', itemId: 'reply', text: 'PARENT_RESULT=12' });
      }
    } finally { running.delete(context.session.cwd); }
  });
  engine = f.engine;
  execFileSync('git', ['init', '-q', f.cwd]);
  childCwd = join(f.cwd, 'subdirectory'); await mkdir(childCwd);
  engine.setTurnEnricher(async session => ({ cleanup: async () => { if (!session.parentSessionId) order.push('cleanup-parent'); } }));
  try {
    const workflowId = await engine.createWorkflow({ name: 'dynamic', cwd: f.cwd, steps: [{ id: 'parent', title: 'parent', providerId: 'test', prompt: 'delegate', dependsOn: [] }] });
    engine.startWorkflow(workflowId);
    await until(() => engine.snapshot().workflows[0].status === 'completed');
    assert.deepEqual(order.filter(item => !item.startsWith('cleanup')), ['parent-dispatch', 'child', 'parent-resume']);
    assert.equal(engine.snapshot().sessions.length, 2);
    const parent = engine.snapshot().sessions.find(session => session.id === parentId)!;
    assert.equal(parent.attempts!.length, 1);
    assert.equal(parent.attempts![0].status, 'completed');
    assert(parent.messages.some(message => message.text === 'PARENT_RESULT=12'));
    await assert.rejects(engine.collaborate(staleCaller, 'get_worker', { sessionId: workerId }), /回合已结束/);
    await f.store.flush();
    await f.engine.shutdown();
    const restored = new StateStore(f.store.path); await restored.load();
    assert.equal(restored.state.receipts.length, 1);
    assert.equal(restored.state.mails[0].toAttemptId, parent.attempts![0].id);
    assert(restored.state.mails.every(mail => mail.delivered));
    await restored.close();
  } finally { await f.cleanup(); }
});

test('bounded cross-directory waits preserve running state and parent cancellation stops only owned workers', async () => {
  let engine!: WorkbenchEngine;
  const release = gate();
  let workerId = '';
  let waiting = false;
  let independentAborted = false;
  let parentCaller!: CollaborationCaller;
  let newTaskTurns = 0;
  const secondCwd = await mkdtemp(join(tmpdir(), 'workbench-worker-'));
  const independentCwd = await mkdtemp(join(tmpdir(), 'workbench-independent-'));
  const f = await fixture(async context => {
    if (context.prompt === 'new-task') { newTaskTurns++; context.emit({ type: 'text', itemId: 'new', text: 'new output' }); return; }
    if (context.prompt === 'independent') {
      await Promise.race([release.done, new Promise<void>(resolve => context.signal.addEventListener('abort', () => { independentAborted = true; resolve(); }, { once: true }))]);
      return;
    }
    if (context.session.parentSessionId) {
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      return;
    }
    parentCaller = caller(context);
    const result = await engine.collaborate(parentCaller, 'create_worker', { requestId: 'cross', title: 'worker', providerId: 'test', prompt: 'wait', cwd: secondCwd }) as { sessionId: string };
    workerId = result.sessionId;
    const wait = await engine.collaborate(parentCaller, 'wait_workers', { sessionIds: [workerId], timeoutMs: 5 }) as { timedOut: boolean };
    assert.equal(wait.timedOut, true);
    assert.equal(engine.snapshot().sessions.find(session => session.id === workerId)!.status, 'running');
    waiting = true;
    await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  engine = f.engine;
  try {
    const independent = await engine.createSession({ title: 'independent', providerId: 'test', cwd: independentCwd });
    const parent = await engine.createSession({ title: 'parent', providerId: 'test', cwd: f.cwd });
    engine.sendMessage(independent, 'independent'); engine.sendMessage(parent, 'parent');
    await until(() => waiting);
    engine.cancelSession(parent);
    await until(() => engine.snapshot().sessions.find(session => session.id === parent)!.status === 'cancelled');
    assert.equal(engine.snapshot().sessions.find(session => session.id === workerId)!.status, 'cancelled');
    assert.equal(independentAborted, false);
    assert.equal(engine.snapshot().sessions.find(session => session.id === independent)!.status, 'running');
    await assert.rejects(engine.collaborate(parentCaller, 'get_worker', { sessionId: workerId }), /回合已结束/);
    engine.sendMessage(parent, 'new-task');
    await until(() => engine.snapshot().sessions.find(session => session.id === parent)!.status === 'completed');
    assert.equal(newTaskTurns, 1);
    assert(engine.snapshot().mails!.some(mail => mail.kind === 'result' && mail.toAttemptId === parentCaller.attemptId && !mail.delivered));
    release.open(); await until(() => engine.snapshot().sessions.find(session => session.id === independent)!.status === 'completed');
  } finally { release.open(); await f.cleanup(); await rm(secondCwd, { recursive: true, force: true }); await rm(independentCwd, { recursive: true, force: true }); }
});

test('retry retains successful ancestors and native session identity while copies start with fresh IDs', async () => {
  const calls: string[] = [];
  let fail = true;
  const f = await fixture(async context => {
    calls.push(context.session.title);
    context.emit({ type: 'external-id', id: context.session.externalId ?? `native-${context.session.id}` });
    if (context.session.title.endsWith(' · b') && fail) { fail = false; throw new Error('controlled failure'); }
    context.emit({ type: 'text', itemId: 'result', text: `output-${context.session.title}` });
  });
  try {
    const id = await f.engine.createWorkflow({ name: 'retry', cwd: f.cwd, steps: [
      { id: 'a', title: 'a', providerId: 'test', prompt: 'first', dependsOn: [] },
      { id: 'b', title: 'b', providerId: 'test', prompt: 'fail', dependsOn: ['a'] },
      { id: 'c', title: 'c', providerId: 'test', prompt: 'last', dependsOn: ['b'] },
    ] });
    f.engine.startWorkflow(id); await until(() => f.engine.snapshot().workflows[0].status === 'failed');
    const failed = f.engine.snapshot().workflows[0];
    const failedNative = f.engine.snapshot().sessions.find(session => session.id === failed.steps[1].sessionId)!.externalId;
    f.engine.retryWorkflowStep(id, 'b'); await until(() => f.engine.snapshot().workflows[0].status === 'completed');
    const run = f.engine.snapshot().workflows[0];
    assert.equal(calls.filter(title => title.endsWith(' · a')).length, 1);
    assert.equal(run.steps[1].attempts!.length, 2);
    assert.equal(run.steps[1].attempts![1].retryOf, run.steps[1].attempts![0].id);
    assert.equal(f.engine.snapshot().sessions.find(session => session.id === run.steps[1].sessionId)!.externalId, failedNative);
    assert.deepEqual(run.steps[1].attempts!.map(attempt => attempt.status), ['failed', 'completed']);
    const copyId = await f.engine.cloneWorkflow(id);
    const copy = f.engine.snapshot().workflows.find(workflow => workflow.id === copyId)!;
    assert.equal(copy.status, 'draft');
    assert(copy.steps.every(step => step.status === 'pending' && !step.sessionId && !step.attempts!.length));
    assert(copy.steps.every(step => !run.steps.some(original => original.id === step.id)));
    assert.equal(copy.steps[1].dependsOn[0], copy.steps[0].id);
  } finally { await f.cleanup(); }
});

test('rejected legacy retry and resume leave the completed project available for ordinary execution', async () => {
  const f = await fixture(async context => { context.emit({ type: 'text', itemId: 'result', text: 'done' }); });
  try {
    const workflowId = await f.engine.createWorkflow({ name: 'finished', cwd: f.cwd,
      steps: [{ id: 'step', title: 'step', providerId: 'test', prompt: 'work', dependsOn: [] }] });
    f.engine.startWorkflow(workflowId); await until(() => f.store.state.workflows[0].status === 'completed');
    const cwd = f.store.state.workflows[0].cwd;
    assert.throws(() => f.engine.retryWorkflowStep(workflowId, 'step'), /只能重试/);
    assert.equal(f.engine.projectAvailable(cwd, 'ordinary'), true);
    assert.throws(() => f.engine.resumeWorkflow(workflowId), /无效的协作运行状态/);
    assert.equal(f.engine.projectAvailable(cwd, 'ordinary'), true);
    const sessionId = await f.engine.createSession({ title: 'ordinary', providerId: 'test', cwd: f.cwd });
    f.engine.sendMessage(sessionId, 'work'); await until(() => f.engine.getSession(sessionId).status === 'completed');
    assert.equal(f.store.state.workflows[0].status, 'completed');
  } finally { await f.cleanup(); }
});

test('process events, usage, attachments and split layout persist; fork stays draft and rewind changes local history only after native acknowledgment', async () => {
  let calls = 0;
  let refuse = true;
  const f = await fixture(async context => {
    calls++;
    context.emit({ type: 'external-id', id: context.session.externalId ?? 'original-native' });
    context.emit({ type: 'native-turn', turnId: `turn-${calls}` });
    context.emit({ type: 'structured', event: { id: 'tool-1', kind: 'tool', title: 'Read', status: 'running', input: 'input' } });
    context.emit({ type: 'structured', event: { id: 'tool-1', kind: 'tool', title: 'Read', status: 'completed', output: 'output' } });
    context.emit({ type: 'usage', usage: { id: `usage-${calls}`, source: 'fixture', scope: 'turn', inputTokens: 5, outputTokens: 2, createdAt: new Date().toISOString() } });
    context.emit({ type: 'text', itemId: 'result', text: 'actual output' });
  }, { async rewind(_session, nativeTurn) { assert.equal(nativeTurn, 'turn-1'); if (refuse) throw new Error('native rejected'); } });
  try {
    const id = await f.engine.createSession({ title: 'source', providerId: 'test', cwd: f.cwd });
    const attachment = { id: 'attachment', name: 'note.txt', kind: 'text' as const, mimeType: 'text/plain', size: 3, sha256: 'fixture', ownedPath: '/fixture/note.txt' };
    f.engine.sendPrompt(id, { text: 'question', attachments: [attachment] });
    await until(() => f.engine.snapshot().sessions.find(session => session.id === id)!.status === 'completed');
    const original = f.engine.snapshot().sessions.find(session => session.id === id)!;
    assert.equal(original.messages.filter(message => message.event).length, 1);
    assert.equal(original.messages.find(message => message.event)!.event!.input, 'input');
    const selectedAssistant = original.messages.find(message => message.role === 'assistant')!;
    const fork = await f.engine.forkSession(id, selectedAssistant.id);
    const forked = f.engine.snapshot().sessions.find(session => session.id === fork)!;
    assert.equal(forked.status, 'idle'); assert(!forked.externalId); assert.equal(forked.messages.length, 0);
    assert.match(forked.draft!.text, /actual output/); assert.equal(calls, 1);
    const sourceAssistant = f.store.state.sessions.find(session => session.id === id)!.messages.find(message => message.id === selectedAssistant.id)!;
    sourceAssistant.text = 'x'.repeat(200001);
    await assert.rejects(f.engine.forkSession(id), /200000/);
    assert.equal(f.engine.snapshot().sessions.length, 2);
    sourceAssistant.text = selectedAssistant.text;
    const workspace = f.engine.snapshot().workspaces[0];
    f.engine.splitWorkspace(workspace.id, { tabId: workspace.tabs.find(tab => tab.kind === 'agent' && tab.sessionId === id)!.id, direction: 'vertical', ratio: 0.6 });
    const stored = structuredClone(f.store.state);
    await assert.rejects(f.engine.rewindSession(id, original.messages[0].id), /native rejected/);
    assert.equal(f.engine.snapshot().sessions.find(session => session.id === id)!.messages.length, original.messages.length);
    refuse = false; const returnedDraft = await f.engine.rewindSession(id, original.messages[0].id);
    const rewound = f.engine.snapshot().sessions.find(session => session.id === id)!;
    assert.equal(rewound.messages.length, 0); assert.equal(rewound.externalId, 'original-native'); assert.equal(rewound.draft!.text, 'question');
    assert.deepEqual(returnedDraft, rewound.draft);
    await f.engine.shutdown();
    const restored = new StateStore(f.store.path); await restored.load();
    assert.equal(restored.state.sessions.find(session => session.id === id)!.usage![0].inputTokens, 5);
    assert.equal(stored.workspaces[0].splitRatio, 0.6);
    assert.deepEqual(stored.sessions.find(session => session.id === id)!.messages[0].attachments, [attachment]);
    assert.equal(restored.state.workspaces[0].splitRatio, 0.6); await restored.close();
  } finally { await f.cleanup(); }
});

test('restart interrupts queued, waiting-child and step attempts and dispatches nothing until explicit resume', async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; });
  try {
    const id = await f.engine.createSession({ title: 'unfinished', providerId: 'test', cwd: f.cwd });
    const session: Session = f.store.state.sessions.find(item => item.id === id)!;
    session.status = 'waiting_children';
    session.attempts = [{ id: 'attempt', status: 'queued', userMessageId: 'user', prompt: 'x', startedAt: new Date().toISOString() }];
    const workflow = await f.engine.createWorkflow({ name: 'interrupted', cwd: f.cwd, steps: [{ id: 'step', title: 'step', providerId: 'test', prompt: 'x', dependsOn: [] }] });
    f.store.state.workflows[0].status = 'running';
    f.store.state.workflows[0].steps[0].status = 'running';
    f.store.state.workflows[0].steps[0].sessionId = id;
    f.store.state.workflows[0].steps[0].attempts = [{ id: 'step-attempt', sessionId: id, status: 'running', startedAt: new Date().toISOString() }];
    await f.engine.shutdown();
    const restored = new StateStore(f.store.path); await restored.load();
    assert.equal(restored.state.sessions[0].status, 'interrupted');
    assert.equal(restored.state.sessions[0].attempts![0].status, 'interrupted');
    assert.equal(restored.state.workflows[0].steps[0].attempts![0].status, 'failed');
    const resumed = new WorkbenchEngine(restored, f.engine.pluginPath, () => {});
    new CollaborationCore(restored, resumed);
    resumed.setProviders([{ info: { id: 'test', name: 'Test', source: 'plugin', available: true, detail: '', capabilities: { resume: true, approvals: false } }, async run() { calls++; } }], [], []);
    await resumed.prepareExecutionKeys();
    assert.equal(calls, 0); resumed.resumeWorkflow(workflow);
    await until(() => resumed.snapshot().workflows[0].status === 'completed'); assert.equal(calls, 1);
    await resumed.shutdown();
  } finally { await f.cleanup(); }
});

test('restoring a missing historical directory keeps chats readable and refuses execution without blocking valid projects', async () => {
  let resumed: WorkbenchEngine | undefined;
  let missingCwd = '';
  let calls = 0;
  const f = await fixture(async context => {
    calls++;
    await assert.rejects(resumed!.collaborate(caller(context), 'create_worker', {
      requestId: 'missing-directory', title: 'missing', providerId: 'test', cwd: missingCwd, prompt: 'must not run',
    }), /项目执行目录尚未就绪/);
    context.emit({ type: 'text', itemId: 'result', text: 'valid project still runs' });
  });
  try {
    missingCwd = join(f.cwd, 'removed-project'); await mkdir(missingCwd);
    const missingId = await f.engine.createSession({ title: 'historical', providerId: 'test', cwd: missingCwd });
    const session = f.store.state.sessions.find(item => item.id === missingId)!;
    missingCwd = session.cwd;
    session.messages.push({ id: 'saved-answer', role: 'assistant', text: 'preserved historical answer', createdAt: new Date().toISOString() });
    const validId = await f.engine.createSession({ title: 'valid', providerId: 'test', cwd: f.cwd });
    await f.engine.shutdown(); await rm(missingCwd, { recursive: true });

    const restored = new StateStore(f.store.path); await restored.load();
    resumed = new WorkbenchEngine(restored, f.engine.pluginPath, () => {});
    resumed.setProviders([f.adapter], [], []);
    await resumed.prepareExecutionKeys();
    const historical = resumed.snapshot().sessions.find(item => item.id === missingId)!;
    assert.equal(historical.cwd, missingCwd);
    assert.deepEqual(historical.messages, session.messages);
    assert.throws(() => resumed!.sendMessage(missingId, 'must not run'), /项目执行目录尚未就绪/);
    let mutated = false;
    await assert.rejects(resumed.withProjectMutation(missingCwd, async () => { mutated = true; }), /项目执行目录尚未就绪/);
    assert.equal(mutated, false);
    assert.equal(calls, 0);
    resumed.sendMessage(validId, 'check dispatch');
    await until(() => resumed!.snapshot().sessions.find(item => item.id === validId)!.status === 'completed');
    assert.equal(calls, 1);
    assert.equal(resumed.snapshot().sessions.length, 2);
    assert.deepEqual(resumed.snapshot().sessions.find(item => item.id === missingId)!.messages, session.messages);
  } finally { await resumed?.shutdown(); await f.cleanup(); }
});


test('read-only delegation preserves permission and the Git worktree reservation blocks a manual subdirectory writer', async () => {
  let engine!: WorkbenchEngine;
  let ready = false;
  let parentId = '';
  let workerId = '';
  let childCwd = '';
  const release = gate();
  let rounds = 0;
  const f = await fixture(async context => {
    if (context.session.parentSessionId) {
      assert.equal(context.session.settings?.permission, 'read-only');
      context.emit({ type: 'text', itemId: 'child', text: 'read-only result' }); return;
    }
    if (rounds++ > 0) { context.emit({ type: 'text', itemId: 'parent', text: 'done' }); return; }
    await assert.rejects(engine.collaborate(caller(context), 'create_worker', { requestId: 'unsupported', title: 'unsafe', providerId: 'unsupported', prompt: 'x', cwd: childCwd }), /未声明只读/);
    const result = await engine.collaborate(caller(context), 'create_worker', { requestId: 'readonly', title: 'safe', providerId: 'test', prompt: 'read', cwd: childCwd }) as { sessionId: string };
    workerId = result.sessionId; ready = true; await release.done;
  });
  engine = f.engine;
  const supported = f.adapter;
  engine.setProviders([supported, { info: { id: 'unsupported', name: 'Unsupported', source: 'plugin', available: true, detail: '', capabilities: { resume: true, approvals: false } }, async run() { assert.fail('unsupported runtime must not run'); } }], [], []);
  try {
    execFileSync('git', ['init', '-q', f.cwd]); childCwd = join(f.cwd, 'nested'); await mkdir(childCwd);
    parentId = await engine.createSession({ title: 'parent', providerId: 'test', cwd: f.cwd });
    const manual = await engine.createSession({ title: 'manual', providerId: 'test', cwd: childCwd });
    engine.updateSession(parentId, { settings: { permission: 'read-only' } }); engine.sendMessage(parentId, 'delegate');
    await until(() => ready);
    assert.throws(() => engine.sendMessage(manual, 'write'), /已有会话或编排运行/);
    assert.equal(engine.snapshot().sessions.length, 3);
    assert.equal(engine.snapshot().sessions.find(session => session.id === workerId)!.status, 'queued');
    release.open(); await until(() => engine.snapshot().sessions.find(session => session.id === parentId)!.status === 'completed');
    assert.equal(rounds, 2);
  } finally { release.open(); await f.cleanup(); }
});

test('Git mutation holds the same project reservation across awaits and rejects runtime, worker and overlap admission', async () => {
  let engine!: WorkbenchEngine;
  let project = '';
  const mutationGate = gate();
  const runtimeGate = gate();
  let mutationStarted = false;
  let delegated = false;
  const otherCwd = await mkdtemp(join(tmpdir(), 'workbench-external-coordinator-'));
  const f = await fixture(async context => {
    if (context.prompt === 'probe-delegation') {
      await assert.rejects(engine.collaborate(caller(context), 'create_worker', {
        requestId: 'during-git', providerId: 'test', title: 'must not be admitted', prompt: 'x', cwd: project,
      }), /已有会话或编排运行/);
      delegated = true;
    } else await runtimeGate.done;
  });
  engine = f.engine; project = f.cwd;
  const files = new WorkspaceFiles();
  let shutdown: Promise<void> | undefined;
  try {
    execFileSync('git', ['init', '-q', project]);
    await writeFile(join(project, 'note.txt'), 'actual fixture file\n');
    const nested = join(project, 'nested'); await mkdir(nested);
    const manual = await engine.createSession({ title: 'manual', providerId: 'test', cwd: nested });
    const coordinator = await engine.createSession({ title: 'coordinator', providerId: 'test', cwd: otherCwd });
    const mutation = engine.withProjectMutation(project, async () => {
      mutationStarted = true; await mutationGate.done;
      return files.mutate(project, { action: 'stage', path: 'note.txt' });
    });
    await until(() => mutationStarted);
    assert.throws(() => engine.sendMessage(manual, 'hold'), /项目正在修改或回收/);
    engine.sendMessage(coordinator, 'probe-delegation');
    await until(() => delegated);
    assert.equal(engine.snapshot().sessions.length, 2, 'a rejected worker must not create a session');
    mutationGate.open();
    assert((await mutation).changes.some(change => change.path === 'note.txt' && change.staged));
    engine.sendMessage(manual, 'hold');
    await until(() => engine.snapshot().sessions.find(session => session.id === manual)!.status === 'running');
    let ran = false;
    await assert.rejects(engine.withProjectMutation(project, async () => { ran = true; }), /已有会话或编排运行/);
    assert.equal(ran, false);
    runtimeGate.open();
    await until(() => engine.snapshot().sessions.find(session => session.id === manual)!.status === 'completed');
    await assert.rejects(engine.withProjectMutation(project, async () => { throw new Error('write failed'); }), /write failed/);
    assert.equal(await engine.withProjectMutation(project, async () => 'released'), 'released');
    const nestedNoGit = await mkdtemp(join(tmpdir(), 'workbench-overlap-'));
    try {
      const leaf = join(nestedNoGit, 'leaf'); await mkdir(leaf);
      const leafSession = await engine.createSession({ title: 'leaf', providerId: 'test', cwd: leaf });
      await engine.withProjectMutation(nestedNoGit, async () => {
        assert.throws(() => engine.sendMessage(leafSession, 'hold'), /项目正在修改或回收/);
      });
    } finally { await rm(nestedNoGit, { recursive: true, force: true }); }
    const finishGate = gate(); let pendingStarted = false; let shutdownFinished = false;
    const pending = engine.withProjectMutation(project, async () => { pendingStarted = true; await finishGate.done; });
    await until(() => pendingStarted);
    shutdown = engine.shutdown().then(() => { shutdownFinished = true; });
    await tick(); assert.equal(shutdownFinished, false);
    finishGate.open(); await pending; await shutdown; assert.equal(shutdownFinished, true);
  } finally {
    mutationGate.open(); runtimeGate.open();
    if (shutdown) await shutdown;
    await f.cleanup(); await rm(otherCwd, { recursive: true, force: true });
  }
});
