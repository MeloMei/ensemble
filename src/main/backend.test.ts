import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { startBackend } from './backend-server';
import { BackendClient, BackendCommandError, connectBackend } from './backend-client';
import { createWorkbenchService } from './workbench-service';
import type { PromptAttachment, Snapshot } from '../shared/types';
import type { CollaborationArtifactVersion } from '../shared/collaboration';
import type { LoadedPromptAttachment, ProviderAdapter } from './providers/types';

test('backend restarts on a free port after stale or invalid discovery without displacing an owner', async () => {
  const dataPath = await mkdtemp(join(tmpdir(), 'workbench-port-recovery-'));
  const options = { dataPath, command: process.execPath, bridgePath: join(dataPath, 'bridge.cjs'), providers: [] };
  const holder = createServer();
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  try {
    backend = await startBackend(options);
    const oldPort = Number(new URL(backend.endpoint.url).port);
    await backend.close(); backend = undefined;
    await new Promise<void>((resolve, reject) => { holder.once('error', reject); holder.listen(oldPort, '127.0.0.1', resolve); });
    backend = await startBackend(options);
    assert.notEqual(Number(new URL(backend.endpoint.url).port), oldPort);
    const client = await connectBackend(dataPath);
    assert.equal(client.endpoint.instanceId, backend.endpoint.instanceId);
    const source = await readFile(join(dataPath, 'backend.json'), 'utf8');
    await assert.rejects(startBackend(options), /已有后台持有/);
    assert.equal(await readFile(join(dataPath, 'backend.json'), 'utf8'), source);
    await backend.close(); backend = undefined;
    await writeFile(join(dataPath, 'backend.json'), '{broken');
    backend = await startBackend(options);
    assert.equal((await connectBackend(dataPath)).endpoint.instanceId, backend.endpoint.instanceId);
    await backend.close(); backend = undefined;
    await writeFile(join(dataPath, 'backend.json'), JSON.stringify({ version: 1, url: 'http://127.0.0.1:999999' }));
    backend = await startBackend(options);
    assert.ok(Number(new URL(backend.endpoint.url).port) <= 65535);
  } finally {
    await backend?.close();
    if (holder.listening) await new Promise<void>((resolve, reject) => holder.close(error => error ? reject(error) : resolve()));
    await rm(dataPath, { recursive: true, force: true });
  }
});

test('file reads distinguish missing content from other filesystem and path errors', async () => {
  const dataPath = await realpath(await mkdtemp(join(tmpdir(), 'workbench-file-missing-')));
  const service = await createWorkbenchService({ dataPath, command: process.execPath, bridgePath: join(dataPath, 'bridge.cjs'), publish() {}, providers: [] });
  try {
    const workspace = await service.engine.createWorkspace({ name: 'files', cwd: dataPath });
    await writeFile(join(dataPath, 'notes.txt'), 'keep this draft');
    assert.equal((await service.call('workbench:read-file', [workspace, 'notes.txt']) as { content: string }).content, 'keep this draft');
    await assert.rejects(service.call('workbench:read-file', [workspace, 'notes.txt/child']), { code: 'ENOTDIR' });
    await assert.rejects(service.call('workbench:read-file', [workspace, '../outside.txt']), /outside the workspace/);
    await rm(join(dataPath, 'notes.txt'));
    assert.equal(await service.call('workbench:read-file', [workspace, 'notes.txt']), null);
  } finally { await service.shutdown(); await rm(dataPath, { recursive: true, force: true }); }
});

test('continuation saves a text draft in a new runtime and keeps the source and same-runtime fork intact', async () => {
  const dataPath = await realpath(await mkdtemp(join(tmpdir(), 'workbench-continuation-')));
  const published: Snapshot[] = [];
  let executions = 0;
  const runtime = (id: string, available: boolean, models: string[]): ProviderAdapter => ({
    info: { id, name: id, source: 'builtin', available, detail: '', capabilities: { resume: true, approvals: true },
      defaultModelId: models[0], models: models.map(model => ({ id: model, name: model, free: true })) },
    async run() { executions++; },
  });
  const options = { dataPath, command: process.execPath, bridgePath: join(dataPath, 'bridge.cjs'),
    publish(snapshot: Snapshot) { published.push(structuredClone(snapshot)); },
    providers: [runtime('source', true, ['source-default', 'source-selected']), runtime('target', true, ['target-default', 'target-selected']), runtime('unavailable', false, [])],
  };
  let service = await createWorkbenchService(options);
  try {
    const sourceId = await service.engine.createSession({ title: 'Review change', cwd: dataPath, providerId: 'source', modelId: 'source-selected' });
    const target = { providerId: 'target', modelId: 'target-selected' };
    const continueWith = (input: unknown = target) => service.call('workbench:continue-session', [sourceId, input]) as Promise<string>;
    await assert.rejects(continueWith(), /没有可接续的文本/);
    const attachment: PromptAttachment = { id: 'notes', name: 'notes.txt', kind: 'text', mimeType: 'text/plain', size: 5, sha256: 'b'.repeat(64), ownedPath: join(dataPath, 'notes.txt') };
    const createdAt = new Date().toISOString();
    service.store.atomic(state => {
      const source = state.sessions.find(session => session.id === sourceId)!;
      source.externalId = 'native-thread';
      source.status = 'running';
      source.settings = { permission: 'read-only', effort: 'low', skillIds: ['source-skill'] };
      source.messages = [
        { id: 'user', role: 'user', text: 'Inspect the change', createdAt, nativeTurnId: 'native-turn', attachments: [attachment] },
        { id: 'assistant', role: 'assistant', text: 'The review is ready', createdAt, attachments: [attachment] },
        { id: 'activity', role: 'activity', text: 'INTERNAL TOOL OUTPUT', createdAt },
      ];
      source.draft = { text: 'UNSENT SOURCE DRAFT' };
      source.queue = [{ id: 'next', commandId: 'next', input: { text: 'QUEUED SOURCE TASK' }, createdAt, updatedAt: createdAt }];
      source.queuePaused = true;
    });
    await assert.rejects(continueWith(), /当前任务结束/);
    service.store.atomic(state => { state.sessions.find(session => session.id === sourceId)!.status = 'completed'; });
    const source = service.engine.getSession(sourceId);
    await assert.rejects(continueWith({ providerId: 'unavailable' }), /目前不可用/);
    await assert.rejects(continueWith({ providerId: 'source' }), /另一个 Agent/);
    await assert.rejects(continueWith({ ...target, modelId: 'source-selected' }), /所选模型/);
    await assert.rejects(continueWith({ ...target, settings: source.settings }), /settings/);
    assert.equal(service.snapshot().sessions.length, 1);
    assert.equal(service.snapshot().workspaces[0].tabs.length, 1);

    published.length = 0;
    const forkId = await service.call('workbench:fork-session', [sourceId, 'user']) as string;
    assert.equal(published.length, 1);
    const fork = published[0].sessions.find(session => session.id === forkId)!;
    assert.equal(fork.modelId, 'source-selected');
    assert.deepEqual(fork.settings, source.settings);
    assert.deepEqual(fork.draft?.attachments, [attachment]);
    assert.doesNotMatch(fork.draft!.text, /review is ready/);

    published.length = 0;
    const continuedId = await continueWith();
    assert.equal(published.length, 1);
    const continued = published[0].sessions.find(session => session.id === continuedId)!;
    assert.match(continued.title, /^target ↪ Review change$/);
    assert.equal(continued.providerId, 'target');
    assert.equal(continued.modelId, 'target-selected');
    assert.equal(continued.settings, undefined);
    assert.equal(continued.externalId, undefined);
    assert.equal(continued.status, 'idle');
    assert.deepEqual(continued.messages, []);
    assert.deepEqual(continued.attempts, []);
    assert.equal(continued.queue, undefined);
    assert.equal(continued.draft?.attachments, undefined);
    assert.match(continued.draft!.text, /Inspect the change[\s\S]*The review is ready/);
    assert.doesNotMatch(continued.draft!.text, /INTERNAL|UNSENT|QUEUED|native-/);
    const project = published[0].workspaces[0];
    assert.equal(continued.cwd, source.cwd);
    assert.deepEqual(project.tabs.map(tab => tab.kind === 'agent' && tab.sessionId), [sourceId, forkId, continuedId]);
    assert.equal(project.activeTabId, project.tabs[2].id);
    assert.deepEqual(service.engine.getSession(sourceId), source);

    await service.shutdown();
    service = await createWorkbenchService(options);
    assert.deepEqual(service.engine.getSession(continuedId).draft, continued.draft);
    assert.equal(service.engine.getSession(sourceId).externalId, 'native-thread');
    assert.equal(service.engine.getSession(sourceId).messages[0].nativeTurnId, 'native-turn');
    assert.equal(executions, 0);
  } finally { await service.shutdown(); await rm(dataPath, { recursive: true, force: true }); }
});

test('session drafts restore text and attachments, survive a rejected send and clear only on accepted input', async () => {
  const dataPath = await realpath(await mkdtemp(join(tmpdir(), 'workbench-drafts-')));
  let finish!: () => void;
  let delivered = '';
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const options = { dataPath, command: process.execPath, bridgePath: join(dataPath, 'bridge.cjs'), publish() {}, providers: [{
    info: { id: 'controlled', name: 'Controlled', source: 'plugin' as const, available: true, detail: '', capabilities: { resume: true, approvals: false } },
    async run(context: { prompt: string }) { delivered = context.prompt; await gate; },
  }] };
  let service = await createWorkbenchService(options);
  try {
    const file = join(dataPath, 'notes.txt'); await writeFile(file, 'attachment contents');
    const attachments = await service.attachments.importFiles([file]);
    const id = await service.call('workbench:create-session', [{ title: 'draft', providerId: 'controlled', cwd: dataPath }]) as string;
    const input = { text: '  unfinished task\n', attachments };
    const legacy = { ...input, attachments: [...attachments, ...await service.attachments.importFiles([file, file, file, file])] };
    await service.call('workbench:save-session-draft', [id, legacy]);
    assert.deepEqual(service.engine.getSession(id).draft, legacy);
    await assert.rejects(service.call('workbench:send-prompt', [id, legacy]), /每轮最多 4/);
    await assert.rejects(service.call('workbench:finish-queued-prompt-edit', [id, 'oversized', '00000000-0000-4000-8000-000000000001', legacy]), /每轮最多 4/);
    assert.deepEqual(service.engine.getSession(id).draft, legacy);
    await service.call('workbench:save-session-draft', [id, input]);
    await assert.rejects(service.call('workbench:save-session-draft', [id, { text: 'x'.repeat(200_001) }]));
    await service.shutdown();
    service = await createWorkbenchService(options);
    assert.deepEqual(service.engine.getSession(id).draft, input);
    assert.equal((await service.attachments.load(service.engine.getSession(id).draft?.attachments))[0].text, 'attachment contents');
    const release = service.engine.reserveProject(dataPath, 'other-session');
    try { await assert.rejects(service.call('workbench:send-prompt', [id, input]), /已有会话/); }
    finally { release(); }
    assert.deepEqual(service.engine.getSession(id).draft, input);
    const reference = { id: '00000000-0000-4000-8000-000000000006', label: 'Failure output', excerpt: 'Expected 200, received 503',
      source: { kind: 'message', sessionId: 'original-session', messageId: 'original-message' } };
    await service.call('workbench:add-session-evidence', [id, reference]);
    const withReference = { ...input, evidence: [reference] };
    assert.deepEqual(service.engine.getSession(id).draft, withReference);
    await service.call('workbench:send-prompt', [id, { ...withReference, text: input.text.trim() }]);
    assert.equal(service.engine.getSession(id).draft, undefined);
    await service.call('workbench:save-session-draft', [id, { text: 'next task' }]);
    finish(); await service.engine.waitSession(id);
    assert.match(delivered, /original-session, message original-message/);
    assert.match(delivered, /Expected 200, received 503/);
    const sent = service.engine.getSession(id).messages.find(item => item.role === 'user');
    assert.equal(sent?.originalPrompt, input.text.trim());
    assert.deepEqual(sent?.evidence, [reference]);
    assert.deepEqual(service.engine.getSession(id).draft, { text: 'next task' });
    await service.call('workbench:save-session-draft', [id, { text: '' }]);
    await service.shutdown();
    service = await createWorkbenchService(options);
    assert.equal(service.engine.getSession(id).draft, undefined);
  } finally { finish(); await service.shutdown(); await rm(dataPath, { recursive: true, force: true }); }
});

test('an edit holds the queue head after the live turn completes, then sends the saved version in order', async t => {
  const dataPath = await realpath(await mkdtemp(join(tmpdir(), 'workbench-queue-edit-')));
  let completeFirst!: () => void;
  const first = new Promise<void>(resolve => { completeFirst = resolve; });
  const prompts: string[] = [];
  const service = await createWorkbenchService({ dataPath, command: process.execPath, bridgePath: join(dataPath, 'bridge.cjs'), publish() {}, providers: [{
    info: { id: 'controlled', name: 'Controlled', source: 'plugin' as const, available: true, detail: '', capabilities: { resume: true, approvals: false } },
    async run(context) {
      prompts.push(context.prompt);
      if (context.prompt === 'First') await first;
    },
  }] });
  try {
    const id = await service.call('workbench:create-session', [{ title: 'queue', providerId: 'controlled', cwd: dataPath }]) as string;
    for (const text of ['First', 'Original', 'Later']) await service.call('workbench:send-prompt', [id, { text }]);
    const [head, next] = service.engine.getSession(id).queue!;
    const editId = '00000000-0000-4000-8000-000000000001';
    const ownerId = '00000000-0000-4000-8000-000000000002';
    const resumedEdit = '00000000-0000-4000-8000-000000000003';
    const otherOwner = '00000000-0000-4000-8000-000000000004';
    let time = Date.now();
    t.mock.method(Date, 'now', () => time);
    assert.deepEqual(await service.call('workbench:begin-queued-prompt-edit', [id, head.id, 0, editId, ownerId]), head.input);
    const resume = () => service.call('workbench:begin-queued-prompt-edit', [id, head.id, 1, resumedEdit, otherOwner]);
    await assert.rejects(resume(), /另一窗口正在编辑/);
    completeFirst();
    await service.engine.waitSession(id);
    assert.deepEqual(prompts, ['First']);
    assert.deepEqual(service.engine.getSession(id).queue?.map(item => item.id), [head.id, next.id]);
    assert.equal(service.engine.getSession(id).queuePaused, undefined);
    await service.call('workbench:save-queued-prompt-draft', [id, head.id, editId, 1, { text: 'Autosaved draft' }]);
    time += 30_000;
    await service.call('workbench:renew-queued-prompt-edit', [id, head.id, editId]);
    time += 20_000;
    await assert.rejects(resume(), /另一窗口正在编辑/);
    time += 30_000;
    assert.deepEqual(prompts, ['First']);
    assert.deepEqual(await resume(), { text: 'Autosaved draft' });
    await assert.rejects(service.call('workbench:finish-queued-prompt-edit', [id, head.id, editId]), /其他窗口/);
    await service.call('workbench:finish-queued-prompt-edit', [id, head.id, resumedEdit, { text: 'Final edit' }]);
    await service.engine.waitSession(id);
    assert.deepEqual(prompts, ['First', 'Final edit', 'Later']);
  } finally { completeFirst(); await service.shutdown(); await rm(dataPath, { recursive: true, force: true }); }
});

test('moving queued prompts persists dispatch order and respects stale, edited and Agent queue entries', async () => {
  const dataPath = await realpath(await mkdtemp(join(tmpdir(), 'workbench-queue-move-')));
  let targetId: string;
  const prompts: string[] = [];
  const options = { dataPath, command: process.execPath, bridgePath: join(dataPath, 'bridge.cjs'), publish() {}, providers: [{
    info: { id: 'controlled', name: 'Controlled', source: 'plugin' as const, available: true, detail: '', capabilities: { resume: true, approvals: false } },
    async run(context: import('./providers/types').TurnContext) {
      if (context.session.id === targetId) prompts.push(context.prompt);
      else await service.engine.sendSessionMessage({ sessionId: context.session.id, attemptId: context.session.attempts!.at(-1)!.id }, {
        toSessionId: targetId, requestId: 'agent-queue-request', text: 'Agent message',
      });
    },
  }] };
  let service = await createWorkbenchService(options);
  const queue = () => service.engine.getSession(targetId).queue!;
  const ids = () => queue().map(item => item.id);
  const send = (text: string) => service.call('workbench:send-prompt', [targetId, { text }]);
  const move = (from: string, to: string, order: string[], commandId?: string) =>
    service.call('workbench:move-queued-prompt', [targetId, from, to, order, commandId]);
  try {
    const sourceId = await service.engine.createSession({ title: 'Sender', providerId: 'controlled', cwd: dataPath });
    targetId = await service.engine.createSession({ title: 'Queue', providerId: 'controlled', cwd: dataPath });
    service.engine.updateSession(sourceId, { messageTarget: { sessionId: targetId, enabled: true } });
    await service.call('workbench:set-session-queue-paused', [targetId, true]);
    await send('A'); await send('B');
    service.engine.sendMessage(sourceId, 'Send Agent message');
    await service.engine.waitSession(sourceId);
    assert.equal(queue()[2]?.agentSource?.sessionId, sourceId);
    await send('C');
    const stale = ids();
    await send('D');
    const initial = ids();
    const [a, b, agent, c, d] = initial;
    assert.equal(await move(b, a, stale), 'queue-changed');
    assert.equal(await move(agent, b, initial), 'blocked');
    assert.equal(await move(a, c, initial), 'blocked');

    const editId = '00000000-0000-4000-8000-000000000001';
    const ownerId = '00000000-0000-4000-8000-000000000002';
    await service.call('workbench:begin-queued-prompt-edit', [targetId, b, 0, editId, ownerId]);
    assert.equal(await move(a, b, initial), 'blocked');
    assert.deepEqual(ids(), initial);
    await service.call('workbench:finish-queued-prompt-edit', [targetId, b, editId, { text: 'Edited B' }]);
    assert.equal(await move(b, a, initial, 'move-b'), 'moved');
    const reordered = [b, a, agent, c, d];
    assert.deepEqual(ids(), reordered);
    assert.equal(await move(c, d, initial), 'queue-changed');
    assert.equal(prompts.length, 0);

    await service.shutdown();
    service = await createWorkbenchService(options);
    assert.deepEqual(ids(), reordered);
    assert.equal(await move(b, a, initial, 'move-b'), 'moved');
    assert.deepEqual(ids(), reordered);
    await service.call('workbench:set-session-queue-paused', [targetId, false]);
    await service.engine.waitSession(targetId);
    assert.deepEqual(service.engine.getSession(targetId).attempts?.map(attempt => attempt.queueItemId), reordered);
    assert.deepEqual(queue(), []);
    assert.deepEqual(prompts, ['Edited B', 'A',
      `Message from Ensemble session "Sender" (session ID ${sourceId}). Reply in this chat so the sender can retrieve your response.\n\nAgent message`, 'C', 'D']);
  } finally { await service.shutdown(); await rm(dataPath, { recursive: true, force: true }); }
});

test('one backend owns execution and persists results after a client disconnects', async () => {
  const dataPath = await mkdtemp(join(tmpdir(), 'workbench-backend-'));
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let invocations = 0;
  const options = { dataPath, command: process.execPath, bridgePath: join(dataPath, 'bridge.cjs'), providers: [{
    info: { id: 'controlled', name: 'Controlled', source: 'plugin' as const, available: true, detail: '', capabilities: { resume: true, approvals: false } },
    async run(context: import('./providers/types').TurnContext) {
      invocations++;
      context.emit({ type: 'external-id', id: 'native-preserved' });
      await gate;
      context.emit({ type: 'text', itemId: 'result', text: 'persisted result' });
    },
  }] };
  let backend = await startBackend(options);
  const controller = new AbortController();
  try {
    const first = await connectBackend(dataPath);
    const second = new BackendClient(backend.endpoint);
    await assert.rejects(startBackend(options), /locked|占用|后台|锁/);
    const forbidden = await fetch(`${backend.endpoint.url}/commands`);
    assert.equal(forbidden.status, 403);
    let observed = false;
    const subscription = first.subscribe(() => { observed = true; }, controller.signal).catch(error => {
      if (!controller.signal.aborted) throw error;
    });
    const id = await first.call<string>('workbench:create-session', { title: 'background', providerId: 'controlled', cwd: dataPath });
    await first.call('workbench:send-message', id, 'execute');
    for (let i = 0; i < 100 && (!observed || invocations === 0); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(observed, true);
    assert.equal(invocations, 1);
    controller.abort(); await subscription;
    finish();
    let state: Snapshot = await second.call('workbench:snapshot');
    for (let i = 0; i < 100 && state.sessions[0]?.status !== 'completed'; i++) {
      await new Promise(resolve => setTimeout(resolve, 10)); state = await second.call('workbench:snapshot');
    }
    assert.equal(state.sessions[0].status, 'completed');
    assert.equal(state.sessions[0].externalId, 'native-preserved');
    assert.equal(invocations, 1);
    await backend.close();
    backend = await startBackend(options);
    const restored = await (await connectBackend(dataPath)).call<Snapshot>('workbench:snapshot');
    assert.equal(restored.sessions[0].id, id);
    assert.equal(restored.sessions[0].externalId, 'native-preserved');
    assert.equal(restored.sessions[0].messages.some(message => message.text === 'persisted result'), true);
    assert.equal(invocations, 1);
  } finally {
    controller.abort(); finish(); await backend.close(); await rm(dataPath, { recursive: true, force: true });
  }
});

test('failed initialization and failed provider shutdown both release the database owner', async () => {
  const dataPath = await mkdtemp(join(tmpdir(), 'workbench-owner-cleanup-'));
  const options = { dataPath, command: process.execPath, bridgePath: join(dataPath, 'bridge.cjs'), publish() {} };
  const info = { id: 'controlled', name: 'Controlled', source: 'plugin' as const, available: true, detail: '', capabilities: { resume: true, approvals: false } };
  try {
    const invalid = { get info(): typeof info { throw new Error('initialization failed'); }, async run() {} };
    await assert.rejects(createWorkbenchService({ ...options, providers: [invalid] }), /initialization failed/);
    const service = await createWorkbenchService({ ...options, providers: [{ info, async run() {}, async dispose() { throw new Error('dispose failed'); } }] });
    await assert.rejects(service.shutdown(), /后台退出未完成/);
    const successor = await createWorkbenchService({ ...options, providers: [] });
    await successor.shutdown();
  } finally { await rm(dataPath, { recursive: true, force: true }); }
});

test('file artifact versions pass the service attachment enricher, reject tampering and clean cancelled staging', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'workbench-artifact-input-')));
  const dataPath = join(directory, 'data'), cwd = join(directory, 'project'); await mkdir(cwd);
  const expected = '{"sum":110}\n'; const received: LoadedPromptAttachment[][] = [];
  const service = await createWorkbenchService({ dataPath, command: process.execPath, bridgePath: join(directory, 'bridge.cjs'), publish() {}, providers: [{
    info: { id: 'controlled', name: 'Controlled attachment recipient', source: 'plugin', available: true, detail: 'no model', capabilities: { resume: true, approvals: false } },
    async run(context) {
      assert.ok(context.attachments?.length === 1);
      assert.equal(context.attachments[0].text, expected);
      assert.equal(context.attachments[0].data.toString('utf8'), expected);
      received.push(context.attachments);
      context.emit({ type: 'external-id', id: 'controlled-file-recipient' });
      context.emit({ type: 'text', itemId: 'result', text: 'FILE_VERSION_RECEIVED' });
    },
  }] });
  const user = { kind: 'user' } as const;
  let release = () => {};
  const task = (id: string) => service.store.state.collaboration.tasks.find(item => item.id === id)!;
  const settled = async (id: string) => {
    for (let i = 0; i < 400; i++) { if (['completed', 'failed', 'cancelled'].includes(task(id).status)) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.fail('controlled file task did not settle');
  };
  try {
    const { runId } = await service.core.call(user, 'create_run', { requestId: 'file-input-run', name: 'file input', cwd, relationships: [], start: true,
      participants: [{ id: 'recipient', name: 'recipient', roles: ['用户指定的资料接收者'], mode: 'managed', providerId: 'controlled',
        permissions: { submitTasks: false, sendMessages: false, configureRun: false, publishArtifacts: false } }],
    }) as { runId: string };
    const source = join(cwd, 'sum.json'); await writeFile(source, expected);
    const artifact = await service.core.call(user, 'publish_artifact', { requestId: 'publish-file', runId, name: 'sum.json', path: source }) as CollaborationArtifactVersion;
    await writeFile(source, '{"sum":999}');
    const submit = (requestId: string) => service.core.call(user, 'submit_task', { requestId, runId, participantId: 'recipient', title: requestId, prompt: 'use this immutable file', artifactIds: [artifact.id] }) as Promise<{ taskId: string }>;
    const first = await submit('receive-original'); await settled(first.taskId);
    assert.equal(task(first.taskId).status, 'completed', task(first.taskId).error);
    assert.equal(received.length, 1); assert.notEqual(received[0][0].ownedPath, artifact.path);
    assert.ok(received[0][0].ownedPath.startsWith(join(dataPath, 'attachments') + '/'));
    assert.ok(artifact.path!.startsWith(join(dataPath, 'collaboration-artifacts') + '/'));
    assert.equal(received[0][0].sha256, artifact.sha256); assert.equal(await readFile(artifact.path!, 'utf8'), expected);
    assert.deepEqual(task(first.taskId).attempts[0].inputArtifactIds, [artifact.id]);
    const events = service.core.queryEvents(user, { runId });
    const injected = events.find(event => event.type === 'input.injected' && event.taskId === first.taskId)!;
    assert.deepEqual(injected.data.attachments, received[0].map(({ data: _, text: _text, ...metadata }) => metadata));
    assert.ok(events.some(event => event.type === 'artifact.injected' && event.taskId === first.taskId && event.artifactVersionId === artifact.id && event.targetParticipantId === 'recipient'));
    const before = await readdir(join(dataPath, 'attachments'));
    await writeFile(artifact.path!, 'tampered immutable bytes');
    const corrupt = await submit('reject-corruption'); await settled(corrupt.taskId);
    assert.equal(task(corrupt.taskId).status, 'failed'); assert.match(task(corrupt.taskId).error ?? '', /已变化|版本摘要/);
    assert.equal(received.length, 1); assert.deepEqual(await readdir(join(dataPath, 'attachments')), before);
    assert.equal(service.core.queryEvents(user, { runId }).some(event => event.type === 'artifact.injected' && event.taskId === corrupt.taskId), false);
    await writeFile(artifact.path!, expected);
    let staged!: () => void; const reachedStaging = new Promise<void>(resolve => { staged = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const importFiles = service.attachments.importFiles.bind(service.attachments);
    service.attachments.importFiles = async files => { const imported = await importFiles(files); staged(); await gate; return imported; };
    const cancelled = await submit('cancel-after-copy'); await reachedStaging;
    await service.core.call(user, 'control_task', { requestId: 'cancel-during-copy', runId, taskId: cancelled.taskId, action: 'cancel' });
    release();
    for (let i = 0; i < 400 && (await readdir(join(dataPath, 'attachments'))).length !== before.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(task(cancelled.taskId).status, 'cancelled'); assert.equal(received.length, 1);
    assert.deepEqual(await readdir(join(dataPath, 'attachments')), before);
    assert.equal(service.core.queryEvents(user, { runId }).some(event => event.type === 'input.injected' && event.taskId === cancelled.taskId), false);
    assert.equal(service.store.state.collaboration.artifacts.find(item => item.id === artifact.id)?.path, artifact.path);
  } finally { release(); await service.shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('missing project rejects a new send while replaying an existing receipt', async () => {
  const dataPath = await realpath(await mkdtemp(join(tmpdir(), 'workbench-missing-project-')));
  const cwd = join(dataPath, 'project'); await mkdir(cwd);
  let runs = 0;
  const options = { dataPath, command: process.execPath, bridgePath: join(dataPath, 'bridge.cjs'), publish() {}, providers: [{
    info: { id: 'controlled', name: 'Controlled', source: 'plugin' as const, available: true, detail: '', capabilities: { resume: true, approvals: false } },
    async run() { runs++; },
  }] };
  let service = await createWorkbenchService(options);
  try {
    const id = await service.engine.createSession({ title: 'missing project', providerId: 'controlled', cwd });
    await service.call('workbench:send-prompt', [id, { text: 'accepted' }, 'accepted']);
    await service.engine.waitSession(id);
    await service.call('workbench:save-session-draft', [id, { text: 'keep draft' }]);
    await service.shutdown(); await rm(cwd, { recursive: true });
    service = await createWorkbenchService(options);
    assert.equal(await service.call('workbench:send-prompt', [id, { text: 'accepted' }, 'accepted']), undefined);
    await assert.rejects(service.call('workbench:send-prompt', [id, { text: 'keep draft' }, 'rejected']), /项目执行目录尚未就绪/);
    assert.equal(await service.call('workbench:command-receipt', ['rejected']), undefined);
    assert.deepEqual(service.engine.getSession(id).draft, { text: 'keep draft' });
    assert.equal(runs, 1);
    await service.shutdown();
    const backend = await startBackend(options);
    try {
      const client = new BackendClient(backend.endpoint);
      const response = await fetch(`${backend.endpoint.url}/command`, { method: 'POST',
        headers: { Authorization: `Bearer ${backend.endpoint.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'workbench:send-prompt', args: [id, { text: 'keep draft' }, 'rejected'] }) });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: '项目执行目录尚未就绪，请检查目录是否仍然存在且可访问。', errorCode: 'workspace-unavailable' });
      await assert.rejects(client.call('workbench:send-prompt', id, { text: 'keep draft' }, 'rejected'),
        (error: unknown) => error instanceof BackendCommandError && error.errorCode === 'workspace-unavailable');
      assert.equal(await client.call('workbench:send-prompt', id, { text: 'accepted' }, 'accepted'), null);
      assert.equal(await client.call('workbench:command-receipt', 'rejected'), null);
      assert.equal(runs, 1);
    } finally { await backend.close(); }
  } finally { await service.shutdown(); await rm(dataPath, { recursive: true, force: true }); }
});
