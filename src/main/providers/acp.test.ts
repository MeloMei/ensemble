import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ApprovalInput, Session } from '../../shared/types';
import { createAcpProvider } from './acp';
import type { AcpRuntimeDescriptor } from './acp-types';
import type { ProviderEvent, TurnContext } from './types';

const peerSource = String.raw`
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const mode = process.env.ACP_TEST_MODE;
const trace = process.env.ACP_TEST_TRACE;
const log = value => appendFileSync(trace, JSON.stringify(value) + '\n');
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const respond = (id, result) => send({ id, result });
let sessionId = 'fixture-native';
let promptId;
let permissionAnswered = false;
let cancelled = false;
let model = 'runtime-review';
let reasoning = 'high';
let sessionMode = 'build';
const configOptions = () => [
  { id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: model,
    options: [{ value: 'runtime-free', name: 'Free' }, { value: 'runtime-review', name: 'Review' }] },
  { id: 'reasoning_effort', name: 'Reasoning', type: 'select', currentValue: reasoning,
    options: [{ value: 'high', name: 'High' }, { value: 'low', name: 'Low' }] },
  { id: 'mode', name: 'Mode', type: 'select', category: 'mode', currentValue: sessionMode,
    options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }] },
];
const update = (update, id = sessionId) => send({ method: 'session/update', params: { sessionId: id, update } });
const chunk = (messageId, text, id = sessionId) => update({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } }, id);
const finish = stopReason => { if (promptId !== undefined) { respond(promptId, { stopReason, ...(mode === 'rich' ? {usage:{inputTokens:12,outputTokens:4,totalTokens:16,cachedReadTokens:2}} : {}) }); promptId = undefined; } };
const stream = () => {
  if (mode === 'mode-upgrade') update({ sessionUpdate: 'current_mode_update', currentModeId: 'build' });
  if (mode === 'rich') {
    update({ sessionUpdate: 'tool_call', toolCallId: 'native-tool', title: 'Observed tool', status: 'in_progress', rawInput: { command: 'literal' } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'native-tool', title: null, status: 'completed', rawOutput: 'real tool result' });
    update({ sessionUpdate: 'plan', entries: [{ content: 'native plan', priority: 'medium', status: 'completed' }] });
    update({ sessionUpdate: 'usage_update', used: 12, size: 100 });
    update({ sessionUpdate: 'subagent_update', sessionId: 'native-child', title: 'Child', state: { state: 'running' } });
  }
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private thought' } });
  update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'user echo' } });
  chunk('foreign-message', 'foreign session', 'another-session');
  chunk('message-a', '你好 ');
  chunk('message-b', '另一条');
  chunk('message-a', '世界');
  finish('end_turn');
};
const permission = () => {
  update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Literal command', kind: 'execute', status: 'pending',
    rawInput: { command: 'printf "literal $value"', cwd: '/fixture/project' } });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'in_progress' });
  send({ id: 'foreign-approval', method: 'session/request_permission', params: {
    sessionId: 'another-session', toolCall: { toolCallId: 'foreign-tool', title: 'Foreign' },
    options: [{ optionId: 'foreign-once', name: 'Once', kind: 'allow_once' }],
  } });
  send({ id: 'permission-opaque', method: 'session/request_permission', params: {
    sessionId, toolCall: { toolCallId: 'tool-1', status: 'pending' }, options: [
      { optionId: 'opaque-remember', name: 'Always', kind: 'allow_always' },
      { optionId: 'opaque-allow', name: 'Once', kind: 'allow_once' },
      { optionId: 'opaque-reject', name: 'Reject', kind: 'reject_once' },
    ],
  } });
};
log({ kind: 'spawn', pid: process.pid });
if (mode === 'dispose') {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
  log({ kind: 'descendant', pid: child.pid });
  setInterval(() => {}, 1000);
}
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line); log(frame);
  if (!frame.method) {
    if (frame.id === 'vendor-opaque') { if (cancelled) finish('cancelled'); else stream(); return; }
    if (frame.id === 'form-opaque') { stream(); return; }
    if (frame.id !== 'permission-opaque') return;
    permissionAnswered = true;
    const outcome = frame.result?.outcome;
    if (cancelled || outcome?.outcome === 'cancelled' || outcome?.optionId === 'opaque-reject') finish('cancelled');
    else stream();
    return;
  }
  if (frame.method === 'initialize') {
    respond(frame.id, { protocolVersion: 1, agentInfo: { name: 'controlled-peer', version: '1' },
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} }, ...(mode === 'rich' ? { promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: { http: true } } : {}) } }); return;
  }
  if (['session/new', 'session/resume', 'session/load'].includes(frame.method)) {
    if (mode === 'resume-rejected') { send({ id: frame.id, error: { code: -32602, message: 'saved session unavailable' } }); return; }
    sessionId = frame.params.sessionId || sessionId;
    chunk('history', 'historical output');
    if (mode.startsWith('legacy')) {
      respond(frame.id, { ...(frame.method === 'session/new' ? { sessionId } : {}), models: { currentModelId: model, availableModels: [{ modelId: 'runtime-free', name: 'Free' }, { modelId: 'runtime-review', name: 'Review' }] },
        modes: { currentModeId: sessionMode, availableModes: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }] } }); return;
    }
    respond(frame.id, { ...(frame.method === 'session/new' ? { sessionId } : {}), configOptions: configOptions() }); return;
  }
  if (frame.method === 'session/set_model') {
    if (mode === 'legacy-model-refused') { send({ id: frame.id, error: { code: -32602, message: 'selected model unavailable' } }); return; }
    model = frame.params.modelId; respond(frame.id, {}); return;
  }
  if (frame.method === 'session/set_mode') { sessionMode = frame.params.modeId; chunk('mode-update', '[MODE_UPDATE] ' + sessionMode); respond(frame.id, {}); return; }
  if (frame.method === 'session/set_config_option') {
    if (frame.params.configId === 'model' && mode !== 'unconfirmed') model = frame.params.value;
    if (frame.params.configId === 'reasoning_effort') reasoning = frame.params.value;
    if (frame.params.configId === 'mode' && mode !== 'unconfirmed-mode') sessionMode = frame.params.value;
    respond(frame.id, { configOptions: configOptions() }); return;
  }
  if (frame.method === 'session/close') { respond(frame.id, {}); return; }
  if (frame.method === 'session/cancel') {
    cancelled = true;
    if (permissionAnswered || !['approval', 'dispose', 'vendor-abort'].includes(mode)) finish('cancelled');
    return;
  }
  if (frame.method === 'session/prompt') {
    promptId = frame.id;
    if (mode.startsWith('vendor')) {
      send({ id: 'vendor-opaque', method: 'fixture/confirm', params: { sessionId: mode === 'vendor-foreign' ? 'foreign' : sessionId, title: 'Native extension' } }); return;
    }
    if (mode === 'form') {
      send({ id: 'foreign-form', method: 'elicitation/create', params: { mode: 'form', sessionId: 'another-session', message: 'Foreign question', requestedSchema: { type: 'object', properties: {} } } });
      send({ id: 'form-opaque', method: 'elicitation/create', params: { mode: 'form', sessionId, toolCallId: 'native-question', message: 'Native question', requestedSchema: { type: 'object', properties: {
        q0: { type: 'string', title: 'Route', oneOf: [{ const: 'local', title: '本机' }, { const: 'remote', title: '远程' }] },
        q0_custom: { type: 'string', title: 'Other' },
        q1: { type: 'array', title: 'Scope', items: { anyOf: [{ const: 'src', title: '源码' }, { const: 'docs', title: '文档' }] }, minItems: 1 },
        count: { type: 'integer', minimum: 1, maximum: 20 }, confirmed: { type: 'boolean' },
      }, required: ['q1', 'count', 'confirmed'] } } }); return;
    }
    if (mode === 'exit-zero' || mode === 'exit-error') { process.exit(mode === 'exit-zero' ? 0 : 7); }
    if (mode === 'approval' || mode === 'dispose') { permission(); return; }
    if (mode === 'empty') { finish('end_turn'); return; }
    if (mode === 'limited') { chunk('answer', 'partial output'); finish('max_tokens'); return; }
    stream();
  }
});
process.stdin.on('end', () => { if (mode !== 'dispose') process.exit(0); });
`;

interface WireFrame {
  kind?: string;
  pid?: number;
  id?: string | number;
  method?: string;
  params?: { sessionId?: string; configId?: string; value?: string; prompt?: unknown };
  result?: { outcome?: { outcome?: string; optionId?: string }; action?: string; content?: unknown };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

async function fixture(mode = 'stream') {
  const cwd = await mkdtemp(join(tmpdir(), 'workbench-acp-'));
  const binary = join(cwd, 'peer.mjs');
  const tracePath = join(cwd, 'trace.jsonl');
  await writeFile(binary, peerSource);
  let cleaned = 0;
  const descriptor: AcpRuntimeDescriptor = {
    id: 'controlled', name: 'Controlled ACP', version: 'fixture', detail: 'controlled local peer',
    models: [{ id: 'catalog/free', name: 'Free', free: true }, { id: 'catalog/review', name: 'Review', free: false }],
    defaultModelId: 'catalog/review', reasoningPreference: ['minimal', 'low'],
    async launch() {
      return { command: process.execPath, args: [binary], env: { ACP_TEST_MODE: mode, ACP_TEST_TRACE: tracePath },
        async cleanup() { cleaned++; } };
    },
    selectModel(choices, modelId) {
      const selected = choices.find(choice => choice.value === (modelId === 'catalog/free' ? 'runtime-free' : 'runtime-review'));
      if (!selected) throw new Error('fixture model missing');
      return selected;
    },
  };
  const provider = await createAcpProvider(descriptor.id, descriptor.name, async () => descriptor);
  const events: ProviderEvent[] = [];
  const controller = new AbortController();
  const session: Session = { id: 'owned-session', title: 'Fixture', providerId: descriptor.id, modelId: 'catalog/free', cwd,
    status: 'running', messages: [], approvals: [], createdAt: '', updatedAt: '' };
  const context: TurnContext = { session, prompt: '中文 literal $task', signal: controller.signal,
    emit: event => events.push(event), approve: async () => { throw new Error('unexpected approval'); } };
  const trace = async (): Promise<WireFrame[]> => {
    try { return (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  return { provider, descriptor, context, controller, events, trace, cleaned: () => cleaned,
    async cleanup() { await provider.dispose?.(); await rm(cwd, { recursive: true, force: true }); } };
}

test('ACP native form elicitation uses the user approval UI and returns typed original option values', { timeout: 8000 }, async () => {
  const f = await fixture('form');
  let approvals = 0;
  try {
    f.context.approve = async approval => {
      approvals++;
      assert.equal(approval.title, 'Controlled ACP 需要你的回答');
      assert.equal(approval.detail, 'Native question');
      assert.equal(approval.questions?.[2].multiSelect, true);
      assert.deepEqual(approval.questions?.map(question => question.allowCustomAnswer), [false, true, false, true, false]);
      return JSON.stringify({ 'mcp-0': ['本机'], 'mcp-1': ['（不提供）'], 'mcp-2': ['源码', '文档'], 'mcp-3': ['17'], 'mcp-4': ['是'] });
    };
    await f.provider.run(f.context);
    const frames = await f.trace();
    const capabilities = (frames.find(frame => frame.method === 'initialize')?.params as Record<string, unknown>).clientCapabilities as Record<string, unknown>;
    assert.deepEqual(capabilities.elicitation, { form: {} });
    assert.equal(approvals, 1);
    assert.deepEqual(frames.find(frame => frame.id === 'foreign-form' && !frame.method)?.result, { action: 'cancel' });
    assert.deepEqual(frames.find(frame => frame.id === 'form-opaque' && !frame.method)?.result, { action: 'accept', content: { q0: 'local', q1: ['src', 'docs'], count: 17, confirmed: true } });
    assert.equal(f.context.mcpServers, undefined);
  } finally { await f.cleanup(); }
});

test('ACP legacy model and mode acknowledgments use native catalogs without replaying startup messages', async () => {
  const f = await fixture('legacy');
  try {
    f.descriptor.models = undefined; f.descriptor.defaultModelId = undefined;
    f.descriptor.tracksDelivery = true;
    f.descriptor.sessionModes = { review: 'build', 'read-only': 'plan' };
    f.descriptor.selectModel = (choices, id) => {
      const choice = choices.find(choice => choice.value === id);
      if (!choice) throw new Error('native model unavailable');
      return choice;
    };
    f.context.session.modelId = undefined;
    f.context.session.settings = { permission: 'read-only' };
    await f.provider.refreshInfo();
    assert.equal(Object.hasOwn(f.provider.info, 'models') && f.provider.info.models !== undefined, false);
    await f.provider.run(f.context);
    const frames = await f.trace();
    assert(frames.some(frame => frame.method === 'session/set_model' && (frame.params as any).modelId === 'runtime-review'));
    assert(frames.some(frame => frame.method === 'session/set_mode' && (frame.params as any).modeId === 'plan'));
    assert(!frames.some(frame => frame.method === 'session/set_config_option'));
    assert.deepEqual(f.provider.info.models?.map(model => model.id), ['runtime-free', 'runtime-review']);
    assert.equal(f.provider.info.defaultModelId, undefined);
    assert(f.events.filter(event => event.type === 'text').every(event => !/historical|MODE_UPDATE/.test(event.text)));
    assert(f.events.some(event => event.type === 'delivery' && event.status === 'accepted'));
  } finally { await f.cleanup(); }
});

test('ACP extension requests receive the active context and the exact user reply', async () => {
  const f = await fixture('vendor');
  try {
    let asked = 0;
    f.context.approve = async input => { asked++; assert.equal(input.title, 'Native extension'); return 'confirm'; };
    f.descriptor.clientRequests = { 'fixture/confirm': async (params, context, signal) => {
      assert.equal(context, f.context); assert.equal(signal.aborted, false);
      return { decision: await context.approve({ title: String((params as any).title), detail: '', choices: [{ id: 'confirm', label: 'Confirm' }] }, signal) };
    } };
    await f.provider.run(f.context);
    assert.equal(asked, 1);
    assert.deepEqual((await f.trace()).find(frame => frame.id === 'vendor-opaque' && !frame.method)?.result, { decision: 'confirm' });
  } finally { await f.cleanup(); }
});

test('ACP runtime permission decisions deny operations without asking and delivery failures remain distinguishable', async () => {
  const denied = await fixture('approval');
  try {
    denied.descriptor.permissionDecision = () => 'deny';
    await assert.rejects(denied.provider.run(denied.context), { name: 'AbortError' });
    assert.deepEqual((await denied.trace()).find(frame => frame.id === 'permission-opaque' && !frame.method)?.result,
      { outcome: { outcome: 'selected', optionId: 'opaque-reject' } });
  } finally { await denied.cleanup(); }
  for (const mode of ['unconfirmed', 'exit-error']) {
    const f = await fixture(mode);
    try {
      f.descriptor.tracksDelivery = true;
      await assert.rejects(f.provider.run(f.context));
      const delivery = f.events.filter(event => event.type === 'delivery');
      assert.equal(delivery.some(event => event.status === 'rejected'), mode === 'unconfirmed');
      assert.equal(delivery.some(event => event.status === 'accepted'), false);
    } finally { await f.cleanup(); }
  }
});

test('ACP stops a native mode change that escalates a read-only session', async () => {
  const f = await fixture('mode-upgrade');
  try {
    f.descriptor.sessionModes = { review: 'build', 'read-only': 'plan' };
    f.context.session.settings = { permission: 'read-only' };
    await assert.rejects(f.provider.run(f.context), /改变了只读权限模式/);
    assert((await f.trace()).some(frame => frame.method === 'session/cancel'));
  } finally { await f.cleanup(); }
});

test('ACP refuses to dispatch while a native MCP initialization gate has failed', async () => {
  const f = await fixture();
  const launch = f.descriptor.launch;
  f.descriptor.tracksDelivery = true;
  f.descriptor.launch = async (...args) => ({ ...await launch(...args), async waitUntilReady() { throw new Error('MCP initialization incomplete'); } });
  try {
    await assert.rejects(f.provider.run(f.context), /MCP initialization incomplete/);
    assert(!(await f.trace()).some(frame => frame.method === 'session/prompt'));
    assert(f.events.some(event => event.type === 'delivery' && event.status === 'rejected'));
  } finally { await f.cleanup(); }
});

test('ACP vendor cancellation replies remain protocol results when identity or lifetime guards reject a request', async () => {
  for (const mode of ['vendor-foreign', 'vendor-abort']) {
    const f = await fixture(mode);
    let asked!: () => void;
    const awaitingApproval = new Promise<void>(resolve => { asked = resolve; });
    f.descriptor.clientRequestCancellation = { 'fixture/confirm': { outcome: { outcome: 'cancelled' } } };
    f.descriptor.clientRequests = { 'fixture/confirm': async (_input, context, signal) => ({ result: await context.approve({ title: 'Native', detail: '', choices: [{ id: 'allow', label: 'Allow' }] }, signal) }) };
    f.context.approve = async (_input, signal) => {
      asked();
      return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new Error('approval withdrawn')), { once: true }));
    };
    try {
      const done = f.provider.run(f.context);
      if (mode === 'vendor-abort') {
        const rejected = assert.rejects(done, { name: 'AbortError' });
        await awaitingApproval; f.controller.abort(); await rejected;
      } else await done;
      const frames = await f.trace();
      assert.deepEqual(frames.find(frame => frame.id === 'vendor-opaque' && !frame.method)?.result, { outcome: { outcome: 'cancelled' } });
    } finally { await f.cleanup(); }
  }
});

test('ACP confirms model and reasoning before prompt, resumes the native session and routes message chunks', { timeout: 8000 }, async () => {
  const f = await fixture();
  try {
    f.context.session.externalId = 'saved-native-session';
    await f.provider.run(f.context);
    const frames = await f.trace();
    assert.deepEqual(frames.filter(frame => frame.method).map(frame => frame.method), [
      'initialize', 'session/resume', 'session/set_config_option', 'session/set_config_option', 'session/prompt', 'session/close',
    ]);
    assert.deepEqual(frames.find(frame => frame.method === 'session/resume')?.params,
      { cwd: f.context.session.cwd, mcpServers: [], sessionId: 'saved-native-session' });
    assert.deepEqual(frames.filter(frame => frame.method === 'session/set_config_option').map(frame => frame.params), [
      { sessionId: 'saved-native-session', configId: 'model', value: 'runtime-free' },
      { sessionId: 'saved-native-session', configId: 'reasoning_effort', value: 'low' },
    ]);
    assert.equal(frames.find(frame => frame.method === 'session/prompt')?.params?.sessionId, 'saved-native-session');
    assert.deepEqual(f.events.filter(event => event.type === 'text'), [
      { type: 'text', itemId: 'message-a', text: '你好 ', replace: true },
      { type: 'text', itemId: 'message-b', text: '另一条', replace: true },
      { type: 'text', itemId: 'message-a', text: '你好 世界', replace: true },
    ]);
    assert.deepEqual(f.events.filter(event => event.type === 'external-id'), [{ type: 'external-id', id: 'saved-native-session' }]);
    assert.equal(f.cleaned(), 1);
    assert.equal(getEventListeners(f.context.signal, 'abort').length, 0);
    assert(!alive(frames.find(frame => frame.kind === 'spawn')!.pid!));
  } finally { await f.cleanup(); }
});

test('ACP carries actual attachments and MCP environment, confirms mode, and preserves structured native updates', { timeout: 8000 }, async () => {
  const f = await fixture('rich');
  try {
    f.descriptor.sessionModes = { review: 'build', 'read-only': 'plan' };
    f.context.userMessageId = 'local-user';
    f.context.session.settings = { permission: 'read-only', effort: 'low' };
    const platform = { name: 'workbench', type: 'stdio' as const, command: 'node', args: ['bridge'], env: { ELECTRON_RUN_AS_NODE: '1' } };
    const user = { name: 'user-tools', type: 'stdio' as const, command: 'node', args: ['user-bridge'], env: { ELECTRON_RUN_AS_NODE: '1' } };
    f.context.mcpServers = [platform, user];
    const launch = f.descriptor.launch;
    f.descriptor.launch = async (session, servers) => {
      assert.equal(servers, f.context.mcpServers);
      return { ...await launch(session, servers), mcpServers: [user] };
    };
    f.context.attachments = [
      { id: 'i', name: 'screen.png', kind: 'image', mimeType: 'image/png', size: 3, sha256: 'h', ownedPath: '/owned/screen.png', data: Buffer.from([1, 2, 3]) },
      { id: 't', name: 'note.txt', kind: 'text', mimeType: 'text/plain', size: 4, sha256: 'j', ownedPath: '/owned/a #.txt', data: Buffer.from('real'), text: 'real' },
    ];
    await f.provider.run(f.context);
    const frames = await f.trace();
    const created = frames.find(frame => frame.method === 'session/new')?.params as Record<string, unknown>;
    assert.deepEqual(created.mcpServers, [{ name: 'user-tools', command: 'node', args: ['user-bridge'], env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }] }]);
    assert(frames.some(frame => frame.method === 'session/set_config_option' && frame.params?.configId === 'mode' && frame.params.value === 'plan'));
    const blocks = frames.find(frame => frame.method === 'session/prompt')?.params?.prompt as any[];
    assert.deepEqual(blocks[1], { type: 'image', data: 'AQID', mimeType: 'image/png' });
    assert.equal(blocks[2].type, 'resource'); assert.equal(blocks[2].resource.text, 'real'); assert.match(blocks[2].resource.uri, /a%20%23\.txt$/);
    const tools = f.events.filter(event => event.type === 'structured' && event.event.kind === 'tool');
    assert(tools.some(event => event.type === 'structured' && event.event.title === 'Observed tool' && event.event.status === 'completed' && event.event.output === 'real tool result' && event.event.input?.includes('literal')));
    assert(f.events.some(event => event.type === 'structured' && event.event.kind === 'plan' && event.event.entries?.[0].text === 'native plan'));
    assert(f.events.some(event => event.type === 'usage' && event.usage.scope === 'context' && event.usage.contextUsed === 12 && event.usage.cost === undefined));
    assert(f.events.some(event => event.type === 'usage' && event.usage.scope === 'cumulative' && event.usage.inputTokens === 12 && event.usage.outputTokens === 4 && event.usage.cachedTokens === 2));
  } finally { await f.cleanup(); }
});

test('ACP refuses unsupported images and unconfirmed permission modes before model prompt', { timeout: 8000 }, async () => {
  const unsupported = await fixture();
  try {
    unsupported.context.attachments = [{ id: 'i', name: 'x.png', kind: 'image', mimeType: 'image/png', size: 1, sha256: 'h', ownedPath: '/owned/x.png', data: Buffer.from([1]) }];
    await assert.rejects(unsupported.provider.run(unsupported.context), /未声明图片输入/);
    assert(!(await unsupported.trace()).some(frame => frame.method === 'session/prompt'));
  } finally { await unsupported.cleanup(); }
  const unconfirmed = await fixture('unconfirmed-mode');
  try {
    unconfirmed.descriptor.sessionModes = { review: 'build', 'read-only': 'plan' };
    unconfirmed.context.session.settings = { permission: 'read-only' };
    await assert.rejects(unconfirmed.provider.run(unconfirmed.context), /没有确认权限设置/);
    assert(!(await unconfirmed.trace()).some(frame => frame.method === 'session/prompt'));
  } finally { await unconfirmed.cleanup(); }
});

test('ACP refuses an unconfirmed model without sending a prompt', { timeout: 8000 }, async () => {
  const f = await fixture('unconfirmed');
  try {
    await assert.rejects(f.provider.run(f.context), /未确认所选模型/);
    assert(!(await f.trace()).some(frame => frame.method === 'session/prompt'));
    assert.equal(f.cleaned(), 1);
  } finally { await f.cleanup(); }
});

test('ACP refused resume never creates or closes an unacquired native session', { timeout: 8000 }, async () => {
  const f = await fixture('resume-rejected');
  try {
    f.context.session.externalId = 'missing-native-session';
    await assert.rejects(f.provider.run(f.context), /saved session unavailable/);
    assert.deepEqual((await f.trace()).filter(frame => frame.method).map(frame => frame.method), ['initialize', 'session/resume']);
    assert.equal(f.context.session.externalId, 'missing-native-session');
    assert.equal(f.cleaned(), 1);
  } finally { await f.cleanup(); }
});

test('ACP approvals preserve tool input and expose only exact single-use choices', { timeout: 8000 }, async () => {
  const f = await fixture('approval');
  const approvals: ApprovalInput[] = [];
  try {
    f.context.approve = async input => { approvals.push(input); return 'opaque-allow'; };
    await f.provider.run(f.context);
    assert.equal(approvals.length, 1);
    assert.match(approvals[0].detail, /Literal command/);
    assert.match(approvals[0].detail, /literal \$value/);
    assert.match(approvals[0].detail, /\/fixture\/project/);
    assert.deepEqual(approvals[0].choices.map(({ id, label }) => ({ id, label })), [{ id: 'opaque-allow', label: '允许本次' }, { id: 'opaque-reject', label: '拒绝本次' }]);
    assert.ok(approvals[0].titleI18n?.key);
    assert.ok(approvals[0].choices.every(choice => choice.labelI18n?.key));
    const frames = await f.trace();
    assert.deepEqual(frames.find(frame => frame.id === 'permission-opaque' && !frame.method)?.result,
      { outcome: { outcome: 'selected', optionId: 'opaque-allow' } });
    assert.deepEqual(frames.find(frame => frame.id === 'foreign-approval' && !frame.method)?.result,
      { outcome: { outcome: 'cancelled' } });
  } finally { await f.cleanup(); }
});

test('ACP rejection returns the offered reject id and a cancelled outcome', { timeout: 8000 }, async () => {
  const f = await fixture('approval');
  try {
    f.context.approve = async () => 'opaque-reject';
    await assert.rejects(f.provider.run(f.context), { name: 'AbortError' });
    assert.deepEqual((await f.trace()).find(frame => frame.id === 'permission-opaque' && !frame.method)?.result,
      { outcome: { outcome: 'selected', optionId: 'opaque-reject' } });
  } finally { await f.cleanup(); }
});

test('ACP invalid approval choice remains a failure when the runtime cancels', { timeout: 8000 }, async () => {
  const f = await fixture('approval');
  try {
    f.context.approve = async () => 'opaque-remember';
    await assert.rejects(f.provider.run(f.context), /审批结果不属于运行时提供的选项/);
    assert.deepEqual((await f.trace()).find(frame => frame.id === 'permission-opaque' && !frame.method)?.result,
      { outcome: { outcome: 'cancelled' } });
  } finally { await f.cleanup(); }
});

test('ACP rejects incomplete stop reasons, missing output and process exit without completion', { timeout: 12000 }, async () => {
  for (const mode of ['limited', 'empty', 'exit-zero', 'exit-error']) {
    const f = await fixture(mode);
    try {
      const done = f.provider.run(f.context);
      if (mode === 'limited') await assert.rejects(done, /max_tokens/);
      else if (mode === 'empty') await assert.rejects(done, /没有返回可交接的助手输出/);
      else await assert.rejects(done);
      assert.equal(f.cleaned(), 1);
      assert(!alive((await f.trace()).find(frame => frame.kind === 'spawn')!.pid!));
    } finally { await f.cleanup(); }
  }
});

test('ACP stop cancels an outstanding approval and removes abort listeners', { timeout: 8000 }, async () => {
  const f = await fixture('approval');
  let asked = false;
  let withdrawn = false;
  try {
    f.context.approve = async (_input, signal) => {
      assert(signal);
      asked = true;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        withdrawn = true; reject(new Error('approval withdrawn'));
      }, { once: true }));
    };
    const done = f.provider.run(f.context);
    const rejected = assert.rejects(done, { name: 'AbortError' });
    await waitFor(() => asked, 'approval was not requested');
    f.controller.abort();
    await rejected;
    assert(withdrawn);
    const frames = await f.trace();
    assert(frames.some(frame => frame.method === 'session/cancel'));
    assert.deepEqual(frames.find(frame => frame.id === 'permission-opaque' && !frame.method)?.result,
      { outcome: { outcome: 'cancelled' } });
    assert.equal(getEventListeners(f.context.signal, 'abort').length, 0);
    assert.equal(f.cleaned(), 1);
  } finally { await f.cleanup(); }
});

test('ACP cancellation before launch acquires no resources', async () => {
  const f = await fixture();
  let launches = 0;
  f.descriptor.launch = async () => { launches++; throw new Error('unexpected launch'); };
  try {
    f.controller.abort();
    await assert.rejects(f.provider.run(f.context), { name: 'AbortError' });
    assert.equal(launches, 0);
    assert.equal(f.cleaned(), 0);
    assert.equal(getEventListeners(f.context.signal, 'abort').length, 0);
    assert.deepEqual(await f.trace(), []);
  } finally { await f.cleanup(); }
});

test('ACP cancellation waits for a slow launch cleanup without spawning its runtime', { timeout: 8000 }, async () => {
  const f = await fixture();
  const launch = f.descriptor.launch;
  let release!: () => void;
  const preparing = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  f.descriptor.launch = async (session, servers) => {
    started = true;
    await preparing;
    return launch(session, servers);
  };
  try {
    const done = f.provider.run(f.context);
    const rejected = assert.rejects(done, { name: 'AbortError' });
    await waitFor(() => started, 'launch preparation did not start');
    f.controller.abort();
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.equal(f.cleaned(), 0);
    release();
    await rejected;
    assert.equal(f.cleaned(), 1);
    assert.deepEqual(await f.trace(), []);
    assert.equal(getEventListeners(f.context.signal, 'abort').length, 0);
  } finally { release(); await f.cleanup(); }
});

test('ACP disposal owns a pending launch and never starts its runtime', { timeout: 8000 }, async () => {
  const f = await fixture();
  const launch = f.descriptor.launch;
  let release!: () => void;
  const preparing = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  f.descriptor.launch = async (session, servers) => {
    started = true;
    await preparing;
    return launch(session, servers);
  };
  try {
    const done = f.provider.run(f.context);
    const rejected = assert.rejects(done, { name: 'AbortError' });
    await waitFor(() => started, 'launch preparation did not start');
    const disposed = f.provider.dispose!();
    release();
    await Promise.all([disposed, rejected]);
    assert.equal(f.cleaned(), 1);
    assert.deepEqual(await f.trace(), []);
    assert.equal(getEventListeners(f.context.signal, 'abort').length, 0);
  } finally { release(); await f.cleanup(); }
});

test('ACP dispose withdraws pending approvals and reclaims its process tree', { timeout: 10000 }, async () => {
  const f = await fixture('dispose');
  let asked = false;
  let withdrawn = false;
  try {
    f.context.approve = async (_input, signal) => {
      assert(signal);
      asked = true;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        withdrawn = true; reject(new Error('disposed'));
      }, { once: true }));
    };
    const done = f.provider.run(f.context);
    const rejected = assert.rejects(done);
    await waitFor(() => asked, 'approval was not requested');
    assert(f.provider.dispose);
    await f.provider.dispose();
    await rejected;
    assert(withdrawn);
    const pids = (await f.trace()).filter(frame => frame.kind === 'spawn' || frame.kind === 'descendant').map(frame => frame.pid!);
    assert.equal(pids.length, 2);
    await waitFor(() => pids.every(pid => !alive(pid)), 'ACP process tree remained alive');
    assert.equal(f.cleaned(), 1);
    assert.equal(getEventListeners(f.context.signal, 'abort').length, 0);
    await assert.rejects(f.provider.run(f.context));
  } finally { await f.cleanup(); }
});
