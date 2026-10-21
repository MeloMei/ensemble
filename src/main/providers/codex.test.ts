import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ApprovalInput, Session } from '../../shared/types';
import { createCodexProvider } from './codex';
import { JsonRpcProcess } from './json-rpc';
import type { ProviderEvent, TurnContext } from './types';

const fixture = String.raw`
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
if (process.argv.includes('--version')) { console.log('codex-cli fixture'); process.exit(0); }
const mode = process.env.CODEX_ADAPTER_FIXTURE_MODE;
const trace = process.env.CODEX_ADAPTER_FIXTURE_TRACE;
let threadId = 'new-owned-thread';
let approvals = 0;
let turnNumber = 0;
let turnId = '';
if (trace) appendFileSync(trace, JSON.stringify({ fixture: 'spawn', pid: process.pid }) + '\n');
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const response = (id, result) => send({ id, result });
const event = (method, params) => send({ method, params: { threadId, ...params } });
let item = { type: 'agentMessage', id: 'answer', text: 'Hello world' };
const complete = (status = 'completed') => event('turn/completed', { turn: {
  id: turnId, status, items: [item], error: status === 'failed' ? { message: 'intentional failure' } : null,
} });
const stream = () => {
  event('item/agentMessage/delta', { turnId, itemId: 'answer', delta: item.text.slice(0, 5) });
  event('item/agentMessage/delta', { turnId, itemId: 'answer', delta: item.text.slice(5) });
  event('item/completed', { turnId, item });
  complete();
};
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (trace) appendFileSync(trace, JSON.stringify({ ...message, fixturePid: process.pid }) + '\n');
  if (!message.method) {
    if (['mcp-policy', 'command-policy', 'file-policy', 'permission-policy'].includes(message.id)) { if (++approvals === 4) stream(); return; }
    if (message.id === 'native-question') { if (!message.result?.answers?.format?.answers?.length) process.exit(11); stream(); return; }
    if (message.id === 'approval-command' || message.id === 'approval-file') {
      if (!message.result?.decision) process.exit(8);
      if (++approvals === 2) stream();
    }
    return;
  }
  if (message.method === 'initialize') { response(message.id, { userAgent: 'fixture' }); return; }
  if (message.method === 'initialized') return;
  if (message.method === 'model/list') { response(message.id, { data: [{ id: 'fixture-model', displayName: 'Fixture model', isDefault: true, inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }], nextCursor: null }); return; }
  if (message.method === 'thread/read') { response(message.id, { thread: { id: threadId, historyMode: mode === 'legacy' ? 'legacy' : 'paginated' } }); return; }
  if (message.method === 'thread/revert') { response(message.id, { thread: { id: threadId } }); return; }
  if (message.method === 'never') return;
  if (message.method === 'child') {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
    response(message.id, { pid: child.pid }); return;
  }
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    if (message.params.approvalPolicy && typeof message.params.approvalPolicy==='string' && !['on-request', 'never'].includes(message.params.approvalPolicy)) process.exit(9);
    if (message.params.sandbox && !['workspace-write', 'read-only'].includes(message.params.sandbox)) process.exit(9);
    threadId = message.params.threadId || threadId;
    response(message.id, { thread: { id: threadId } }); return;
  }
  if (message.method === 'turn/interrupt') { response(message.id, {}); complete('interrupted'); return; }
  if (message.method === 'turn/start') {
    if (!Array.isArray(message.params.input[0].text_elements)) process.exit(10);
    turnId = 'turn-' + (++turnNumber);
    if (mode === 'routing') item = { ...item, text: message.params.input[0].text };
    if (turnNumber > 1) event('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'answer', delta: 'stale-turn' });
    response(message.id, { turn: { id: turnId, status: 'inProgress', items: [] } });
    event('turn/started', { turn: { id: turnId, status: 'inProgress', items: [] } });
    if (mode === 'exit') { process.exit(7); }
    if (mode === 'failed') { complete('failed'); return; }
    if (mode === 'abort') { event('item/started', { turnId, item: { type: 'commandExecution', id: 'cmd', command: 'fixture-ready' } }); return; }
    if (mode === 'question') {
      send({ id: 'question', method: 'item/tool/requestUserInput', params: { threadId, turnId, questions: [] } }); return;
    }
    if (mode === 'questions') {
      send({ id: 'native-question', method: 'item/tool/requestUserInput', params: { threadId, turnId, itemId: 'question-item', questions: [{ id: 'format', header: 'Format', question: 'Choose a format', options: [{ label: 'short', description: 'brief' }, { label: 'long' }] }] } }); return;
    }
    if (mode === 'policy') {
      send({ id: 'mcp-policy', method: 'mcpServer/elicitation/request', params: { threadId, turnId, serverName: 'user-service', mode: 'form', message: 'Approve external MCP action?', requestedSchema: { type: 'object', properties: {} } } });
      send({ id: 'command-policy', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'write-command', command: 'write command', availableDecisions: ['accept', 'decline', 'cancel'] } });
      send({ id: 'file-policy', method: 'item/fileChange/requestApproval', params: { threadId, turnId, itemId: 'write-file', availableDecisions: ['accept', 'decline'] } });
      send({ id: 'permission-policy', method: 'item/permissions/requestApproval', params: { threadId, turnId, itemId: 'permissions', cwd: process.cwd(), startedAtMs: 1, permissions: { fileSystem: { write: ['/outside'] } } } }); return;
    }
    if (mode === 'rich') {
      event('item/started', { turnId, item: { type: 'commandExecution', id: 'native-command', command: 'literal command', status: 'inProgress' } });
      event('item/commandExecution/outputDelta', { turnId, itemId: 'native-command', delta: 'actual output' });
      event('item/completed', { turnId, item: { type: 'commandExecution', id: 'native-command', command: 'literal command', status: 'completed', aggregatedOutput: 'actual output', exitCode: 0 } });
      event('turn/plan/updated', { turnId, plan: [{ step: 'Observed native task', status: 'completed' }] });
      event('thread/tokenUsage/updated', { turnId, tokenUsage: { last: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 4, totalTokens: 15 }, total: { inputTokens: 100 }, modelContextWindow: 1000 } });
      event('item/completed', { turnId, item: { type: 'collabAgentToolCall', id: 'collab', tool: 'spawnAgent', receiverThreadIds: ['native-child'], agentsStates: { 'native-child': { status: 'completed', message: 'child result' } }, status: 'completed' } });
    }
    if (mode === 'approval') {
      event('item/started', { turnId, item: { type: 'fileChange', id: 'file', changes: [{ path: '/fixture/result.txt', diff: '+result' }] } });
      send({ id: 'approval-command', method: 'item/commandExecution/requestApproval', params: {
        threadId, turnId, itemId: 'command', command: 'fixture command', availableDecisions: ['decline'],
      } });
      send({ id: 'approval-file', method: 'item/fileChange/requestApproval', params: {
        threadId, turnId, itemId: 'file', availableDecisions: ['accept', 'cancel'],
      } });
      return;
    }
    stream();
  }
});

process.stdin.on('end', () => process.exit(0));
`;

test('Codex provider uses the app-server protocol and cleans up owned processes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-codex-'));
  const binary = join(directory, 'codex.mjs');
  const trace = join(directory, 'trace.jsonl');
  await writeFile(binary, `#!${process.execPath}\n${fixture}`, { mode: 0o755 });
  const saved = {
    binary: process.env.CODEX_BINARY,
    mode: process.env.CODEX_ADAPTER_FIXTURE_MODE,
    trace: process.env.CODEX_ADAPTER_FIXTURE_TRACE,
  };
  process.env.CODEX_BINARY = binary;
  process.env.CODEX_ADAPTER_FIXTURE_TRACE = trace;
  const session: Session = {
    id: 'local-session', title: 'Fixture', providerId: 'codex', cwd: directory,
    status: 'running', messages: [], approvals: [], createdAt: '', updatedAt: '',
  };
  const context = (overrides: Partial<TurnContext> = {}): TurnContext & { events: ProviderEvent[] } => {
    const events: ProviderEvent[] = [];
    return {
      session, prompt: 'fixture prompt', signal: new AbortController().signal, events,
      emit: event => events.push(event),
      approve: async () => { throw new Error('unexpected approval'); },
      ...overrides,
    };
  };
  const providers: Awaited<ReturnType<typeof createCodexProvider>>[] = [];
  const createProvider = async () => {
    const provider = await createCodexProvider();
    providers.push(provider);
    return provider;
  };
  try {
    await t.test('streams once, reconciles final snapshots, and resumes only its saved external id', async () => {
      process.env.CODEX_ADAPTER_FIXTURE_MODE = 'stream';
      const provider = await createProvider();
      assert.equal(provider.info.available, true);
      const first = context();
      await provider.run(first);
      assert.deepEqual(first.events.filter(event => event.type === 'text'), [
        { type: 'text', itemId: 'answer', text: 'Hello' },
        { type: 'text', itemId: 'answer', text: ' world' },
      ]);
      assert(first.events.some(event => event.type === 'external-id' && event.id === 'new-owned-thread'));
      await provider.run(context({ session: { ...session, id: 'saved-session', externalId: 'saved-owned-thread' } }));
      const records = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(records.filter(record => record.method === 'thread/start').length, 1);
      assert(records.some(record => record.method === 'thread/resume' && record.params.threadId === 'saved-owned-thread' && record.params.excludeTurns === true));
    });
    await t.test('presents only supported offered approval choices and includes file changes', async () => {
      process.env.CODEX_ADAPTER_FIXTURE_MODE = 'approval';
      const inputs: ApprovalInput[] = [];
      await (await createProvider()).run(context({ approve: async input => { inputs.push(input); return input.choices[0].id; } }));
      assert.deepEqual(inputs.map(input => input.choices.map(choice => choice.id)), [['decline'], ['accept', 'cancel']]);
      assert.match(inputs[1].detail, /\/fixture\/result\.txt/);
      assert.match(inputs[1].detail, /\+result/);
    });
    await t.test('does not treat structured questions as permissions', async () => {
      process.env.CODEX_ADAPTER_FIXTURE_MODE = 'question';
      await assert.rejects((await createProvider()).run(context()), /结构化问答/);
    });
    await t.test('failed completion and process exit cannot report success', async () => {
      process.env.CODEX_ADAPTER_FIXTURE_MODE = 'failed';
      await assert.rejects((await createProvider()).run(context()), /intentional failure/);
      process.env.CODEX_ADAPTER_FIXTURE_MODE = 'exit';
      await assert.rejects((await createProvider()).run(context()), /完成前退出/);
    });
    await t.test('abort interrupts the current turn and releases the connection', async () => {
      process.env.CODEX_ADAPTER_FIXTURE_MODE = 'abort';
      const controller = new AbortController();
      await assert.rejects((await createProvider()).run(context({
        signal: controller.signal,
        emit: event => { if (event.type === 'activity') controller.abort(); },
      })), { name: 'AbortError' });
      const records = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert(records.some(record => record.method === 'turn/interrupt' && record.params.turnId === 'turn-1'));
    });
    await t.test('request timeout can close without leaving the process alive', async () => {
      const rpc = new JsonRpcProcess({ command: binary, args: [] });
      try { await assert.rejects(rpc.request('never', {}, { timeoutMs: 20 }), /请求超时/); }
      finally { await rpc.close(); }
      assert.equal((await rpc.closed).code, 0);
    });
    await t.test('catalog settings attachments MCP rotation structured events and native revert use real wire fields', async () => {
      process.env.CODEX_ADAPTER_FIXTURE_MODE = 'rich';
      const provider = await createProvider();
      assert.deepEqual(provider.info.models?.[0].efforts, ['low', 'high']);
      assert.equal(provider.info.defaultModelId, undefined);
      const first = context({ userMessageId: 'local-user', session: { ...session, id: 'rich-session', modelId: 'fixture-model', settings: { effort: 'low', permission: 'read-only' } },
        attachments: [
          { id: 'i', name: 'screen.png', kind: 'image', mimeType: 'image/png', size: 3, sha256: 'h', ownedPath: '/owned/screen.png', data: Buffer.from([1, 2, 3]) },
          { id: 't', name: 'note.txt', kind: 'text', mimeType: 'text/plain', size: 4, sha256: 'j', ownedPath: '/owned/note.txt', data: Buffer.from('real'), text: 'real' },
        ], mcpServers: [{ name: 'workbench', type: 'stdio', command: 'node', args: ['bridge', 'token-first'], env: { ELECTRON_RUN_AS_NODE: '1' } }] });
      await provider.run(first);
      assert(first.events.some(event => event.type === 'native-turn' && event.turnId === 'turn-1'));
      assert(first.events.some(event => event.type === 'structured' && event.event.kind === 'tool' && event.event.status === 'completed' && event.event.output === 'actual output'));
      assert(first.events.some(event => event.type === 'structured' && event.event.kind === 'plan' && event.event.entries?.[0].text === 'Observed native task'));
      assert(first.events.some(event => event.type === 'structured' && event.event.kind === 'subagent' && event.event.nativeId === 'native-child'));
      assert(first.events.some(event => event.type === 'usage' && event.usage.scope === 'turn' && event.usage.inputTokens === 12));
      const recordsBefore = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const sent = recordsBefore.find(record => record.method === 'turn/start' && record.params.clientUserMessageId === 'local-user');
      assert.equal(sent.params.effort, 'low'); assert.equal(sent.params.model, 'fixture-model');
      assert.equal(sent.params.sandboxPolicy.type, 'readOnly');
      assert.equal(sent.params.approvalPolicy.granular.sandbox_approval, false);
      assert.equal(sent.params.approvalPolicy.granular.mcp_elicitations, true);
      assert.deepEqual(sent.params.input[1], { type: 'localImage', path: '/owned/screen.png' });
      assert.match(sent.params.input[2].text, /real/);
      await provider.run({ ...first, session: { ...first.session, externalId: 'new-owned-thread' }, mcpServers: [{ name: 'workbench', type: 'stdio', command: 'node', args: ['bridge', 'token-second'], env: { ELECTRON_RUN_AS_NODE: '1' } }] });
      const records = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const resumed = records.find(record => record.method === 'thread/resume' && record.params.config?.mcp_servers?.workbench?.args?.includes('token-second'));
      assert.equal(resumed.params.config.mcp_servers.workbench.env.ELECTRON_RUN_AS_NODE, '1');
      await provider.rewind!({ ...first.session, externalId: 'new-owned-thread' }, 'turn-1');
      const after = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert(after.some(record => record.method === 'thread/revert' && record.params.beforeTurnId === 'turn-1'));
      process.env.CODEX_ADAPTER_FIXTURE_MODE = 'legacy';
      const legacy = await createProvider();
      await assert.rejects(legacy.rewind!({ ...session, id: 'legacy-session', externalId: 'legacy-thread' }, 'old-turn'), /没有分页历史/);
      const last = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert(!last.some(record => record.method === 'thread/revert' && record.params.threadId === 'legacy-thread'));
    });
    await t.test('closing the parent also kills its remaining descendants', { skip: process.platform === 'win32' }, async () => {
      const rpc = new JsonRpcProcess({ command: binary, args: [] });
      let pid: number | undefined;
      try { pid = (await rpc.request<{ pid: number }>('child')).pid; }
      finally { await rpc.close(); }
      assert(pid);
      for (let attempt = 0; attempt < 100; attempt++) {
        try { process.kill(pid, 0); } catch (error) {
          assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('owned descendant remained alive after connection cleanup');
    });
  } finally {
    await Promise.all(providers.map(provider => provider.dispose!()));
    for (const [key, value] of Object.entries({ CODEX_BINARY: saved.binary, CODEX_ADAPTER_FIXTURE_MODE: saved.mode, CODEX_ADAPTER_FIXTURE_TRACE: saved.trace })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});


test('Codex session connections survive turns and refresh, isolate routing, and dispose owned servers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-codex-sessions-'));
  const binary = join(directory, 'codex.mjs');
  const trace = join(directory, 'trace.jsonl');
  await writeFile(binary, `#!${process.execPath}\n${fixture}`, { mode: 0o755 });
  const saved = {
    CODEX_BINARY: process.env.CODEX_BINARY,
    CODEX_ADAPTER_FIXTURE_MODE: process.env.CODEX_ADAPTER_FIXTURE_MODE,
    CODEX_ADAPTER_FIXTURE_TRACE: process.env.CODEX_ADAPTER_FIXTURE_TRACE,
  };
  Object.assign(process.env, {
    CODEX_BINARY: binary, CODEX_ADAPTER_FIXTURE_MODE: 'routing', CODEX_ADAPTER_FIXTURE_TRACE: trace,
  });
  let provider: Awaited<ReturnType<typeof createCodexProvider>> | undefined;
  const context = (id: string, prompt: string, externalId?: string): TurnContext & { events: ProviderEvent[] } => {
    const events: ProviderEvent[] = [];
    return {
      session: {
        id, title: id, providerId: 'codex', cwd: directory, externalId,
        status: 'running', messages: [], approvals: [], createdAt: '', updatedAt: '',
      },
      prompt, events, signal: new AbortController().signal, emit: event => events.push(event),
      approve: async () => { throw new Error('unexpected approval'); },
    };
  };
  const output = (turn: ReturnType<typeof context>) => turn.events
    .filter((event): event is Extract<ProviderEvent, { type: 'text' }> => event.type === 'text')
    .map(event => event.text).join('');
  try {
    provider = await createCodexProvider();
    const first = context('session-a', 'first session first turn');
    await provider.run(first);
    await provider.refreshInfo();
    const second = context('session-a', 'first session second turn', 'new-owned-thread');
    const other = context('session-b', 'second session only turn', 'saved-other-thread');
    await Promise.all([provider.run(second), provider.run(other)]);
    assert.equal(output(first), first.prompt);
    assert.equal(output(second), second.prompt);
    assert.equal(output(other), other.prompt);
    assert.equal(first.events.filter(event => event.type === 'text').length, 2);
    assert.equal(second.events.filter(event => event.type === 'text').length, 2);
    const records = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const pids = records.filter(record => record.fixture === 'spawn').map(record => record.pid as number).filter(pid => records.some(record => record.fixturePid === pid && ['thread/start', 'thread/resume'].includes(record.method)));
    assert.equal(pids.length, 2);
    const firstRecords = records.filter(record => record.fixturePid === pids[0]);
    assert.equal(firstRecords.filter(record => record.method === 'initialize').length, 1);
    assert.equal(firstRecords.filter(record => record.method === 'thread/start').length, 1);
    assert.equal(firstRecords.filter(record => record.method === 'thread/resume').length, 0);
    assert.equal(firstRecords.filter(record => record.method === 'turn/start').length, 2);
    const secondRecords = records.filter(record => record.fixturePid === pids[1]);
    assert(secondRecords.some(record => record.method === 'thread/resume' && record.params.threadId === 'saved-other-thread'));
    assert(secondRecords.filter(record => record.method === 'turn/start').every(record => record.params.threadId === 'saved-other-thread'));
    for (const pid of pids) assert.doesNotThrow(() => process.kill(pid, 0));
    await provider.dispose!();
    await provider.dispose!();
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await assert.rejects(provider.run(second), /运行时已经关闭/);
  } finally {
    await provider?.dispose?.();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});


test('Codex native questions retain question ids and return native answer objects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-codex-question-'));
  const binary = join(directory, 'codex.mjs');
  const trace = join(directory, 'trace.jsonl');
  await writeFile(binary, `#!${process.execPath}\n${fixture}`, { mode: 0o755 });
  const saved = { CODEX_BINARY: process.env.CODEX_BINARY, CODEX_ADAPTER_FIXTURE_MODE: process.env.CODEX_ADAPTER_FIXTURE_MODE, CODEX_ADAPTER_FIXTURE_TRACE: process.env.CODEX_ADAPTER_FIXTURE_TRACE };
  Object.assign(process.env, { CODEX_BINARY: binary, CODEX_ADAPTER_FIXTURE_MODE: 'questions', CODEX_ADAPTER_FIXTURE_TRACE: trace });
  let provider: Awaited<ReturnType<typeof createCodexProvider>> | undefined;
  try {
    provider = await createCodexProvider();
    await provider.run({ session: { id: 'question-session', title: 'Question', providerId: 'codex', cwd: directory, status: 'running', messages: [], approvals: [], createdAt: '', updatedAt: '' }, prompt: 'question', signal: new AbortController().signal, emit: () => {},
      approve: async input => { assert.deepEqual(input.questions?.map(question => question.id), ['format']); assert.deepEqual(input.choices, []); return JSON.stringify({ format: ['short'] }); } });
    const records = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(records.find(record => record.id === 'native-question' && !record.method)?.result, { answers: { format: { answers: ['short'] } } });
  } finally {
    await provider?.dispose?.();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  }
});


test('Codex read-only policy routes MCP consent to the user while denying filesystem escalation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-codex-policy-'));
  const binary = join(directory, 'codex.mjs');
  const trace = join(directory, 'trace.jsonl');
  await writeFile(binary, `#!${process.execPath}\n${fixture}`, { mode: 0o755 });
  const saved = { CODEX_BINARY: process.env.CODEX_BINARY, CODEX_ADAPTER_FIXTURE_MODE: process.env.CODEX_ADAPTER_FIXTURE_MODE, CODEX_ADAPTER_FIXTURE_TRACE: process.env.CODEX_ADAPTER_FIXTURE_TRACE };
  Object.assign(process.env, { CODEX_BINARY: binary, CODEX_ADAPTER_FIXTURE_MODE: 'policy', CODEX_ADAPTER_FIXTURE_TRACE: trace });
  let provider: Awaited<ReturnType<typeof createCodexProvider>> | undefined;
  let approvals = 0;
  try {
    provider = await createCodexProvider();
    await provider.run({ session: { id: 'policy-session', title: 'Policy', providerId: 'codex', cwd: directory, settings: { permission: 'read-only' }, status: 'running', messages: [], approvals: [], createdAt: '', updatedAt: '' }, prompt: 'metadata fixture', signal: new AbortController().signal, emit: () => {},
      approve: async input => { approvals++; assert.match(input.title, /MCP user-service/); assert(input.choices.some(choice => choice.id === 'accept')); return 'accept'; } });
    assert.equal(approvals, 1);
    const records = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const start = records.find(record => record.method === 'thread/start');
    assert.equal(start.params.sandbox, 'read-only');
    assert.deepEqual(start.params.approvalPolicy, { granular: { sandbox_approval: false, rules: false, mcp_elicitations: true, request_permissions: false, skill_approval: false } });
    const reply = (id: string) => records.find(record => record.id === id && !record.method)?.result;
    assert.deepEqual(reply('mcp-policy'), { action: 'accept', content: {} });
    assert.deepEqual(reply('command-policy'), { decision: 'decline' });
    assert.deepEqual(reply('file-policy'), { decision: 'decline' });
    assert.deepEqual(reply('permission-policy'), { permissions: {}, scope: 'turn' });
  } finally {
    await provider?.dispose?.();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  }
});
