import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { ApprovalInput } from '../../shared/types';
import { CollaborationServer } from '../collaboration-server';
import { createCursorDescriptor, cursorPermissionDecision, resolveCursorBinary } from './cursor';
import { answerCursorQuestions, approveCursorPlan, cursorInteractions } from './cursor-interactions';
import { createCursorGuard, cursorHookTool } from './cursor-guard';
import type { ProviderEvent, TurnContext } from './types';

function turn(permission: 'review' | 'read-only' = 'review') {
  const events: ProviderEvent[] = [];
  const context: TurnContext = {
    session: { id: 'cursor-session', title: 'Cursor', providerId: 'cursor', cwd: '/project', status: 'running', messages: [], approvals: [],
      createdAt: '', updatedAt: '', settings: { permission } },
    prompt: 'Inspect the project', signal: new AbortController().signal,
    emit: event => events.push(event), approve: async () => { throw new Error('Unexpected approval'); },
  };
  return { context, events };
}

test('Cursor descriptor preserves session MCP injection and rejects unsupported CLI versions and models', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-cursor-descriptor-'));
  const binary = join(directory, 'cursor-agent');
  const version = async (value: string) => writeFile(binary, `#!${process.execPath}\nconsole.log(${JSON.stringify(value)});\n`, { mode: 0o755 });
  let cleanup: (() => Promise<void>) | undefined;
  try {
    await version('2026.10.22-27dcf5f');
    const descriptor = await createCursorDescriptor({ dataPath: directory, binary });
    assert.equal(descriptor.models, undefined); assert.equal(descriptor.defaultModelId, undefined);
    assert.equal(descriptor.tracksDelivery, true);
    assert.equal(descriptor.reportsUsage, false);
    assert.deepEqual(descriptor.sessionModes, { review: 'agent', 'read-only': 'ask' });
    const servers = [{ name: 'project', type: 'http' as const, url: 'http://127.0.0.1/mcp', headers: { Literal: '$value' } }];
    const { context } = turn();
    await assert.rejects(descriptor.launch(context.session, servers), /审批通道/);
    const original = { ...context.session, settings: { permission: 'read-only' as const } };
    const launch = await descriptor.launch(original, servers, context); cleanup = launch.cleanup;
    assert.deepEqual([launch.args[0], launch.args[1], launch.args[3]], ['--disable-project-configs', '--plugin-dir', 'acp']);
    assert.notEqual(launch.env.CURSOR_CONFIG_DIR, process.env.CURSOR_CONFIG_DIR);
    assert.equal(launch.mcpServers, servers);
    await launch.waitUntilReady?.(context.signal);
    assert.equal(descriptor.permissionDecision?.({ toolCallId: 'current-permission', kind: 'edit' }, { ...context.session }, servers), 'ask');
    assert.equal(descriptor.selectModel([{ value: 'native/model', name: 'Native model' }], 'native/model').name, 'Native model');
    assert.throws(() => descriptor.selectModel([{ value: 'native/model', name: 'Native model' }], 'other'), /未提供/);
    await version('2026.09.08-old');
    await assert.rejects(resolveCursorBinary(binary), /2026.10.22/);
  } finally { await cleanup?.(); await rm(directory, { recursive: true, force: true }); }
});

test('Cursor native questions preserve option IDs and multi-select answers without ambiguous labels', async () => {
  const { context } = turn();
  const input = { toolCallId: 'question', questions: [
    { id: 'route', prompt: '选择路径', options: [{ id: 'first', label: '本机' }, { id: 'second', label: '本机' }, { id: 'third', label: '本机 (1)' }] },
    { id: 'scope', prompt: '包含范围', allowMultiple: true, options: [{ id: 'src', label: '源码' }, { id: 'docs', label: '文档' }] },
  ] };
  context.approve = async approval => {
    const [route, scope] = approval.questions!;
    assert.equal(new Set(route.options.map(option => option.label)).size, 3);
    return JSON.stringify({ route: [route.options[1].label], scope: scope.options.map(option => option.label) });
  };
  assert.deepEqual(await answerCursorQuestions(input, context, context.signal), { outcome: { outcome: 'answered', answers: [
    { questionId: 'route', selectedOptionIds: ['second'] }, { questionId: 'scope', selectedOptionIds: ['src', 'docs'] },
  ] } });
  context.approve = async () => JSON.stringify({ route: ['伪造答案'], scope: ['源码'] });
  await assert.rejects(answerCursorQuestions(input, context, context.signal), /不属于/);
  const before = context.approve;
  context.approve = async () => 'cancel';
  assert.deepEqual(await answerCursorQuestions(input, context, context.signal), { outcome: { outcome: 'cancelled' } });
  context.approve = before;
  await assert.rejects(answerCursorQuestions({ ...input, questions: [input.questions[0], input.questions[0]] }, context, context.signal), /重复/);
});

test('Cursor plan approval returns explicit accept, reject or cancellation and does not approve invalid results', async () => {
  const { context } = turn();
  const input = { toolCallId: 'plan', name: '修改计划', overview: '先读取项目', plan: '1. 读取\n2. 修改' };
  let approval: ApprovalInput | undefined;
  context.approve = async value => { approval = value; return 'accept'; };
  assert.deepEqual(await approveCursorPlan(input, context, context.signal), { outcome: { outcome: 'accepted' } });
  assert.match(approval!.detail, /^先读取项目\n\n1\. 读取\n2\. 修改/);
  assert.match(approval!.detail, /~\/.cursor\/plans\//);
  context.approve = async () => 'reject';
  assert.deepEqual(await approveCursorPlan(input, context, context.signal), { outcome: { outcome: 'rejected', reason: '用户拒绝该计划。' } });
  context.approve = async () => 'always';
  assert.deepEqual(await approveCursorPlan(input, context, context.signal), { outcome: { outcome: 'rejected', reason: 'Cursor 计划请求或审批结果无效。' } });
  assert.deepEqual(await approveCursorPlan({ plan: 1 }, context, context.signal), { outcome: { outcome: 'rejected', reason: 'Cursor 计划请求或审批结果无效。' } });
  context.approve = async () => { throw new Error('channel closed'); };
  assert.deepEqual(await approveCursorPlan(input, context, context.signal), { outcome: { outcome: 'rejected', reason: 'Cursor 计划请求或审批结果无效。' } });
  context.session.settings = { permission: 'read-only' };
  context.approve = async value => { assert.deepEqual(value.choices.map(choice => choice.id), ['read', 'close']); assert.match(value.detail, /1\. 读取\n2\. 修改/); return 'read'; };
  assert.deepEqual(await approveCursorPlan(input, context, context.signal), { outcome: { outcome: 'rejected', reason: '只读回合仅展示计划，不创建 Cursor 计划文件。' } });
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await approveCursorPlan(input, context, controller.signal), { outcome: { outcome: 'cancelled' } });
});

test('Cursor vendor updates are acknowledged and merge todos only within their owning turn', async () => {
  const interactions = cursorInteractions();
  const first = turn(); const second = turn();
  const todo = (id: string, content: string, merge: boolean) => ({ toolCallId: id, merge, todos: [{ id, content, status: 'pending' }] });
  const update = interactions.clientRequests!['cursor/update_todos'];
  assert.deepEqual(await update(todo('a', 'First', false), first.context, first.context.signal), {});
  await update(todo('b', 'Second', true), first.context, first.context.signal);
  await update(todo('c', 'Other turn', true), second.context, second.context.signal);
  assert.deepEqual(first.events.filter(event => event.type === 'structured').at(-1)!.event.entries?.map(entry => entry.text), ['First', 'Second']);
  assert.deepEqual(second.events.filter(event => event.type === 'structured').at(-1)!.event.entries?.map(entry => entry.text), ['Other turn']);
  await update({ toolCallId: 'cancelled', todos: [{ id: 'a', content: 'Cancelled item', status: 'cancelled' }], merge: false }, first.context, first.context.signal);
  const cancelled = first.events.filter(event => event.type === 'structured').at(-1)!.event;
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.entries?.[0].status, 'cancelled');
  assert.deepEqual(await interactions.clientRequests!['cursor/task']({ toolCallId: 'child', description: '检查代码', durationMs: 5 }, first.context, first.context.signal), {});
  assert.equal(first.events.filter(event => event.type === 'structured').some(event => event.event.kind === 'subagent'), false);
  assert.match(first.events.filter(event => event.type === 'activity').at(-1)!.text, /检查代码\n耗时：5 ms/);
  assert.deepEqual(await interactions.clientRequests!['cursor/generate_image']({ toolCallId: 'image', description: '生成图标', filePath: '/project/icon.png' }, first.context, first.context.signal), {});
  assert.match(first.events.filter(event => event.type === 'activity').at(-1)!.text, /icon.png/);
});

test('Cursor read-only permissions reject writes and unknown MCP while preserving separately issued collaboration authority', async () => {
  const server = new CollaborationServer(async () => ({}), process.execPath, '/owned/mcp-stdio.cjs');
  await server.start();
  const issued = server.issue({ sessionId: 'cursor-session', attemptId: 'attempt' });
  try {
    const { context } = turn('read-only');
    const policy = (tool: Parameters<typeof cursorPermissionDecision>[0], servers = [issued.config]) => cursorPermissionDecision(tool, context.session, servers);
    assert.equal(policy({ toolCallId: 'read', kind: 'read', rawInput: { path: 'file' } }), 'allow');
    for (const kind of ['execute', 'edit', 'delete', 'switch_mode', 'other'] as const) assert.equal(policy({ toolCallId: kind, kind }), 'deny');
    assert.equal(policy({ toolCallId: 'foreign', kind: 'read', rawInput: { providerIdentifier: 'foreign', toolName: 'read' } }), 'deny');
    const call = { toolCallId: 'platform', kind: 'other' as const, rawInput: { providerIdentifier: 'workbench', toolName: 'get_context' } };
    assert.equal(policy(call), 'allow');
    assert.equal(policy(call, [{ ...issued.config }]), 'deny');
    await issued.cleanup();
    assert.equal(policy(call), 'deny');
    context.session.settings = { permission: 'review' };
    assert.equal(policy({ toolCallId: 'write', kind: 'edit' }), 'ask');
  } finally { await issued.cleanup(); await server.close(); }
});

async function runHook(guard: Awaited<ReturnType<typeof createCursorGuard>>, phase: 'preToolUse' | 'beforeMCPExecution', input: unknown) {
  const manifest = JSON.parse(await readFile(join(guard.pluginDirectory, '.cursor-plugin', 'plugin.json'), 'utf8'));
  const hook = manifest.hooks.hooks[phase][0];
  assert.equal(hook.failClosed, true); assert.equal(hook.timeout, 3600);
  assert.match(hook.command, /ELECTRON_RUN_AS_NODE=1/);
  const child = spawn('/bin/sh', ['-c', hook.command], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.stdin.end(JSON.stringify(input));
  try { const [code] = await once(child, 'close'); assert.equal(code, 0, errors); return JSON.parse(output); }
  finally { clearTimeout(timeout); }
}

test('Cursor private profile keeps native model preferences and hooks enforce approvals without inheriting native allowlists', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble cursor guard-'));
  const source = join(directory, 'user-config'); await mkdir(source);
  const originalDirectory = process.env.CURSOR_CONFIG_DIR;
  t.after(async () => { if (originalDirectory === undefined) delete process.env.CURSOR_CONFIG_DIR; else process.env.CURSOR_CONFIG_DIR = originalDirectory; await rm(directory, { recursive: true, force: true }); });
  const original = JSON.stringify({ model: 'native/default', approvalMode: 'unrestricted', permissions: { allow: ['Shell(*)', 'Write(*)', 'MCP(*)'], deny: ['Shell(rm -rf)'] }, apiKey: 'not-copied' });
  await writeFile(join(source, 'cli-config.json'), original);
  await writeFile(join(source, 'acp-config.json'), JSON.stringify({ selectedModelVariantId: 'native/selected', unused: 'discarded' }));
  process.env.CURSOR_CONFIG_DIR = source;
  const { context } = turn(); let approvals = 0;
  context.approve = async () => { approvals++; return 'allow'; };
  const guard = await createCursorGuard(directory, context.session, [], context, cursorPermissionDecision);
  try {
    const profile = JSON.parse(await readFile(join(guard.configDirectory, 'cli-config.json'), 'utf8'));
    assert.equal(profile.model, 'native/default'); assert.equal(profile.approvalMode, 'allowlist');
    assert.deepEqual(profile.permissions, { allow: [], deny: ['Shell(rm -rf)'] }); assert.equal(profile.apiKey, undefined);
    assert.deepEqual(JSON.parse(await readFile(join(guard.configDirectory, 'acp-config.json'), 'utf8')), { selectedModelVariantId: 'native/selected' });
    assert.equal(await readFile(join(source, 'cli-config.json'), 'utf8'), original);
    const root = dirname(guard.configDirectory);
    for (const path of [join(root, 'connection.json'), join(root, 'guard.mjs'), join(guard.configDirectory, 'cli-config.json'), join(guard.pluginDirectory, '.cursor-plugin', 'plugin.json')]) {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    assert.equal(await realpath(join(guard.configDirectory, 'acp-sessions')), await realpath(join(directory, 'runtimes', 'cursor', 'sessions')));
    await writeFile(join(guard.configDirectory, 'acp-sessions', 'persistence-fixture'), 'session remains after launch cleanup');
    const input = { tool_name: 'Write', tool_input: { file_path: '/project/a', content: 'approved content' }, tool_use_id: 'write' };
    assert.equal((await runHook(guard, 'preToolUse', input)).permission, 'allow'); assert.equal(approvals, 1);
    const changed = cursorHookTool({ ...input, tool_input: { ...input.tool_input, content: 'different content' } });
    assert.equal(guard.permissionDecision(changed), 'ask');
    assert.equal(guard.permissionDecision(cursorHookTool(input)), 'allow');
    assert.equal(guard.permissionDecision(cursorHookTool(input)), 'ask');
    assert.equal((await runHook(guard, 'preToolUse', { ...input, tool_name: 'Shell', tool_use_id: 'shell', tool_input: { command: 'touch file' } })).permission, 'allow');
    assert.equal(approvals, 2);
    assert.equal((await runHook(guard, 'preToolUse', { ...input, tool_name: 'UnrecognizedTool' })).permission, 'deny');
    assert.equal(approvals, 2);
    const mcp = { tool_name: 'publish', tool_use_id: 'mcp-hook', tool_input: JSON.stringify({ value: 'a', nested: { z: 2, a: 1 } }), mcp_server_name: 'foreign' };
    assert.equal((await runHook(guard, 'preToolUse', { ...mcp, tool_name: 'MCP:publish', tool_input: { value: 'a' } })).permission, 'allow');
    assert.equal(approvals, 2);
    assert.equal((await runHook(guard, 'beforeMCPExecution', mcp)).permission, 'allow'); assert.equal(approvals, 3);
    const callback = { ...cursorHookTool(mcp, 'beforeMCPExecution'), toolCallId: 'native-acp-id', rawInput: { providerIdentifier: 'foreign', toolName: 'publish', args: { nested: { a: 1, z: 2 }, value: 'a' } } };
    assert.equal(guard.permissionDecision({ ...callback, rawInput: { ...callback.rawInput, args: { value: 'different' } } }), 'ask');
    assert.equal(guard.permissionDecision(callback), 'allow'); assert.equal(guard.permissionDecision(callback), 'ask');
    const connection = JSON.parse(await readFile(join(root, 'connection.json'), 'utf8'));
    const headers = { Authorization: `Bearer ${connection.token}`, 'X-Ensemble-Hook': 'preToolUse' };
    assert.equal((await fetch(connection.endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://foreign.invalid' }, body: JSON.stringify(input) })).status, 403);
    assert.equal((await fetch(connection.endpoint, { method: 'POST', headers: { ...headers, Authorization: 'Bearer incorrect' }, body: JSON.stringify(input) })).status, 403);
    assert.equal((await runHook(guard, 'preToolUse', { ...input, tool_input: { oversized: 'x'.repeat(256_001) } })).permission, 'deny');
    assert.equal(approvals, 3);
  } finally { await guard.cleanup(); }
  assert.equal(await readFile(join(directory, 'runtimes', 'cursor', 'sessions', 'persistence-fixture'), 'utf8'), 'session remains after launch cleanup');
  await assert.rejects(access(guard.configDirectory));
});

test('Cursor read-only hooks deny writes, shell and unknown MCP, allow native questions, and cancel pending approvals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-cursor-readonly-'));
  const { context } = turn('read-only');
  const collaboration = new CollaborationServer(async () => ({}), process.execPath, '/owned/mcp-stdio.cjs');
  await collaboration.start(); const issued = collaboration.issue({ sessionId: context.session.id, attemptId: 'hook' });
  const guard = await createCursorGuard(directory, context.session, [issued.config], context, cursorPermissionDecision);
  try {
    const input = (name: string) => ({ tool_name: name, tool_input: {}, tool_use_id: name });
    for (const name of ['Write', 'Edit', 'Delete', 'Shell', 'SwitchMode', 'Task', 'Unknown']) assert.equal((await runHook(guard, 'preToolUse', input(name))).permission, 'deny', name);
    for (const name of ['Read', 'Grep', 'List', 'AskQuestion', 'CreatePlan', 'UpdateTodos']) assert.equal((await runHook(guard, 'preToolUse', input(name))).permission, 'allow', name);
    const mcp = { tool_name: 'get_context', tool_use_id: 'mcp', tool_input: '{}', mcp_server_name: 'foreign' };
    assert.equal((await runHook(guard, 'beforeMCPExecution', mcp)).permission, 'deny');
    assert.equal((await runHook(guard, 'beforeMCPExecution', { ...mcp, mcp_server_name: 'workbench' })).permission, 'allow');
    assert.equal((await runHook(guard, 'beforeMCPExecution', { ...mcp, mcp_server_name: 'workbench', tool_name: 'unissued_tool' })).permission, 'deny');
    await issued.cleanup();
    assert.equal((await runHook(guard, 'beforeMCPExecution', { ...mcp, mcp_server_name: 'workbench' })).permission, 'deny');
  } finally { await guard.cleanup(); await issued.cleanup(); await collaboration.close(); }
  const controller = new AbortController(); const pending = turn(); pending.context.signal = controller.signal;
  let ready!: () => void; const approving = new Promise<void>(resolve => { ready = resolve; });
  pending.context.approve = async (_input, signal) => { ready(); return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); };
  const cancellable = await createCursorGuard(directory, pending.context.session, [], pending.context, cursorPermissionDecision);
  try {
    const result = runHook(cancellable, 'preToolUse', { tool_name: 'Write', tool_input: { file_path: '/project/a' }, tool_use_id: 'pending' });
    await approving; controller.abort(); assert.equal((await result).permission, 'deny');
  } finally { await cancellable.cleanup(); }
  const disconnected = turn(); let started!: () => void; let cancelled!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  const revoked = new Promise<void>(resolve => { cancelled = resolve; });
  disconnected.context.approve = async (_input, signal) => { started(); return new Promise((_, reject) => signal!.addEventListener('abort', () => { cancelled(); reject(new Error('disconnected')); }, { once: true })); };
  const channel = await createCursorGuard(directory, disconnected.context.session, [], disconnected.context, cursorPermissionDecision);
  try {
    const input = { tool_name: 'Write', tool_input: { file_path: '/project/a' }, tool_use_id: 'disconnected' };
    const connection = JSON.parse(await readFile(join(dirname(channel.configDirectory), 'connection.json'), 'utf8'));
    const request = new AbortController();
    const result = fetch(connection.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'X-Ensemble-Hook': 'preToolUse' }, body: JSON.stringify(input), signal: request.signal });
    await requested; request.abort(); await assert.rejects(result); await revoked;
    assert.equal(channel.permissionDecision(cursorHookTool(input)), 'ask');
  } finally { await channel.cleanup(); await rm(directory, { recursive: true, force: true }); }
});
