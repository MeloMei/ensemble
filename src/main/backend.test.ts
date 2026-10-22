import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBackend } from './backend-server';
import { BackendClient, connectBackend } from './backend-client';
import { createWorkbenchService } from './workbench-service';
import type { Snapshot } from '../shared/types';
import type { CollaborationArtifactVersion } from '../shared/collaboration';
import type { LoadedPromptAttachment } from './providers/types';

test('session drafts restore text and attachments, survive a rejected send and clear only on accepted input', async () => {
  const dataPath = await realpath(await mkdtemp(join(tmpdir(), 'workbench-drafts-')));
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const options = { dataPath, command: process.execPath, bridgePath: join(dataPath, 'bridge.cjs'), publish() {}, providers: [{
    info: { id: 'controlled', name: 'Controlled', source: 'plugin' as const, available: true, detail: '', capabilities: { resume: true, approvals: false } },
    async run() { await gate; },
  }] };
  let service = await createWorkbenchService(options);
  try {
    const file = join(dataPath, 'notes.txt'); await writeFile(file, 'attachment contents');
    const attachments = await service.attachments.importFiles([file]);
    const id = await service.call('workbench:create-session', [{ title: 'draft', providerId: 'controlled', cwd: dataPath }]) as string;
    const input = { text: '  unfinished task\n', attachments };
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
    await service.call('workbench:send-prompt', [id, { ...input, text: input.text.trim() }]);
    assert.equal(service.engine.getSession(id).draft, undefined);
    await service.call('workbench:save-session-draft', [id, { text: 'next task' }]);
    finish(); await service.engine.waitSession(id);
    assert.deepEqual(service.engine.getSession(id).draft, { text: 'next task' });
    await service.call('workbench:save-session-draft', [id, { text: '' }]);
    await service.shutdown();
    service = await createWorkbenchService(options);
    assert.equal(service.engine.getSession(id).draft, undefined);
  } finally { finish(); await service.shutdown(); await rm(dataPath, { recursive: true, force: true }); }
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
