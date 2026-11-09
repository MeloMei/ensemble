import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkbenchEngine } from './engine';
import { StateStore } from './store';
import { DiagnosticJournal, withProviderDiagnostics } from './diagnostics';
import type { ProviderAdapter, TurnContext } from './providers/types';
import { PROMPT_TEXT_LIMIT, type CreateSessionInput, type SideQuestionInput } from '../shared/types';
import { commandHash } from './session-commands';

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('state did not settle');
}

function adapter(run: (context: TurnContext) => Promise<void>, id = 'test'): ProviderAdapter {
  return { info: { id, name: 'Test', source: 'builtin', available: true, detail: '',
    capabilities: { resume: true, approvals: true, effort: true, permissions: true },
    defaultModelId: 'm1', models: [{ id: 'm1', name: 'm1', free: true, efforts: ['low'] }, { id: 'm2', name: 'm2', free: true }] }, run };
}

test('first-task creation atomically saves a draft without starting a provider and replays after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-first-task-'));
  const store = new StateStore(join(directory, 'state.json'));
  const engine = new WorkbenchEngine(store, '', () => {});
  let calls = 0;
  engine.setProviders([adapter(async () => { calls++; })], [], []);
  let reopened: WorkbenchEngine | undefined;
  const input = { title: 'first', providerId: 'test', cwd: directory, commandId: 'first-task', initialDraft: '  Keep my draft\n' };
  try {
    const atomic = store.atomic.bind(store);
    store.atomic = operation => atomic((state, transaction) => operation(state, {
      ...transaction, putReceipt: () => { throw new Error('draft transaction failed'); },
    }));
    await assert.rejects(engine.createSession(input), /draft transaction failed/);
    assert.equal(store.state.sessions.length, 0); assert.equal(store.state.workspaces.length, 0);
    assert.equal(engine.commandReceipt(input.commandId), undefined); assert.equal(calls, 0);
    store.atomic = atomic;
    const [id, replay] = await Promise.all([engine.createSession(input), engine.createSession(input)]);
    assert.equal(replay, id); assert.equal(store.state.sessions.length, 1);
    assert.equal(store.state.workspaces.length, 1); assert.equal(store.state.workspaces[0].tabs.length, 1);
    assert.deepEqual(engine.getSession(id).draft, { text: input.initialDraft });
    assert.equal(engine.getSession(id).status, 'idle'); assert.equal(calls, 0);
    await assert.rejects(engine.createSession({ ...input, initialDraft: 'different' }), /commandId/);
    await engine.shutdown();
    const restored = new StateStore(store.path); await restored.load();
    reopened = new WorkbenchEngine(restored, '', () => {});
    assert.equal(await reopened.createSession(input), id);
    assert.deepEqual(reopened.getSession(id).draft, { text: input.initialDraft });
    assert.equal(restored.state.workspaces[0].tabs.length, 1); assert.equal(calls, 0);
  } finally { await reopened?.shutdown(); await engine.shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('first-task draft rejects invalid text and models while legacy create-session fingerprints stay unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-first-task-validation-'));
  const store = new StateStore(join(directory, 'state.json'));
  const engine = new WorkbenchEngine(store, '', () => {});
  engine.setProviders([adapter(async () => { assert.fail('Creating a session must not run a provider'); })], [], []);
  const input = { title: 'legacy', providerId: 'test', cwd: directory };
  try {
    await assert.rejects(engine.createSession({ ...input, initialDraft: 'x'.repeat(PROMPT_TEXT_LIMIT + 1) }));
    await assert.rejects(engine.createSession({ ...input, initialDraft: { text: 'draft', attachments: [] } } as unknown as CreateSessionInput));
    await assert.rejects(engine.createSession({ ...input, modelId: 'invalid', initialDraft: 'Keep this' }), /模型/);
    assert.equal(store.state.sessions.length, 0); assert.equal(store.state.workspaces.length, 0);
    const id = await engine.createSession({ ...input, commandId: 'legacy-create' });
    assert.equal(engine.getSession(id).draft, undefined);
    assert.equal(store.receipt('command:legacy-create')?.hash, commandHash('create-session', input));
    assert.equal(await engine.createSession({ ...input, commandId: 'legacy-create' }), id);
  } finally { await engine.shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('side questions atomically queue one bounded reference without interrupting the source or replacing its split', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-side-question-'));
  const store = new StateStore(join(directory, 'state.json'));
  const engine = new WorkbenchEngine(store, '', () => {});
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: { prompt: string; model?: string; permission?: string; effort?: string }[] = [];
  engine.setProviders([adapter(async context => {
    seen.push({ prompt: context.prompt, model: context.session.modelId, permission: context.session.settings?.permission, effort: context.session.settings?.effort });
    if (context.prompt !== 'Source turn') return;
    context.emit({ type: 'text', itemId: 'answer', text: 'Only this sentence. The rest of the response stays in the source.' });
    context.emit({ type: 'structured', event: { id: 'trace', kind: 'tool', title: 'Inspect the source', status: 'completed',
      input: 'Private trace input', output: 'Private trace output' } });
    await gate;
  })], [], []);
  try {
    const sourceId = await engine.createSession({ title: 'Source', cwd: directory, providerId: 'test' });
    engine.updateSession(sourceId, { settings: { permission: 'read-only', effort: 'low' } });
    engine.sendPrompt(sourceId, { text: 'Source turn' }, 'source-turn');
    await until(() => engine.getSession(sourceId).messages.some(message => Boolean(message.event)));
    const source = engine.getSession(sourceId);
    const answer = source.messages.find(message => message.role === 'assistant')!;
    const trace = source.messages.find(message => message.event)!;
    const workspace = store.state.workspaces[0];
    const activeTab = workspace.activeTabId;
    const selected: SideQuestionInput = { question: 'What does that mean?', reference: { kind: 'answer', messageId: answer.id, excerpt: 'Only this sentence.' } };
    await assert.rejects(engine.askSideQuestion(sourceId, { ...selected, reference: { kind: 'trace', messageId: answer.id } }, 'wrong-reference'), /引用/);
    assert.equal(store.state.sessions.length, 1);
    const atomic = store.atomic.bind(store);
    store.atomic = operation => atomic((state, transaction) => operation(state, {
      ...transaction, putReceipt: () => { throw new Error('side-question receipt write failed'); },
    }));
    try { await assert.rejects(engine.askSideQuestion(sourceId, selected, 'side-answer'), /receipt write failed/); }
    finally { store.atomic = atomic; }
    assert.equal(store.state.sessions.length, 1);
    assert.equal(workspace.secondaryTabId, undefined);
    const [first, replay] = await Promise.all([
      engine.askSideQuestion(sourceId, selected, 'side-answer'),
      engine.askSideQuestion(sourceId, selected, 'side-answer'),
    ]);
    assert.deepEqual(replay, first);
    assert(first.inSplit && first.waitingForProject);
    const split = workspace.secondaryTabId;
    assert.equal(workspace.tabs.find(tab => tab.id === split && tab.kind === 'agent')?.kind, 'agent');
    const second = await engine.askSideQuestion(sourceId, { question: 'Why use that tool?', reference: { kind: 'trace', messageId: trace.id } }, 'side-trace');
    assert(!second.inSplit && second.waitingForProject);
    assert.equal(workspace.secondaryTabId, split);
    assert.equal(workspace.activeTabId, activeTab);
    assert.equal(engine.getSession(sourceId).status, 'running');
    assert.equal(engine.getSession(first.sessionId).queue?.length, 1);
    assert.equal(engine.getSession(second.sessionId).queue?.length, 1);
    assert.equal(engine.getSession(first.sessionId).waitingForProject, true);
    assert.equal(seen.length, 1);
    release();
    await until(() => seen.length === 3);
    await engine.waitSession(first.sessionId);
    await engine.waitSession(second.sessionId);
    assert.deepEqual(seen.slice(1), [
      { prompt: 'What does that mean?\n\nReference from the source session (quoted for context only):\n> Only this sentence.', model: 'm1', permission: 'read-only', effort: 'low' },
      { prompt: 'Why use that tool?\n\nReference from the source session (quoted for context only):\n> Inspect the source', model: 'm1', permission: 'read-only', effort: 'low' },
    ]);
    assert.equal(engine.getSession(first.sessionId).attempts?.length, 1);
    assert.equal(engine.getSession(second.sessionId).attempts?.length, 1);
    assert.equal(engine.getSession(first.sessionId).waitingForProject, undefined);
  } finally { release(); await engine.shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('ordinary command receipts survive response loss, restart and identical text sent twice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-command-'));
  const store = new StateStore(join(directory, 'state.json'));
  const engine = new WorkbenchEngine(store, '', () => {});
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: string[] = [];
  engine.setProviders([adapter(async context => {
    assert(engine.commandReceipt(seen.length ? 'send-2' : 'send-1'));
    seen.push(context.prompt);
    if (seen.length === 1) await gate;
  })], [], []);
  let reopened: WorkbenchEngine | undefined;
  try {
    const input = { title: 'stable', providerId: 'test', cwd: directory, commandId: 'create-1' };
    const id = await engine.createSession(input);
    assert.equal(await engine.createSession(input), id);
    await assert.rejects(engine.createSession({ ...input, title: 'different' }), /commandId/);
    engine.saveSessionDraft(id, { text: '  same text \n' });
    engine.sendPrompt(id, { text: 'same text' }, 'send-1');
    assert.equal(engine.getSession(id).draft, undefined);
    engine.sendPrompt(id, { text: 'same text' }, 'send-1');
    assert.throws(() => engine.sendPrompt(id, { text: 'different' }, 'send-1'), /commandId/);
    await until(() => seen.length === 1);
    engine.sendPrompt(id, { text: 'same text' }, 'send-2');
    assert.equal(engine.getSession(id).queue?.length, 1);
    release(); await engine.waitSession(id);
    assert.deepEqual(seen, ['same text', 'same text']);
    assert.equal(engine.getSession(id).attempts?.length, 2);
    assert.equal(engine.getSession(id).messages.filter(message => message.role === 'user').length, 2);
    const receipt = engine.commandReceipt('send-1');
    await engine.shutdown();
    const restored = new StateStore(store.path); await restored.load();
    reopened = new WorkbenchEngine(restored, '', () => {});
    assert.equal(reopened.getSession(id).draft, undefined);
    assert.equal(await reopened.createSession(input), id);
    reopened.sendPrompt(id, { text: 'same text' }, 'send-1');
    assert.deepEqual(reopened.commandReceipt('send-1'), receipt);
    assert.equal(reopened.getSession(id).attempts?.length, 2);
  } finally { release(); await reopened?.shutdown(); await engine.shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('a failed durable command write starts no provider and leaves the command retryable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-command-write-'));
  const store = new StateStore(join(directory, 'state.json'));
  const engine = new WorkbenchEngine(store, '', () => {});
  let calls = 0; engine.setProviders([adapter(async () => { calls++; })], [], []);
  try {
    const id = await engine.createSession({ title: 'write', providerId: 'test', cwd: directory });
    const atomic = store.atomic.bind(store);
    store.atomic = () => { throw new Error('disk unavailable'); };
    assert.throws(() => engine.sendPrompt(id, { text: 'only once' }, 'write-1'), /disk unavailable/);
    assert.equal(calls, 0); assert.equal(engine.commandReceipt('write-1'), undefined);
    store.atomic = atomic;
    engine.sendPrompt(id, { text: 'only once' }, 'write-1'); await engine.waitSession(id);
    assert.equal(calls, 1); assert.equal(engine.getSession(id).attempts?.length, 1);
  } finally { await engine.shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('stopped queues persist edits, removals and captured execution settings until explicit resume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-followup-'));
  const store = new StateStore(join(directory, 'state.json'));
  const engine = new WorkbenchEngine(store, '', () => {});
  const seen: { prompt: string; modelId?: string; permission?: string }[] = [];
  const runtime = adapter(async context => {
    seen.push({ prompt: context.prompt, modelId: context.session.modelId, permission: context.session.settings?.permission });
    if (context.prompt === 'A') await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  engine.setProviders([runtime], [], []);
  let restarted: WorkbenchEngine | undefined;
  try {
    const id = await engine.createSession({ title: 'queue', providerId: 'test', cwd: directory });
    engine.updateSession(id, { settings: { permission: 'read-only', effort: 'low' } });
    engine.sendPrompt(id, { text: 'A' }, 'A'); await until(() => seen.length === 1);
    engine.sendPrompt(id, { text: 'B' }, 'B'); engine.sendPrompt(id, { text: 'C' }, 'C'); engine.sendPrompt(id, { text: 'D' }, 'D');
    const [b, c] = engine.getSession(id).queue!;
    engine.updateQueuedPrompt(id, b.id, { text: 'B edited' }); engine.removeQueuedPrompt(id, c.id);
    engine.cancelSession(id, 'stop'); await engine.waitSession(id);
    assert.equal(engine.getSession(id).queuePaused, true); assert.equal(seen.length, 1);
    engine.updateSession(id, { modelId: 'm2', settings: { permission: 'review' } });
    await engine.shutdown();
    const restored = new StateStore(store.path); await restored.load();
    restarted = new WorkbenchEngine(restored, '', () => {}); restarted.setProviders([runtime], [], []); await restarted.prepareExecutionKeys();
    assert.equal(restarted.getSession(id).queuePaused, true); assert.equal(seen.length, 1);
    restarted.setSessionQueuePaused(id, false); await restarted.waitSession(id);
    assert.deepEqual(seen, [
      { prompt: 'A', modelId: 'm1', permission: 'read-only' }, { prompt: 'B edited', modelId: 'm1', permission: 'read-only' },
      { prompt: 'D', modelId: 'm1', permission: 'read-only' },
    ]);
    assert.equal(restarted.getSession(id).queue?.length, 0);
    assert.deepEqual(restarted.getSession(id).attempts?.slice(1).map(attempt => ({ modelId: attempt.modelId, permission: attempt.settings?.permission, commandId: attempt.commandId })),
      [{ modelId: 'm1', permission: 'read-only', commandId: 'B' }, { modelId: 'm1', permission: 'read-only', commandId: 'D' }]);
  } finally { await restarted?.shutdown(); await engine.shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('approval and cancellation replays never resolve or cancel a later live request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-live-command-'));
  const store = new StateStore(join(directory, 'state.json'));
  const engine = new WorkbenchEngine(store, '', () => {});
  engine.setProviders([adapter(async context => {
    await context.approve({ title: 'first', detail: '', choices: [{ id: 'allow', label: 'Allow' }] });
    await context.approve({ title: 'question', detail: '', choices: [], questions: [{ id: 'q', header: 'q', question: 'q?', options: [{ label: 'yes' }], multiSelect: false }] });
    await context.approve({ title: 'last', detail: '', choices: [{ id: 'allow', label: 'Allow' }] });
  })], [], []);
  let restarted: WorkbenchEngine | undefined;
  try {
    const id = await engine.createSession({ title: 'live', providerId: 'test', cwd: directory });
    engine.sendPrompt(id, { text: 'ask' }, 'ask-1'); await until(() => engine.getSession(id).approvals[0]?.title === 'first');
    const firstAttemptId = engine.getSession(id).attempts!.at(-1)!.id;
    const first = engine.getSession(id).approvals[0].id;
    engine.decideApproval(first, 'allow', 'decision-1'); await until(() => engine.getSession(id).approvals[0]?.title === 'question');
    engine.decideApproval(first, 'allow', 'decision-1');
    assert.throws(() => engine.decideApproval(first, 'deny', 'decision-1'), /commandId/);
    const question = engine.getSession(id).approvals[0].id;
    engine.answerQuestions(question, { q: ['yes'] }, 'answer-1'); await until(() => engine.getSession(id).approvals[0]?.title === 'last');
    engine.answerQuestions(question, { q: ['yes'] }, 'answer-1');
    engine.cancelSession(id, 'cancel-1', firstAttemptId); await engine.waitSession(id);
    engine.sendPrompt(id, { text: 'ask again' }, 'ask-2'); await until(() => engine.getSession(id).approvals[0]?.title === 'first');
    engine.sendPrompt(id, { text: 'queued after the later attempt' }, 'ask-3');
    engine.setSessionQueuePaused(id, false);
    assert.throws(() => engine.cancelSession(id, 'late-stop-without-receipt', firstAttemptId), /回合已结束/);
    assert.equal(engine.commandReceipt('late-stop-without-receipt'), undefined);
    assert.equal(engine.getSession(id).queuePaused, false);
    assert.equal(engine.getSession(id).queue?.length, 1);
    assert.equal(engine.getSession(id).status, 'waiting_approval');
    engine.cancelSession(id, 'cancel-1', firstAttemptId); assert.equal(engine.getSession(id).status, 'waiting_approval');
    engine.cancelSession(id, 'cancel-2'); await engine.waitSession(id); await engine.shutdown();
    const restored = new StateStore(store.path); await restored.load(); restarted = new WorkbenchEngine(restored, '', () => {});
    restarted.decideApproval(first, 'allow', 'decision-1'); restarted.answerQuestions(question, { q: ['yes'] }, 'answer-1');
    assert.throws(() => restarted!.decideApproval(first, 'allow', 'new-process-decision'), /已结束/);
    assert.equal(restarted.getSession(id).approvals.length, 0);
  } finally { await restarted?.shutdown(); await engine.shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('delivery tracking follows adapter declarations through diagnostics and blocks an unconfirmed resend', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-declared-delivery-'));
  const store = new StateStore(join(directory, 'state.json'));
  const engine = new WorkbenchEngine(store, '', () => {});
  const journal = new DiagnosticJournal(join(directory, 'diagnostics.ndjson'));
  let calls = 0;
  const runtime = adapter(async context => {
    calls++;
    assert.equal(context.session.messages.at(-1)?.delivery?.status, 'pending');
    if (context.prompt === 'accepted') {
      context.emit({ type: 'delivery', status: 'accepted', nativeThreadId: 'native-thread', nativeTurnId: 'native-turn' });
      return;
    }
    if (context.prompt === 'rejected') context.emit({ type: 'delivery', status: 'rejected', reason: 'Native input was refused' });
    throw new Error('Native response unavailable');
  }, 'delivery-fixture');
  runtime.tracksDelivery = true;
  const wrapped = withProviderDiagnostics(runtime, journal);
  engine.setProviders([wrapped], [], []);
  try {
    assert.equal(wrapped.tracksDelivery, true);
    for (const status of ['accepted', 'rejected', 'unknown']) {
      const id = await engine.createSession({ title: status, providerId: runtime.info.id, cwd: directory });
      await engine.executeSession(id, { text: status }).done;
      const session = engine.getSession(id);
      const message = session.messages[0];
      assert.equal(message.delivery?.status, status);
      assert.equal(message.delivery?.clientUserMessageId, message.id);
      if (status === 'accepted') {
        assert.equal(session.status, 'completed');
        assert.equal(message.nativeTurnId, 'native-turn');
        assert.equal(message.delivery?.nativeThreadId, 'native-thread');
      } else assert.equal(session.status, 'failed');
      if (status === 'unknown') {
        assert.throws(() => engine.sendPrompt(id, { text: 'do not repeat' }), /核对/);
        assert.throws(() => engine.executeSession(id, { text: 'do not repeat' }), /核对/);
        await assert.rejects(engine.reconcileSessionDelivery(id), /保持未知/);
        assert.equal(engine.getSession(id).messages[0].delivery?.status, 'unknown');
        const fork = engine.getSession(await engine.forkSession(id));
        assert.equal(fork.status, 'idle');
        assert.equal(fork.externalId, undefined);
        assert(fork.draft?.text);
      }
    }
    assert.equal(calls, 3);
  } finally { await engine.shutdown(); await journal.flush(); await rm(directory, { recursive: true, force: true }); }
});

test('restart changes pending delivery to unknown and history reconciliation never resends it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-delivery-recovery-'));
  const store = new StateStore(join(directory, 'state.json'));
  const timestamp = new Date().toISOString();
  let calls = 0;
  try {
    store.atomic(state => state.sessions.push({ id: 'session', title: 'recover', providerId: 'codex', cwd: directory, externalId: 'native-thread',
      status: 'running', messages: [{ id: 'user', role: 'user', text: 'same text', createdAt: timestamp,
        delivery: { id: 'delivery', clientUserMessageId: 'user', status: 'pending', createdAt: timestamp, updatedAt: timestamp } }],
      attempts: [{ id: 'attempt', status: 'running', prompt: 'same text', userMessageId: 'user', startedAt: timestamp }],
      queue: [{ id: 'queued', commandId: 'next', input: { text: 'next' }, createdAt: timestamp, updatedAt: timestamp }],
      approvals: [{ id: 'old-process', sessionId: 'session', title: 'old', detail: '', choices: [{ id: 'allow', label: 'Allow' }] }], createdAt: timestamp, updatedAt: timestamp }));
    await store.close();
    const restored = new StateStore(store.path); await restored.load();
    const engine = new WorkbenchEngine(restored, '', () => {});
    const runtime = adapter(async () => { calls++; }, 'codex');
    runtime.tracksDelivery = true;
    runtime.reconcileDelivery = async (_session, deliveries) => deliveries.map(delivery => ({ clientUserMessageId: delivery.clientUserMessageId,
      status: 'accepted', nativeThreadId: 'native-thread', nativeTurnId: 'native-turn', nativeItemId: 'native-user' }));
    engine.setProviders([runtime], [], []);
    try {
      await engine.prepareExecutionKeys();
      assert.equal(engine.getSession('session').messages[0].delivery?.status, 'unknown');
      assert.equal(engine.getSession('session').queuePaused, true);
      assert.equal(engine.getSession('session').approvals.length, 0);
      assert.throws(() => engine.setSessionQueuePaused('session', false), /核对/);
      assert.throws(() => engine.executeSession('session', { text: 'managed dispatch must also wait' }), /核对/);
      assert.equal(engine.getSession('session').attempts?.length, 1); assert.equal(calls, 0);
      await engine.reconcileSessionDelivery('session');
      assert.equal(engine.getSession('session').messages[0].delivery?.status, 'accepted');
      assert.equal(engine.getSession('session').messages[0].nativeTurnId, 'native-turn');
      assert.equal(engine.getSession('session').queuePaused, true); assert.equal(calls, 0);
    } finally { await engine.shutdown(); }
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('each concurrent approval advances attention after an earlier approval was read', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-concurrent-approvals-'));
  const store = new StateStore(join(directory, 'state.json'));
  const engine = new WorkbenchEngine(store, '', () => {});
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  engine.setProviders([adapter(async context => {
    const first = context.approve({ title: 'first', detail: '', choices: [{ id: 'allow', label: 'Allow' }] });
    await gate;
    const second = context.approve({ title: 'second', detail: '', choices: [{ id: 'allow', label: 'Allow' }] });
    await Promise.all([first, second]);
  })], [], []);
  try {
    const id = await engine.createSession({ title: 'parallel approvals', providerId: 'test', cwd: directory });
    engine.sendPrompt(id, { text: 'ask in parallel' });
    await until(() => engine.getSession(id).approvals.length === 1);
    const revision = engine.getSession(id).attention!.revision;
    store.atomic(() => { store.state.sessions.find(session => session.id === id)!.attention!.seenRevision = revision; });
    release(); await until(() => engine.getSession(id).approvals.length === 2);
    const attention = engine.getSession(id).attention!;
    assert.equal(attention.revision, revision + 1);
    assert.equal(attention.seenRevision, revision);
    for (const approval of engine.getSession(id).approvals) engine.decideApproval(approval.id, 'allow');
    await engine.waitSession(id);
    assert.equal(engine.getSession(id).status, 'completed');
  } finally { release(); await engine.shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('cancelling an unsent Codex task rejects its pending delivery before restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-unsent-stop-'));
  const store = new StateStore(join(directory, 'state.json'));
  const engine = new WorkbenchEngine(store, '', () => {});
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = adapter(async context => {
    calls++;
    context.emit({ type: 'delivery', status: 'accepted', nativeTurnId: 'first-turn' });
    await gate;
  }, 'codex');
  runtime.tracksDelivery = true;
  engine.setProviders([runtime], [], []);
  try {
    const first = await engine.createSession({ title: 'active owner', providerId: 'codex', cwd: directory });
    const second = await engine.createSession({ title: 'unsent owned task', providerId: 'codex', cwd: directory });
    engine.executeSession(first, { text: 'run' }, { owner: 'shared-owner' }); await until(() => calls === 1);
    const queued = engine.executeSession(second, { text: 'not submitted' }, { owner: 'shared-owner' });
    assert.equal(engine.getSession(second).status, 'queued');
    const crashPath = join(await mkdtemp(join(directory, 'crash-')), 'state.json');
    await writeFile(crashPath, JSON.stringify(store.state));
    const crashRecovery = new StateStore(crashPath); await crashRecovery.load();
    try { assert.equal(crashRecovery.state.sessions.find(session => session.id === second)!.messages[0].delivery?.status, 'rejected'); }
    finally { await crashRecovery.close(); }
    engine.cancelSession(second); await queued.done;
    assert.equal(calls, 1);
    assert.equal(engine.getSession(second).messages[0].delivery?.status, 'rejected');
    release(); await engine.waitSession(first); await engine.shutdown();
    const restored = new StateStore(store.path); await restored.load();
    try { assert.equal(restored.state.sessions.find(session => session.id === second)!.messages[0].delivery?.status, 'rejected'); }
    finally { await restored.close(); }
  } finally { release(); await engine.shutdown(); await rm(directory, { recursive: true, force: true }); }
});
