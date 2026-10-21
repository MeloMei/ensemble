import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startBackend } from './backend-server';
import { BackendClient, connectBackend } from './backend-client';
import type { ProviderAdapter } from './providers/types';
import type { CollaborationArtifactVersion, CollaborationEvent, CollaborationParticipant, CollaborationRun, CollaborationTask } from '../shared/collaboration';

interface IssuedConnection {
  identity: { id: string; name: string };
  configuration: { env: { WORKBENCH_IDENTITY_TOKEN: string } };
  http: { url: string; headers: { Authorization: string } };
}
interface RunView { run: CollaborationRun; tasks: CollaborationTask[]; artifacts: CollaborationArtifactVersion[] }
interface EventBatch {
  events: CollaborationEvent[]; afterSeq: number; timedOut: boolean;
  tasks: { id: string; status: string; result?: string }[];
}

const contentText = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.content as { type: string; text?: string }[]).filter(item => item.type === 'text').map(item => item.text ?? '').join('\n');

async function tool<T>(client: Client, name: string, input: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: input }, undefined, { timeout: 10_000 });
  assert.notEqual(result.isError, true, contentText(result));
  return JSON.parse(contentText(result)) as T;
}

async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Controlled provider did not receive the submitted task')), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

test('official HTTP and stdio MCP clients share authenticated tasks, immutable artifacts and reconnect receipts', { timeout: 25_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-mcp-integration-'));
  const dataPath = join(directory, 'data');
  await mkdir(join(directory, 'project'));
  const cwd = await realpath(join(directory, 'project'));
  const seed = randomUUID();
  const plan = `User-confirmed input ${seed}`;
  const expectedResult = `Controlled output ${seed}`;
  let invocations = 0;
  let receive!: (prompt: string) => void;
  const received = new Promise<string>(resolve => { receive = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const provider: ProviderAdapter = {
    info: { id: 'controlled', name: 'Controlled local fixture', source: 'plugin', available: true, detail: 'No native model process',
      capabilities: { resume: true, approvals: false },
      models: [{ id: 'fixture-model', name: 'Fixture model', free: true }], defaultModelId: 'fixture-model' },
    async run(context) {
      invocations++;
      receive(context.prompt);
      context.emit({ type: 'external-id', id: `fixture-native-${seed}` });
      await gate;
      context.emit({ type: 'text', itemId: 'fixture-output', text: expectedResult });
    },
  };
  const backend = await startBackend({ dataPath, command: process.execPath, bridgePath: resolve('src/main/mcp-stdio.ts'), providers: [provider] });
  const clients: Client[] = [];
  t.after(async () => {
    release();
    await Promise.allSettled(clients.map(client => client.close()));
    try { await backend.close(); }
    catch (error) { t.diagnostic(inspect(error, { depth: 6 })); throw error; }
    await rm(directory, { recursive: true, force: true });
  });
  const admin = new BackendClient(backend.endpoint);
  const issued = await admin.call<IssuedConnection>('workbench:collaboration-call', 'issue_identity', {
    name: 'External integration caller', policy: { createRuns: true, workspaceRoots: [cwd], providerIds: ['controlled'] },
  });
  const http = new Client({ name: 'independent-http-agent', version: '1' });
  clients.push(http);
  await http.connect(new StreamableHTTPClientTransport(new URL(issued.http.url), { requestInit: { headers: issued.http.headers } }), { timeout: 5_000 });
  const catalog = (await http.listTools()).tools.map(item => item.name);
  assert.ok(catalog.includes('create_run'));
  assert.ok(catalog.includes('submit_task'));
  const context = await tool<{ identity: { id: string; kind: string }; providers: { id: string }[] }>(http, 'get_context', {});
  assert.equal(context.identity.id, issued.identity.id);
  assert.equal(context.identity.kind, 'external');
  assert.ok(context.providers.some(item => item.id === 'controlled'));

  const caller: CollaborationParticipant = {
    id: 'entry', name: 'User-chosen entry', mode: 'external', roles: ['orchestrator', '用户自定的联络员'],
    permissions: { submitTasks: true, sendMessages: true, configureRun: false, publishArtifacts: true, allowedTargets: ['worker'] },
  };
  const worker: CollaborationParticipant = {
    id: 'worker', name: 'User-chosen worker', mode: 'managed', providerId: 'controlled', modelId: 'fixture-model', roles: ['试做者', '自定第二职责'],
    permissions: { submitTasks: false, sendMessages: true, configureRun: false, publishArtifacts: true },
  };
  const created = await tool<{ runId: string; version: number }>(http, 'create_run', {
    requestId: 'create-from-external', name: 'Arbitrary user roles', cwd, participants: [caller, worker],
    relationships: [{ id: 'user-edge', from: 'entry', to: 'worker', kind: '用户指定的协作关系' }],
    limits: { maxConcurrentTasks: 1, maxTasks: 3 }, completion: 'manual', callerParticipantId: 'entry', start: true,
  });
  const runId = created.runId;
  const denied = await http.callTool({ name: 'update_run', arguments: {
    requestId: 'role-is-not-authority', runId, expectedVersion: created.version, name: 'Unpermitted replacement',
  } });
  assert.equal(denied.isError, true);
  assert.match(contentText(denied), /权限|授权/);
  const unchanged = await tool<RunView>(http, 'get_run', { runId });
  assert.equal(unchanged.run.definitionVersion, 1);
  assert.equal(unchanged.run.definitionSnapshot.name, 'Arbitrary user roles');
  assert.deepEqual(unchanged.run.definitionSnapshot.participants.find(item => item.id === 'entry')?.roles, caller.roles);
  assert.deepEqual(unchanged.run.definitionSnapshot.participants.find(item => item.id === 'worker')?.roles, worker.roles);
  const adminDenied = await fetch(`${backend.endpoint.url}/commands`, { headers: issued.http.headers });
  assert.equal(adminDenied.status, 403);

  const artifact = await tool<CollaborationArtifactVersion>(http, 'publish_artifact', {
    requestId: 'publish-plan', runId, name: 'User-confirmed plan', kind: 'plan', content: plan,
  });
  assert.equal(artifact.participantId, 'entry');
  assert.equal(artifact.version, 1);
  assert.equal(artifact.sha256, createHash('sha256').update(plan).digest('hex'));
  const exactInput = await tool<CollaborationArtifactVersion>(http, 'get_artifact', { runId, artifactVersionId: artifact.id });
  assert.equal(exactInput.content, plan);
  const checkpoint = await tool<EventBatch>(http, 'wait_events', { runId, afterSeq: 0, timeoutMs: 0 });
  assert.ok(checkpoint.events.some(event => event.type === 'artifact.published' && event.artifactVersionId === artifact.id));
  const input = { requestId: 'execute-once', runId, participantId: 'worker', title: 'Execute exact input',
    prompt: 'Use the supplied versioned input', artifactIds: [artifact.id], dependsOn: [] };
  const accepted = await tool<{ taskId: string; runId: string; status: string }>(http, 'submit_task', input);
  assert.ok(accepted.taskId);
  const actualPrompt = await bounded(received);
  assert.ok(actualPrompt.includes(plan));
  assert.ok(actualPrompt.includes(artifact.id));
  assert.equal(invocations, 1);
  await http.close();

  const stdioTransport = new StdioClientTransport({
    command: process.execPath, args: ['--import', 'tsx', resolve('src/main/mcp-stdio.ts'), '--data-dir', dataPath],
    cwd: resolve('.'), env: { WORKBENCH_IDENTITY_TOKEN: issued.configuration.env.WORKBENCH_IDENTITY_TOKEN }, stderr: 'pipe',
  });
  let bridgeErrors = '';
  stdioTransport.stderr?.on('data', chunk => { bridgeErrors = (bridgeErrors + String(chunk)).slice(-16_384); });
  const stdio = new Client({ name: 'independent-stdio-agent', version: '1' });
  clients.push(stdio);
  await stdio.connect(stdioTransport, { timeout: 5_000 });
  assert.deepEqual((await stdio.listTools()).tools.map(item => item.name).sort(), [...catalog].sort());
  const reconnected = await tool<{ identity: { id: string }; participantId: string }>(stdio, 'get_context', { runId });
  assert.equal(reconnected.identity.id, issued.identity.id);
  assert.equal(reconnected.participantId, 'entry');
  assert.deepEqual(await tool(stdio, 'submit_task', input), accepted);
  const replay = await tool<EventBatch>(stdio, 'wait_events', { runId, afterSeq: checkpoint.afterSeq, timeoutMs: 0 });
  assert.ok(replay.events.length > 0);
  assert.ok(replay.events.every(event => event.seq > checkpoint.afterSeq));
  assert.ok(replay.events.some(event => event.type === 'task.submitted' && event.taskId === accepted.taskId));
  assert.ok(replay.events.some(event => event.type === 'artifact.injected' && event.artifactVersionId === artifact.id));
  const observed = [...checkpoint.events, ...replay.events];
  let cursor = replay.afterSeq;
  release();
  let final: EventBatch;
  do {
    final = await tool<EventBatch>(stdio, 'wait_events', { runId, afterSeq: cursor, taskIds: [accepted.taskId], timeoutMs: 5_000 });
    observed.push(...final.events);
    cursor = final.afterSeq;
    assert.equal(final.timedOut, false, bridgeErrors);
  } while (!['completed', 'failed', 'cancelled', 'interrupted'].includes(final.tasks[0]?.status));
  assert.equal(final.tasks[0].status, 'completed');
  assert.equal(final.tasks[0].result, expectedResult);
  assert.equal(new Set(observed.map(event => event.seq)).size, observed.length);
  assert.ok(observed.every((event, index) => index === 0 || event.seq > observed[index - 1].seq));
  const view = await tool<RunView>(stdio, 'get_run', { runId });
  assert.equal(view.tasks.length, 1);
  assert.equal(view.tasks[0].attempts.length, 1);
  assert.equal(view.tasks[0].attempts[0].nativeId, `fixture-native-${seed}`);
  assert.ok(view.tasks[0].attempts[0].engineAttemptId);
  assert.deepEqual(view.tasks[0].attempts[0].inputArtifactIds, [artifact.id]);
  const outputId = view.tasks[0].attempts[0].outputArtifactIds[0];
  const output = await tool<CollaborationArtifactVersion>(stdio, 'get_artifact', { runId, artifactVersionId: outputId });
  assert.equal(output.content, expectedResult);
  assert.equal(output.taskId, accepted.taskId);
  assert.equal(output.sha256, createHash('sha256').update(expectedResult).digest('hex'));
  const empty = await tool<EventBatch>(stdio, 'wait_events', { runId, afterSeq: cursor, timeoutMs: 0 });
  assert.equal(empty.events.length, 0);
  assert.equal(empty.afterSeq, cursor);
  assert.equal(invocations, 1);
  assert.equal((await connectBackend(dataPath)).endpoint.instanceId, backend.endpoint.instanceId);

  await admin.call('workbench:collaboration-call', 'revoke_identity', { identityId: issued.identity.id });
  const revoked = await stdio.callTool({ name: 'get_context', arguments: { runId } }, undefined, { timeout: 5_000 });
  assert.equal(revoked.isError, true);
  const refused = new Client({ name: 'revoked-http-agent', version: '1' });
  clients.push(refused);
  await assert.rejects(refused.connect(new StreamableHTTPClientTransport(new URL(issued.http.url), {
    requestInit: { headers: issued.http.headers },
  }), { timeout: 5_000 }), error => error instanceof StreamableHTTPError && error.code === 403);
});
