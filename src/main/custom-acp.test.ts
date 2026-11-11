import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createWorkbenchService } from './workbench-service';

const fakeAgent = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const log = value => fs.appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify(value) + '\n');
const write = record => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...record }) + '\n');
const reply = (id, result) => write({ id, result });
const sessionId = 'fixture-acp-session';
let promptRequest;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params, result } = JSON.parse(line);
  if (method) log({ method, pid: process.pid });
  if (method === 'initialize') {
    if (process.argv[2] === 'hang') { setInterval(() => {}, 1000); return; }
    if (params.protocolVersion !== 1 || params.clientCapabilities.terminal) process.exit(3);
    process.stderr.write(process.env.FIXTURE_SECRET + '\n');
    write({ bogus: process.env.FIXTURE_SECRET });
    reply(process.env.FIXTURE_SECRET, { ignored: true });
    reply(id, { protocolVersion: process.argv[2] === 'bad-version' ? 2 : 1, agentCapabilities: {
      loadSession: true, promptCapabilities: { image: false }, _meta: { forbidden: process.env.FIXTURE_SECRET },
    } });
  } else if (method === 'session/new') {
    reply(id, { sessionId, modes: { currentModeId: 'unrecognized', availableModes: [{ id: 'unrecognized', name: 'Vendor mode' }] } });
  } else if (method === 'session/prompt') {
    if (params.prompt[0]?.text !== 'Controlled ACP input' || process.argv[2] !== 'literal ; $(no-shell)') process.exit(4);
    promptRequest = id;
    write({ method: 'session/request_permission', id: 'approval', params: {
      sessionId, toolCall: { toolCallId: 'test-tool', title: 'Check ' + process.env.FIXTURE_SECRET },
      options: [{ optionId: 'allow-' + process.env.FIXTURE_SECRET, name: 'Allow', kind: 'allow_once' }],
    } });
  } else if (id === 'approval') {
    if (result?.outcome?.optionId !== 'allow-' + process.env.FIXTURE_SECRET) process.exit(5);
    write({ method: 'session/update', params: { sessionId, update: { malformed: process.env.FIXTURE_SECRET } } });
    write({ method: 'session/update', params: { sessionId, update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Controlled ACP output ' + process.env.FIXTURE_SECRET },
    } } });
    reply(promptRequest, { stopReason: 'end_turn' });
  }
});`;

async function until<T>(read: () => T | Promise<T>): Promise<NonNullable<T>> {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (value) return value;
    await delay(10);
  }
  throw new Error('ACP fixture did not reach the expected state');
}

test('custom ACP installs through a private initialize probe, delivers through ACP and preserves history when removed', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ensemble-custom-acp-')));
  const dataPath = join(root, 'data');
  const script = join(root, 'fixture.cjs');
  const trace = join(root, 'trace.jsonl');
  const secret = 'fixture[a].$private';
  const errors = t.mock.method(console, 'error', () => {});
  const environment = [{ key: 'FIXTURE_SECRET', value: secret }, { key: 'FIXTURE_TRACE', value: trace }];
  const options = { dataPath, command: process.execPath, bridgePath: join(root, 'bridge.cjs'), publish() {}, providers: [] };
  let service: Awaited<ReturnType<typeof createWorkbenchService>> | undefined;
  await writeFile(script, fakeAgent);
  const project = join(root, 'project');
  await mkdir(project);
  const readTrace = async () => (await readFile(trace, 'utf8').catch(() => '')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { method: string; pid: number });
  const input = { name: 'Local test Agent', command: process.execPath, args: [script, 'literal ; $(no-shell)'], environment };
  try {
    service = await createWorkbenchService(options);
    await assert.rejects(service.call('workbench:add-custom-acp', [randomUUID(), { ...input, command: 'node' }]), /绝对路径/);
    assert.deepEqual(await readTrace(), []);
    await assert.rejects(service.call('workbench:add-custom-acp', [randomUUID(), { ...input, args: [script, 'bad-version'] }]), /协议版本/);

    const request = randomUUID();
    const pending = assert.rejects(service.call('workbench:add-custom-acp', [request, { ...input, args: [script, 'hang'] }]), /取消|停止|abort/i);
    const hanging = await until(async () => (await readTrace())[1]);
    await service.call('workbench:cancel-custom-acp', [request]);
    await pending;
    assert.throws(() => process.kill(hanging.pid, 0), { code: 'ESRCH' });
    assert.deepEqual(service.snapshot().providers, []);

    await service.call('workbench:add-custom-acp', [randomUUID(), input]);
    const provider = service.snapshot().providers[0];
    assert.equal(provider.source, 'acp');
    assert.equal(provider.capabilities.resume, true);
    assert.equal(provider.capabilities.images, false);
    assert.deepEqual(provider.capabilities.permissionTiers, ['review']);
    assert.deepEqual((await readTrace()).map(entry => entry.method), ['initialize', 'initialize', 'initialize']);
    const configRoot = join(dataPath, 'acp-runtimes');
    const [name] = await readdir(configRoot);
    const config = join(configRoot, name);
    if (process.platform !== 'win32') assert.equal((await stat(config)).mode & 0o777, 0o600);
    const saved = JSON.parse(await readFile(config, 'utf8'));
    assert.deepEqual(saved.input.environment, environment);
    assert.equal(saved.agentCapabilities.loadSession, true);
    assert.equal(saved.agentCapabilities._meta, undefined);
    assert(!JSON.stringify(service.snapshot()).includes(secret));

    await service.shutdown();
    service = await createWorkbenchService(options);
    assert.equal((await readTrace()).length, 3);
    const id = await service.engine.createSession({ title: 'Controlled chat', cwd: project, providerId: provider.id });
    await service.call('workbench:send-prompt', [id, { text: 'Controlled ACP input' }]);
    const approval = await until(() => service!.engine.getSession(id).approvals[0]);
    assert.equal(approval.detail, 'Check [redacted]');
    assert(!JSON.stringify(approval).includes(secret));
    await assert.rejects(service.call('workbench:remove-custom-acp', [provider.id]), /结束.*任务/);
    await service.call('workbench:decide-approval', [approval.id, approval.choices[0].id]);
    await service.engine.waitSession(id);
    const completed = service.engine.getSession(id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.messages.find(message => message.role === 'user')?.delivery?.status, 'accepted');
    assert.equal(completed.messages.find(message => message.role === 'assistant')?.text, 'Controlled ACP output [redacted]');
    assert(!JSON.stringify(await service.call('workbench:diagnostics', [])).includes(secret));
    assert(!JSON.stringify(errors.mock.calls).includes(secret));
    await service.call('workbench:remove-custom-acp', [provider.id]);
    assert.deepEqual(service.snapshot().providers, []);
    assert.deepEqual(await readdir(configRoot), []);
    assert.deepEqual(service.engine.getSession(id), completed);
  } finally { await service?.shutdown(); await rm(root, { recursive: true, force: true }); }
});
