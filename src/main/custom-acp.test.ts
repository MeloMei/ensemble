import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { RuntimeCommand } from '../shared/types';
import { createWorkbenchService } from './workbench-service';

const fakeAgent = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const log = value => fs.appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify(value) + '\n');
const write = record => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...record }) + '\n');
const reply = (id, result) => write({ id, result });
const sessionId = 'fixture-acp-session';
const commands = (session, name, description) => write({ method: 'session/update', params: { sessionId: session, update: {
  sessionUpdate: 'available_commands_update', availableCommands: [{ name, description, input: { hint: 'target' } }],
} } });
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
  } else if (method === 'session/new' || method === 'session/load') {
    if (process.argv[2] === 'slash') {
      commands('foreign-session', 'foreign', 'Ignore');
      commands(sessionId, method === 'session/new' ? 'inspect' : 'resume-inspect', 'Inspect ' + process.env.FIXTURE_SECRET);
    }
    reply(id, { ...(method === 'session/new' ? { sessionId } : {}), modes: { currentModeId: 'unrecognized', availableModes: [{ id: 'unrecognized', name: 'Vendor mode' }] } });
  } else if (method === 'session/prompt') {
    if (process.argv[2] === 'slash') log({ prompt: params.prompt[0]?.text });
    else if (params.prompt[0]?.text !== 'Controlled ACP input' || process.argv[2] !== 'literal ; $(no-shell)') process.exit(4);
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

test('slash completion catalogs follow the native session and queued Skills enrich only their own prompt', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ensemble-slash-acp-')));
  const script = join(root, 'fixture.cjs');
  const trace = join(root, 'trace.jsonl');
  const skillDir = join(root, '.agents', 'skills', 'review-sample');
  const skillContent = '---\nname: review-sample\ndescription: Fixture Skill\n---\nReview the controlled sample.';
  const catalogs: (RuntimeCommand[] | undefined)[] = [];
  const options = {
    dataPath: join(root, 'data'), command: process.execPath, bridgePath: join(root, 'bridge.cjs'), providers: [],
    publish: (snapshot: ReturnType<Awaited<ReturnType<typeof createWorkbenchService>>['snapshot']>) => {
      if (snapshot.sessions[0]) catalogs.push(snapshot.sessions[0].runtimeCommands);
    },
  };
  let service: Awaited<ReturnType<typeof createWorkbenchService>> | undefined;
  try {
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), skillContent);
    await writeFile(script, fakeAgent);
    service = await createWorkbenchService(options);
    await service.call('workbench:add-custom-acp', [randomUUID(), {
      name: 'Slash fixture', command: process.execPath, args: [script, 'slash'],
      environment: [{ key: 'FIXTURE_SECRET', value: 'local-fixture-secret' }, { key: 'FIXTURE_TRACE', value: trace }],
    }]);
    const providerId = service.snapshot().providers[0].id;
    const id = await service.engine.createSession({ title: 'Slash test', cwd: root, providerId });
    const workspaceId = service.snapshot().workspaces.find(item => item.cwd === root)!.id;
    const list = await service.call('workbench:list-skills', [workspaceId]) as { id: string; name: string }[];
    const { id: skillId, name } = list.find(skill => skill.name === 'review-sample')!;
    const skills = [{ id: skillId, name }];
    const snapshot = () => service!.snapshot().sessions.find(session => session.id === id)!;
    await service.call('workbench:save-session-draft', [id, { text: '', skills }]);
    await service.shutdown();
    service = await createWorkbenchService(options);
    assert.deepEqual(snapshot().draft, { text: '', skills });
    assert.equal(snapshot().runtimeCommands, undefined);

    const approve = async (previousId?: string) => {
      const approval = await until(() => snapshot().approvals.find(item => item.id !== previousId));
      await service!.call('workbench:decide-approval', [approval.id, approval.choices[0].id]);
      return approval.id;
    };
    await service.call('workbench:send-prompt', [id, { text: '/inspect first target' }]);
    await until(() => snapshot().approvals[0]);
    assert.deepEqual(snapshot().runtimeCommands, [{ name: 'inspect', description: 'Inspect [redacted]', inputHint: 'target' }]);
    const followUp = { text: 'Review the sample', skills };
    await service.call('workbench:save-session-draft', [id, followUp]);
    await service.call('workbench:send-prompt', [id, followUp]);
    assert.deepEqual(snapshot().queue?.[0].input, followUp);
    assert.equal(snapshot().draft, undefined);
    const beforeReconnect = catalogs.length;
    const previousApproval = await approve();
    await approve(previousApproval);
    await service.engine.waitSession(id);
    assert.equal(snapshot().status, 'completed');
    assert.deepEqual(snapshot().runtimeCommands, [{ name: 'resume-inspect', description: 'Inspect [redacted]', inputHint: 'target' }]);
    const sinceReconnect = catalogs.slice(beforeReconnect);
    const resumed = sinceReconnect.findIndex(catalog => catalog?.some(command => command.name === 'resume-inspect'));
    assert(resumed > 0 && sinceReconnect.slice(0, resumed).includes(undefined));
    assert.equal(snapshot().settings?.skillIds, undefined);
    assert.deepEqual(snapshot().messages.filter(message => message.role === 'user').map(message => message.skills), [undefined, skills]);
    const prompts = (await readFile(trace, 'utf8')).trim().split('\n').flatMap(line => {
      const { prompt } = JSON.parse(line);
      return typeof prompt === 'string' ? [prompt] : [];
    });
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0], '/inspect first target');
    assert.equal(prompts[1], `Review the sample\n\n<selected_skill name="review-sample" source=${JSON.stringify(join(skillDir, 'SKILL.md'))}>\n${skillContent}\n</selected_skill>`);
  } finally { await service?.shutdown(); await rm(root, { recursive: true, force: true }); }
});
