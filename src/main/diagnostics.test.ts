import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DiagnosticEntry } from '../shared/types';
import { DiagnosticJournal, replayProtocol } from './diagnostics';
import { JsonRpcProcess } from './providers/json-rpc';
import type { ProviderAdapter } from './providers/types';
import { createWorkbenchService } from './workbench-service';

const privatePrompt = 'DIAGNOSTIC_PRIVATE_PROMPT_中文';
const privateEnvironment = 'DIAGNOSTIC_PRIVATE_ENV_VALUE';
const privateError = 'DIAGNOSTIC_RAW_PRIVATE_ERROR';
const privateInvalid = 'DIAGNOSTIC_INVALID_PRIVATE_CONTENT';
const rpcSource = String.raw`
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
lines.on('line', line => {
  const frame = JSON.parse(line);
  if (frame.params.invalid) {
    process.stdout.write('{ DIAGNOSTIC_INVALID_PRIVATE_CONTENT customer_Alice\n'); return;
  }
  if (frame.params.fail) {
    process.stderr.write('DIAGNOSTIC_RAW_PRIVATE_ERROR: stderr detail');
    send({ id: frame.id, error: { code: -32001, message: 'DIAGNOSTIC_RAW_PRIVATE_ERROR', data: { prompt: frame.params.prompt, environment: process.env.DIAGNOSTIC_SECRET } } });
    return;
  }
  send({ method: 'item/completed', params: { threadId: 'private-native-thread', turnId: 'private-native-turn', item: { type: 'commandExecution', id: 'private-tool', command: frame.params.prompt, output: process.env.DIAGNOSTIC_SECRET, count: 73, flag: true } } });
  send({ id: frame.id, result: { turn: { id: 'private-native-turn', status: 'completed', durationMs: 73, privateFlag: true,
    items: [{ type: 'agentMessage', id: 'private-output', text: frame.params.prompt, content: { privateEnvironment: process.env.DIAGNOSTIC_SECRET } }] } } });
});
process.stdin.on('end', () => process.exit(0));
`;

test('native RPC diagnostics correlate with engine attempts, omit private values by default and replay optional redacted shapes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-diagnostics-rpc-'));
  const script = join(directory, 'fixture.mjs'); await writeFile(script, rpcSource);
  const provider: ProviderAdapter = { info: { id: 'diagnostic-fixture', name: 'Diagnostic fixture', source: 'plugin', available: true,
    detail: '', capabilities: { resume: true, approvals: true } }, async run(context) {
    const rpc = new JsonRpcProcess({ command: process.execPath, args: [script], cwd: context.session.cwd,
      env: { ...process.env, DIAGNOSTIC_SECRET: privateEnvironment } });
    try {
      const result = await rpc.request<{ turn: { items: { text: string }[] } }>('turn/start', { prompt: context.prompt,
        env: { DIAGNOSTIC_SECRET: privateEnvironment }, fail: context.prompt === privateError, invalid: context.prompt === privateInvalid });
      context.emit({ type: 'structured', event: { id: 'fixture-tool', kind: 'tool', title: 'Fixture tool', status: 'completed', input: context.prompt, output: result.turn.items[0].text } });
      context.emit({ type: 'text', itemId: 'answer', text: 'Fixture completed' });
    } finally { await rpc.close(); }
  } };
  const dataPath = join(directory, 'data');
  const service = await createWorkbenchService({ dataPath, command: process.execPath, bridgePath: join(directory, 'bridge.cjs'), providers: [provider], publish() {} });
  let closed = false;
  try {
    assert.equal(await service.call('workbench:diagnostic-tracing', []), false);
    const id = await service.engine.createSession({ title: 'diagnostics', providerId: provider.info.id, cwd: directory });
    service.engine.sendPrompt(id, { text: privatePrompt }, 'diagnostic-default'); await service.engine.waitSession(id);
    service.engine.sendPrompt(id, { text: privateError }, 'diagnostic-error'); await service.engine.waitSession(id);
    assert.equal(service.engine.getSession(id).status, 'failed');
    const defaults = await service.call('workbench:diagnostics', []) as DiagnosticEntry[];
    assert(defaults.some(entry => entry.layer === 'provider' && entry.kind === 'rpc.send' && entry.method === 'turn/start'));
    assert(defaults.some(entry => entry.layer === 'provider' && entry.kind === 'rpc.receive'));
    assert(defaults.every(entry => entry.protocol === undefined));
    assert(defaults.some(entry => entry.layer === 'engine' && entry.kind === 'dispatch.settled' && entry.status === 'failed' && entry.errorCode === 'runtime-failure'));
    const defaultExport = await service.call('workbench:export-diagnostics', []) as string;
    const defaultSource = await readFile(defaultExport, 'utf8');
    for (const value of [privatePrompt, privateEnvironment, privateError]) assert(!defaultSource.includes(value));
    assert.equal((await stat(defaultExport)).mode & 0o777, 0o600);

    await service.call('workbench:set-diagnostic-tracing', [true]);
    service.engine.sendPrompt(id, { text: `${privatePrompt}-traced` }, 'diagnostic-traced'); await service.engine.waitSession(id);
    const attemptId = service.engine.getSession(id).attempts!.at(-1)!.id;
    const entries = await service.call('workbench:diagnostics', []) as DiagnosticEntry[];
    const started = entries.find(entry => entry.layer === 'engine' && entry.kind === 'dispatch.started' && entry.attemptId === attemptId);
    const sent = entries.find(entry => entry.layer === 'provider' && entry.kind === 'rpc.send' && entry.attemptId === attemptId);
    assert(started?.turnId); assert(sent?.runtimeId); assert.equal(sent.sessionId, id); assert.equal(sent.providerId, provider.info.id);
    assert(entries.some(entry => entry.kind === 'rpc.receive' && entry.runtimeId === sent.runtimeId && entry.requestId === sent.requestId));
    const replayed: { record: unknown; entry: DiagnosticEntry }[] = [];
    const count = replayProtocol(entries, (record, entry) => replayed.push({ record, entry }));
    assert.equal(count, entries.filter(entry => entry.layer === 'provider' && entry.kind === 'rpc.receive' && entry.protocol !== undefined).length);
    assert(count >= 2); assert(replayed.every(item => item.entry.kind === 'rpc.receive'));
    const response = replayed.map(item => item.record as { result?: { turn: { items: { type: string; text: string }[]; durationMs: number; status: string; [key: string]: unknown } } }).find(record => record.result)?.result?.turn;
    assert(response); assert.match(response.items[0].text, /^redacted:/); assert.equal(response.durationMs, 0); assert.equal(typeof response.durationMs, 'number');
    assert(Object.values(response).some(value => value === false)); assert.equal(response.status, 'completed'); assert.equal(response.items[0].type, 'agentMessage');
    service.engine.sendPrompt(id, { text: privateInvalid }, 'diagnostic-invalid'); await service.engine.waitSession(id);
    const invalidAttempt = service.engine.getSession(id).attempts!.at(-1)!.id;
    const finalEntries = await service.call('workbench:diagnostics', []) as DiagnosticEntry[];
    const invalidSend = finalEntries.find(entry => entry.kind === 'rpc.send' && entry.attemptId === invalidAttempt);
    const decodeFailure = finalEntries.find(entry => entry.kind === 'decode.failed');
    assert.equal(service.engine.getSession(id).status, 'failed'); assert(invalidSend?.runtimeId);
    assert.equal(decodeFailure?.layer, 'provider'); assert.equal(decodeFailure?.providerId, provider.info.id);
    assert.equal(decodeFailure?.sessionId, id); assert.equal(decodeFailure?.runtimeId, invalidSend.runtimeId);
    assert.equal(decodeFailure?.protocol, undefined);
    assert(finalEntries.some(entry => entry.kind === 'rpc.failed' && entry.runtimeId === invalidSend.runtimeId));
    const exported = await service.call('workbench:export-diagnostics', []) as string;
    const exportedSource = await readFile(exported, 'utf8');
    for (const value of [privatePrompt, privateEnvironment, privateError, privateInvalid, 'customer_Alice', 'private-native-thread', 'private-tool']) assert(!exportedSource.includes(value));
    await service.shutdown(); closed = true;
    const restored = new DiagnosticJournal(join(dataPath, 'diagnostics', 'lifecycle.ndjson')); await restored.load();
    assert.deepEqual(restored.snapshot().map(entry => entry.seq), finalEntries.map(entry => entry.seq));
    assert(restored.snapshot().some(entry => entry.layer === 'engine' && entry.attemptId === attemptId));
    assert(replayProtocol(restored.snapshot(), () => {}) >= 2);
  } finally { if (!closed) await service.shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('protocol capture preserves enums only in structural paths and anonymizes body values and customer keys', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-diagnostics-schema-'));
  const journal = new DiagnosticJournal(join(directory, 'lifecycle.ndjson'));
  const context = { providerId: 'fixture', sessionId: 'platform-session' };
  try {
    journal.setTracing(true);
    journal.native(context, 'send', 'runtime', { jsonrpc: '2.0', id: 'same-id', method: 'turn/start', params: {
      threadId: 'same-id', input: [{ type: 'text', text: 'completed', content: { customer_Alice: { status: 'user', role: 'assistant', kind: 'tool', id: 'same-id' } } }],
      prompt: 'completed', output: { customer_Alice: 'user', status: 'completed' }, arguments: { customer_Alice: 'running' },
      env: { customer_Alice: 'system' }, data: { customer_Alice: 'assistant' }, customer_Alice: { type: 'agentMessage', status: 'completed' },
    } });
    journal.native(context, 'receive', 'runtime', { jsonrpc: '2.0', id: 'same-id', result: { turn: { id: 'same-id', status: 'completed', items: [
      { type: 'agentMessage', id: 'same-id', text: 'user', output: { customer_Alice: 'completed', type: 'text', status: 'completed' } },
    ] } } });
    const [sent, received] = journal.snapshot();
    const request = sent.protocol as { id: string; method: string; params: Record<string, unknown> & { threadId: string; input: unknown[] } };
    const response = received.protocol as { id: string; result: { turn: { id: string; status: string; items: { id: string; type: string; text: string; output: unknown }[] } } };
    assert.equal(request.method, 'turn/start'); assert.match(request.id, /^redacted:/);
    assert.equal(request.id, request.params.threadId); assert.equal(request.id, response.id);
    assert.equal(request.id, response.result.turn.id); assert.equal(request.id, response.result.turn.items[0].id);
    assert.equal(sent.requestId, received.requestId); assert.equal(sent.requestId, request.id);
    assert.equal(response.result.turn.status, 'completed'); assert.equal(response.result.turn.items[0].type, 'agentMessage');
    assert.match(response.result.turn.items[0].text, /^redacted:/);
    for (const body of [request.params.input, response.result.turn.items[0].output]) {
      const encoded = JSON.stringify(body);
      for (const raw of ['customer_Alice', 'completed', 'user', 'assistant', 'system', 'tool', 'text', 'agentMessage', '"type"', '"status"', '"role"', '"kind"']) assert(!encoded.includes(raw), encoded);
    }
    assert(Object.keys(request.params).every(key => key === 'threadId' || key === 'input' || key.startsWith('redacted:')));
    const exported = await journal.export(directory); assert(!(await readFile(exported, 'utf8')).includes('customer_Alice'));
    journal.native(context, 'send', 'runtime', { id: 'same-id', method: 'customer_Alice', params: {} });
    journal.native(context, 'receive', 'runtime', { id: 'same-id', result: { turn: { status: 'completed' } } });
    const unknownResult = (journal.snapshot().at(-1)!.protocol as { result: unknown }).result;
    for (const raw of ['"turn"', '"status"', 'completed']) assert(!JSON.stringify(unknownResult).includes(raw));
    journal.setTracing(false);
    journal.native(context, 'receive', 'runtime', { id: 'customer_Alice', method: 'customer_Alice', params: { prompt: 'completed' } });
    const metadata = journal.snapshot().at(-1)!;
    assert.equal(metadata.protocol, undefined); assert.match(metadata.method!, /^redacted:/); assert.match(metadata.requestId!, /^redacted:/);
  } finally { await journal.flush(); await rm(directory, { recursive: true, force: true }); }
});

test('diagnostic journal bounds entries and bytes and continues sequence after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-diagnostics-bounds-'));
  const path = join(directory, 'lifecycle.ndjson'), journal = new DiagnosticJournal(path);
  let restored: DiagnosticJournal | undefined;
  try {
    await journal.load();
    for (let index = 0; index < 1005; index++) journal.record({ layer: 'engine', kind: 'dispatch.settled', sessionId: 'bounded-session', attemptId: String(index), status: 'completed' });
    assert.equal(journal.snapshot().length, 1000); assert.equal(journal.snapshot()[0].seq, 6);
    journal.setTracing(true);
    const rows = Array.from({ length: 20 }, (_, index) => ({ value: `${privatePrompt}-${index}`, count: 73, flag: true,
      repetitions: Array.from({ length: 20 }, (_, inner) => `${privateEnvironment}-${index}-${inner}`) }));
    for (let index = 0; index < 150; index++) journal.native({ providerId: 'fixture', sessionId: 'bounded-session' }, 'receive', 'runtime', { id: index, result: { rows } });
    await journal.flush();
    const source = await readFile(path, 'utf8');
    assert(Buffer.byteLength(source) <= 512 * 1024); assert(journal.snapshot().length < 1000);
    assert(journal.snapshot().some(entry => entry.protocol !== undefined));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert(!source.includes(privatePrompt)); assert(!source.includes(privateEnvironment));
    const last = journal.snapshot().at(-1)!.seq;
    restored = new DiagnosticJournal(path); await restored.load();
    assert.equal(restored.snapshot().at(-1)?.seq, last);
    restored.record({ layer: 'transport', kind: 'connected', sessionId: 'bounded-session' });
    assert.equal(restored.snapshot().at(-1)?.seq, last + 1);
    await restored.flush(); assert((await stat(path)).size <= 512 * 1024);
  } finally { await journal.flush(); await restored?.flush(); await rm(directory, { recursive: true, force: true }); }
});

test('history controls retain session-scoped native diagnostics after a service restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-diagnostic-controls-'));
  const script = join(directory, 'fixture.mjs'); await writeFile(script, rpcSource);
  const native = async (cwd: string, method: string) => {
    const rpc = new JsonRpcProcess({ command: process.execPath, args: [script], cwd });
    try { await rpc.request(method, { prompt: privatePrompt }); }
    finally { await rpc.close(); }
  };
  const provider: ProviderAdapter = {
    info: { id: 'diagnostic-controls', name: 'Controls fixture', source: 'plugin', available: true,
      detail: '', capabilities: { resume: true, approvals: false, rewind: true } },
    async run() { assert.fail('History controls must not start a model turn'); },
    async reconcileDelivery(session, deliveries) {
      await native(session.cwd, 'thread/read');
      return deliveries.map(delivery => ({ clientUserMessageId: delivery.clientUserMessageId, status: 'accepted', nativeTurnId: 'private-native-turn' }));
    },
    async rewind(session) { await native(session.cwd, 'thread/revert'); },
  };
  const options = { dataPath: join(directory, 'data'), command: process.execPath, bridgePath: join(directory, 'bridge.cjs'), providers: [provider], publish() {} };
  let service = await createWorkbenchService(options);
  try {
    const id = await service.engine.createSession({ title: 'History controls', providerId: provider.info.id, cwd: directory });
    service.store.atomic(state => {
      const session = state.sessions.find(item => item.id === id)!;
      session.externalId = 'private-native-thread';
      session.messages.push({ id: 'user', role: 'user', text: privatePrompt, nativeTurnId: 'private-native-turn', createdAt: '2026-10-23T00:00:00Z',
        delivery: { id: 'delivery', clientUserMessageId: 'user', status: 'unknown', createdAt: '', updatedAt: '' } });
    });
    await service.shutdown(); service = await createWorkbenchService(options);
    await service.call('workbench:set-diagnostic-tracing', [true]);
    await service.call('workbench:reconcile-session-delivery', [id]);
    await service.call('workbench:rewind-session', [id, 'user']);
    const records = await service.call('workbench:diagnostics', []) as DiagnosticEntry[];
    const requests = records.filter(entry => entry.kind === 'rpc.send' && ['thread/read', 'thread/revert'].includes(entry.method ?? ''));
    assert.deepEqual(requests.map(entry => entry.method), ['thread/read', 'thread/revert']);
    for (const request of requests) {
      assert.equal(request.sessionId, id); assert.equal(request.providerId, provider.info.id); assert(request.runtimeId);
      assert(records.some(entry => entry.kind === 'rpc.receive' && entry.runtimeId === request.runtimeId && entry.requestId === request.requestId));
    }
    assert(!JSON.stringify(records).includes(privatePrompt));
  } finally { await service.shutdown(); await rm(directory, { recursive: true, force: true }); }
});
