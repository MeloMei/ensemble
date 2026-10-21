import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ApprovalInput, Session } from '../../shared/types';
import { configuredClaudeModels, createClaudeProvider } from './claude';
import type { ProviderEvent, TurnContext } from './types';
import { CollaborationServer } from '../collaboration-server';

const fixture = String.raw`
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('2.1.263 (Claude Code fixture)'); process.exit(0); }
const mode = process.env.CLAUDE_ADAPTER_FIXTURE_MODE;
const trace = process.env.CLAUDE_ADAPTER_FIXTURE_TRACE;
const sessionId = process.argv.find(arg => arg.startsWith('--session-id=') || arg.startsWith('--resume=')).split('=')[1];
const log = value => appendFileSync(trace, JSON.stringify(value) + '\n');
log({ argv: process.argv.slice(2) });
if (process.argv.includes('--mcp-config')) {
  const file = process.argv[process.argv.indexOf('--mcp-config') + 1];
  const mcp = JSON.parse(readFileSync(file, 'utf8'));
  for (const server of Object.values(mcp.mcpServers)) for (const key of Object.keys(server.env ?? {})) if (key !== 'ELECTRON_RUN_AS_NODE') server.env[key] = '[redacted]';
  log({ mcp, mcpMode: statSync(file).mode & 0o777 });
}
const send = frame => process.stdout.write(JSON.stringify({ session_id: sessionId, ...frame }) + '\n');
const partial = (event, uuid, parent_tool_use_id = null) => send({ type: 'stream_event', event, uuid, parent_tool_use_id });
const result = (extra = {}) => send({ type: 'result', subtype: 'success', is_error: false, result: 'Hello world', ...extra });
const text = (messageId, value, parent = null) => {
  partial({ type: 'message_start', message: { id: messageId } }, messageId + '-start', parent);
  partial({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, messageId + '-block', parent);
  partial({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } }, messageId + '-delta', parent);
  send({ type: 'assistant', parent_tool_use_id: parent, message: { id: messageId, content: [{ type: 'text', text: value }] } });
};
const stream = () => {
  partial({ type: 'message_start', message: { id: 'message-1' } }, 'start');
  partial({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, 'thinking');
  partial({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private thinking' } }, 'thinking-delta');
  partial({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, 'text-1');
  partial({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello ' } }, 'delta-1');
  partial({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello ' } }, 'delta-1');
  partial({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }, 'text-2');
  partial({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'world' } }, 'delta-2');
  const content = mode === 'compact-final' ? [{ type: 'text', text: 'Hello world!' }] :
    [{ type: 'thinking', thinking: 'private thinking' }, { type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }];
  send({ type: 'assistant', message: { id: 'message-1', content } });
  result({ result: mode === 'compact-final' ? 'Hello world!' : 'Hello world' });
};
const host = (id, tool_name, input) => send({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name, input, tool_use_id: id } });
let responses = 0;
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line); log(frame);
  if (frame.type === 'control_request') {
    if (frame.request.subtype === 'initialize') {
      send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } }); return;
    }
    if (frame.request.subtype === 'interrupt') {
      send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
      result({ terminal_reason: 'aborted_streaming' }); return;
    }
  }
  if (frame.type === 'control_response') {
    if (mode === 'approval' && ++responses === 2) stream();
    if (mode === 'question' || mode === 'cancel-request' || mode === 'platform-tool') stream();
    return;
  }
  if (frame.type !== 'user') return;
  send({ type: 'system', subtype: 'init', model: 'fixture', cwd: process.cwd(), permissionMode: 'manual' });
  if (mode === 'platform-tool') { host('platform', 'mcp__workbench__get_worker', { sessionId: 'child' }); return; }
  if (mode === 'approval') {
    host('bash-approval', 'Bash', { command: 'fixture command' });
    host('edit-approval', 'Edit', { file_path: '/fixture/a.txt', old_string: 'old', new_string: 'new' }); return;
  }
  if (mode === 'question') {
    host('ask', 'AskUserQuestion', { questions: [
      { question: '输出格式？', header: '格式', options: [{ label: '摘要', description: '简短' }, { label: '详细' }], multiSelect: false },
      { question: '包含哪些部分？', header: '部分', options: [{ label: '开头' }, { label: '结尾' }], multiSelect: true },
    ] }); return;
  }
  if (mode === 'cancel-request') {
    host('withdrawn', 'Bash', { command: 'withdrawn command' });
    setTimeout(() => { send({ type: 'control_cancel_request', request_id: 'withdrawn' }); host('active', 'Bash', { command: 'active command' }); }, 5); return;
  }
  if (mode === 'unknown') { send({ type: 'control_request', request_id: 'unsupported', request: { subtype: 'future_operation' } }); return; }
  if (mode === 'abort') { partial({ type: 'message_start', message: { id: 'waiting' } }, 'waiting'); host('waiting', 'Bash', { command: 'wait' }); return; }
  if (mode === 'failed-success') { result({ is_error: true, errors: ['intentional failure'] }); return; }
  if (mode === 'background-exit') {
    send({ type: 'system', subtype: 'task_started', task_id: 'unfinished-background' });
    send({ type: 'system', subtype: 'session_state_changed', state: 'running' });
    result(); setImmediate(() => process.exit(0)); return;
  }
  if (mode === 'background') {
    send({ type: 'system', subtype: 'task_started', task_id: 'background-1' });
    send({ type: 'system', subtype: 'session_state_changed', state: 'running' });
    text('initial', 'Initial'); result();
    setTimeout(() => {
      text('subagent', 'Subagent output', 'background-tool');
      send({ type: 'system', subtype: 'task_notification', task_id: 'background-1', status: 'completed' });
      text('followup', 'Final followup');
      send({ type: 'system', subtype: 'session_state_changed', state: 'idle' }); result({ result: 'Final followup' });
    }, 10); return;
  }
  if (mode === 'rich') {
    partial({ type: 'message_start', message: { id: 'tool-message' } }, 'tool-start');
    partial({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'native-tool', name: 'Bash', input: {} } }, 'tool-block');
    partial({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"literal"}' } }, 'tool-json');
    partial({ type: 'content_block_stop', index: 0 }, 'tool-stop');
    send({ type: 'assistant', message: { id: 'tool-message', content: [{ type: 'tool_use', id: 'native-tool', name: 'Bash', input: { command: 'literal' } }] } });
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'native-tool', content: 'actual output' }] } });
    send({ type: 'assistant', message: { id: 'todo-message', content: [{ type: 'tool_use', id: 'native-plan', name: 'TodoWrite', input: { todos: [{ content: 'Observed task', status: 'completed' }] } }] } });
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'native-plan', content: 'updated' }] } });
    send({ type: 'system', subtype: 'task_started', task_id: 'native-task', tool_use_id: 'native-child-tool', task_type: 'local_agent', description: 'Observed native child' });
    text('native-child-message', 'Only child output', 'native-child-tool');
    send({ type: 'system', subtype: 'task_notification', task_id: 'native-task', status: 'completed' });
    text('rich-final', 'Main output'); result({ usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 4 } }); return;
  }
  stream();
});
process.stdin.on('end', () => process.exit(mode === 'bad-exit' ? 9 : 0));
`;

type FixtureTurn = TurnContext & { events: ProviderEvent[] };
interface FixtureScope {
  session: Session;
  context(overrides?: Partial<TurnContext>): FixtureTurn;
  records(): Promise<Record<string, any>[]>;
}

async function withFixture(run: (scope: FixtureScope) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-claude-'));
  const binary = join(directory, 'claude.mjs');
  const trace = join(directory, 'trace.jsonl');
  await writeFile(binary, `#!${process.execPath}\n${fixture}`, { mode: 0o755 });
  const saved = { CLAUDE_BINARY: process.env.CLAUDE_BINARY, CLAUDE_ADAPTER_FIXTURE_MODE: process.env.CLAUDE_ADAPTER_FIXTURE_MODE, CLAUDE_ADAPTER_FIXTURE_TRACE: process.env.CLAUDE_ADAPTER_FIXTURE_TRACE };
  process.env.CLAUDE_BINARY = binary; process.env.CLAUDE_ADAPTER_FIXTURE_TRACE = trace;
  const session: Session = { id: 'local', title: 'Fixture', providerId: 'claude', cwd: directory, status: 'running', messages: [], approvals: [], createdAt: '', updatedAt: '' };
  const context = (overrides: Partial<TurnContext> = {}): TurnContext & { events: ProviderEvent[] } => {
    const events: ProviderEvent[] = [];
    return { session, prompt: 'fixture prompt', signal: new AbortController().signal, events, emit: event => events.push(event), approve: async () => { throw new Error('Unexpected approval'); }, ...overrides };
  };
  const records = async (): Promise<Record<string, any>[]> => (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  try {
    await run({ session, context, records });
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  }
}

test('Claude text reconciliation keeps one native message item and ordered text blocks', async () => withFixture(async ({ session, context, records }) => {
  process.env.CLAUDE_ADAPTER_FIXTURE_MODE = 'stream';
  const provider = await createClaudeProvider(); assert.equal(provider.info.available, true);
  const turn = context(); await provider.run(turn);
  const text = turn.events.filter(event => event.type === 'text');
  assert.deepEqual(text.map(event => event.text), ['Hello ', 'Hello world']);
  assert.equal(new Set(text.map(event => event.itemId)).size, 1);
  assert(text[0].itemId.endsWith(':main:message-1'));
  assert(text.every(event => event.replace === true));
  const id = turn.events.find(event => event.type === 'external-id')!;
  assert.equal(id.type, 'external-id');
  const resume = context({ session: { ...session, externalId: id.type === 'external-id' ? id.id : '' } });
  await provider.run(resume);
  const launches = (await records()).filter(record => record.argv);
  assert(launches[1].argv.includes(`--resume=${id.type === 'external-id' ? id.id : ''}`));
  assert(!launches[1].argv.some((arg: string) => arg.startsWith('--session-id=')));
}));

test('Claude text reconciliation replaces compact final snapshots after thinking', async () => withFixture(async ({ context }) => {
  process.env.CLAUDE_ADAPTER_FIXTURE_MODE = 'compact-final';
  const turn = context();
  await (await createClaudeProvider()).run(turn);
  const text = turn.events.filter(event => event.type === 'text');
  assert.deepEqual(text.map(event => event.text), ['Hello ', 'Hello world', 'Hello world!']);
  assert.equal(new Set(text.map(event => event.itemId)).size, 1);
  assert(text[0].itemId.endsWith(':main:message-1'));
  assert(text.every(event => event.replace === true));
  assert(!text.some(event => event.text.includes('private thinking')));
}));

test('Claude text reconciliation separates native messages and subagent channels', async () => withFixture(async ({ context }) => {
  process.env.CLAUDE_ADAPTER_FIXTURE_MODE = 'background';
  const turn = context(); await (await createClaudeProvider()).run(turn);
  const text = turn.events.filter(event => event.type === 'text');
  assert.deepEqual(text.map(event => event.text), ['Initial', 'Final followup']);
  assert.equal(new Set(text.map(event => event.itemId)).size, 2);
  assert(turn.events.some(event => event.type === 'structured' && event.event.kind === 'subagent' && event.event.nativeId === 'background-tool' && event.event.output === 'Subagent output' && event.event.status === 'completed'));
}));

test('Claude sends typed attachments, preserves MCP env and reports native tools, tasks, child channels and usage', async () => withFixture(async ({ session, context, records }) => {
  process.env.CLAUDE_ADAPTER_FIXTURE_MODE = 'rich';
  const turn = context({ userMessageId: 'local-message', session: { ...session, modelId: 'haiku', settings: { effort: 'low' } },
    attachments: [
      { id: 'i', name: 'screen.png', kind: 'image', mimeType: 'image/png', size: 3, sha256: 'h', ownedPath: '/owned/screen.png', data: Buffer.from([1, 2, 3]) },
      { id: 't', name: 'note.txt', kind: 'text', mimeType: 'text/plain', size: 4, sha256: 'j', ownedPath: '/owned/note.txt', data: Buffer.from('real'), text: 'real' },
    ], mcpServers: [{ name: 'workbench', type: 'stdio', command: 'node', args: ['bridge'], env: { ELECTRON_RUN_AS_NODE: '1' } }] });
  await (await createClaudeProvider()).run(turn);
  const rows = await records(); const argv = rows.find(record => record.argv)!.argv as string[];
  assert.equal(argv[argv.indexOf('--effort') + 1], 'low');
  assert.equal(argv[argv.indexOf('--model') + 1], 'haiku');
  const configuration = rows.find(record => record.mcp)!;
  assert.equal(configuration.mcp.mcpServers.workbench.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(configuration.mcpMode, 0o600);
  assert(!argv.join(' ').includes('ELECTRON_RUN_AS_NODE'));
  await assert.rejects(readFile(argv[argv.indexOf('--mcp-config') + 1]), { code: 'ENOENT' });
  const sent = rows.find(record => record.type === 'user');
  assert.equal(sent!.uuid, 'local-message');
  assert.deepEqual(sent!.message.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } });
  assert.match(sent!.message.content[2].text, /real/);
  assert(turn.events.some(event => event.type === 'structured' && event.event.kind === 'tool' && event.event.status === 'completed' && event.event.input?.includes('literal') && event.event.output === 'actual output'));
  assert(turn.events.some(event => event.type === 'structured' && event.event.kind === 'plan' && event.event.entries?.[0].text === 'Observed task'));
  assert(turn.events.some(event => event.type === 'structured' && event.event.kind === 'subagent' && event.event.nativeId === 'native-child-tool' && event.event.status === 'completed' && event.event.output === 'Only child output'));
  assert(!turn.events.some(event => event.type === 'text' && event.text.includes('Only child output')));
  assert(turn.events.some(event => event.type === 'usage' && event.usage.scope === 'turn' && event.usage.inputTokens === 12 && event.usage.cost === undefined));
}));

test('Claude preapproves only the live issued platform identity in read-only mode', async () => withFixture(async ({ session, context, records }) => {
  process.env.CLAUDE_ADAPTER_FIXTURE_MODE = 'platform-tool';
  const service = new CollaborationServer(async () => ({}), process.execPath, 'bridge');
  await service.start();
  const issued = service.issue({ sessionId: 'parent', attemptId: 'one' });
  const provider = await createClaudeProvider();
  try {
    await provider.run(context({ session: { ...session, settings: { permission: 'read-only' } }, mcpServers: [issued.config] }));
    await provider.run(context({ session: { ...session, settings: { permission: 'read-only' } }, mcpServers: [structuredClone(issued.config)] }));
    const responses = (await records()).filter(record => record.type === 'control_response').map(record => record.response.response.behavior);
    assert.deepEqual(responses, ['allow', 'deny']);
  } finally { await issued.cleanup(); await service.close(); }
}));

test('Claude read-only mode denies unverified write tools without asking the user to override it', async () => withFixture(async ({ session, context, records }) => {
  process.env.CLAUDE_ADAPTER_FIXTURE_MODE = 'approval';
  const turn = context({ session: { ...session, settings: { permission: 'read-only' } } });
  await (await createClaudeProvider()).run(turn);
  const rows = await records(); const argv = rows.find(record => record.argv)!.argv as string[];
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'plan');
  const decisions = rows.filter(record => record.type === 'control_response');
  assert.equal(decisions.length, 2); assert(decisions.every(record => record.response.response.behavior === 'deny'));
}));

test('Claude CLI adapter handles its independent streaming and control protocol', async t => withFixture(async ({ context, records }) => {
    await t.test('sends reviewed Bash and Edit decisions with their exact original inputs', async () => {
      process.env.CLAUDE_ADAPTER_FIXTURE_MODE = 'approval';
      const approvals: ApprovalInput[] = [];
      await (await createClaudeProvider()).run(context({ approve: async input => { approvals.push(input); return input.detail.includes('fixture command') ? 'decline' : 'accept'; } }));
      assert.equal(approvals.length, 2); assert.match(approvals[1].detail, /old_string/); assert.match(approvals[1].detail, /new_string/);
      const replies = (await records()).filter(record => record.type === 'control_response').map(record => record.response);
      assert.equal(replies.find(reply => reply.request_id === 'bash-approval').response.behavior, 'deny');
      assert.deepEqual(replies.find(reply => reply.request_id === 'edit-approval').response.updatedInput, { file_path: '/fixture/a.txt', old_string: 'old', new_string: 'new' });
    });
    await t.test('maps question ids to question text while preserving labels and free text', async () => {
      process.env.CLAUDE_ADAPTER_FIXTURE_MODE = 'question';
      await (await createClaudeProvider()).run(context({ approve: async input => {
        assert.deepEqual(input.choices, []); assert.equal(input.questions?.length, 2);
        return JSON.stringify({ [input.questions![0].id]: ['自定义格式'], [input.questions![1].id]: ['开头', '结尾'] });
      } }));
      const reply = (await records()).find(record => record.type === 'control_response' && record.response.request_id === 'ask')!;
      assert.deepEqual(reply.response.response.updatedInput.answers, { '输出格式？': '自定义格式', '包含哪些部分？': ['开头', '结尾'] });
      assert.equal(reply.response.response.updatedInput.questions.length, 2);
    });
    await t.test('withdraws one pending approval without answering it or cancelling its peer', async () => {
      process.env.CLAUDE_ADAPTER_FIXTURE_MODE = 'cancel-request';
      let withdrawn = false;
      await (await createClaudeProvider()).run(context({ approve: async (input, signal) => {
        if (input.detail.includes('withdrawn command')) return new Promise(resolve => signal!.addEventListener('abort', () => { withdrawn = true; resolve('accept'); }, { once: true }));
        return 'accept';
      } }));
      assert(withdrawn);
      const replies = (await records()).filter(record => record.type === 'control_response');
      assert(!replies.some(record => record.response.request_id === 'withdrawn'));
      assert(replies.some(record => record.response.request_id === 'active'));
    });
    await t.test('interrupts cancelled work and rejects unsupported controls', async () => {
      process.env.CLAUDE_ADAPTER_FIXTURE_MODE = 'abort';
      const controller = new AbortController();
      await assert.rejects((await createClaudeProvider()).run(context({ signal: controller.signal, approve: async (_input, signal) => {
        controller.abort();
        if (signal?.aborted) throw new Error('aborted');
        return 'decline';
      } })), { name: 'AbortError' });
      assert((await records()).some(record => record.type === 'control_request' && record.request.subtype === 'interrupt'));
      process.env.CLAUDE_ADAPTER_FIXTURE_MODE = 'unknown';
      await assert.rejects((await createClaudeProvider()).run(context()), /future_operation/);
    });
    await t.test('requires both a successful result and a clean process exit', async () => {
      process.env.CLAUDE_ADAPTER_FIXTURE_MODE = 'failed-success';
      await assert.rejects((await createClaudeProvider()).run(context()), /intentional failure/);
      process.env.CLAUDE_ADAPTER_FIXTURE_MODE = 'bad-exit';
      await assert.rejects((await createClaudeProvider()).run(context()), /退出 9/);
    });
    await t.test('rejects a clean exit with unfinished background work', async () => {
      process.env.CLAUDE_ADAPTER_FIXTURE_MODE = 'background-exit';
      await assert.rejects((await createClaudeProvider()).run(context()), /未成功完成任务（退出 0）/);
    });
}));

test('Claude model catalog uses only configured official aliases and does not invent access or expose credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-claude-catalog-'));
  const settings = join(directory, 'settings.json');
  try {
    await writeFile(settings, JSON.stringify({ model: 'haiku', env: { ANTHROPIC_AUTH_TOKEN: 'fixture-secret', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash', ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash[1M]' } }));
    const models = await configuredClaudeModels(settings);
    assert.deepEqual(models.map(model => model.id), ['haiku', 'sonnet']);
    assert.equal(models[0].name, 'Haiku → deepseek-v4-flash');
    assert(models.every(model => model.free === false));
    assert(!JSON.stringify(models).includes('fixture-secret'));
    assert(!models.some(model => model.id === 'opus'));
    await writeFile(settings, JSON.stringify({ env: {} }));
    assert.deepEqual(await configuredClaudeModels(settings), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
