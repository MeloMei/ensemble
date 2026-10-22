import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchEngine, validateWorkflow } from './engine';
import { StateStore } from './store';
import { CollaborationCore } from './collaboration-core';
import { buildCodexLink } from './codex-link';
import type { ProviderAdapter, TurnContext } from './providers/types';
import { answerFormElicitation } from './providers/form-elicitation';

async function fixture(run: (context: TurnContext) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'workbench-engine-'));
  const store = new StateStore(join(cwd, 'state.json'));
  const engine = new WorkbenchEngine(store, join(cwd, 'plugins'), () => {});
  new CollaborationCore(store, engine);
  const adapter: ProviderAdapter = {
    info: { id: 'test', name: 'Test', source: 'plugin', available: true, detail: 'fixture', capabilities: { approvals: true, resume: true } }, run,
  };
  engine.setProviders([adapter], [], []);
  return { cwd, store, engine };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('state did not settle');
}

test('closed approval choices reject custom answers without consuming the pending request', async () => {
  let formResult: unknown;
  let nativeAnswer: string | undefined;
  const { engine, cwd } = await fixture(async context => {
    formResult = await answerFormElicitation({
      type: 'object', required: ['confirmed', 'target', 'note'], properties: {
        confirmed: { type: 'boolean' },
        target: { type: 'string', enum: ['workspace'], enumNames: ['Workspace'] },
        folders: { type: 'array', items: { type: 'string', enum: ['src'], enumNames: ['Source'] } },
        note: { type: 'string' },
      },
    }, 'MCP form', '', context);
    nativeAnswer = await context.approve({ title: 'Native question', detail: '', choices: [], questions: [{
      id: 'format', header: 'Format', question: 'Which format?', options: [{ label: 'Short' }], multiSelect: false,
    }] });
  });
  try {
    const id = await engine.createSession({ title: 'answers', providerId: 'test', cwd });
    engine.sendPrompt(id, { text: 'ask' });
    await until(() => engine.getSession(id).approvals.length === 1);
    const approval = engine.getSession(id).approvals[0];
    const answer = { 'mcp-0': ['Yes'], 'mcp-1': ['Workspace'], 'mcp-2': ['Source'], 'mcp-3': ['Keep this custom answer'] };
    assert.throws(() => engine.answerQuestions(approval.id, answer));
    assert.equal(engine.getSession(id).status, 'waiting_approval');
    assert.equal(engine.getSession(id).approvals[0]?.id, approval.id);
    engine.answerQuestions(approval.id, { ...answer, 'mcp-0': ['是'] });
    await until(() => engine.getSession(id).approvals[0]?.id !== approval.id && engine.getSession(id).approvals.length === 1);
    assert.deepEqual(formResult, { action: 'accept', content: { confirmed: true, target: 'workspace', folders: ['src'], note: 'Keep this custom answer' } });
    engine.answerQuestions(engine.getSession(id).approvals[0].id, { format: ['Free-form native answer'] });
    await engine.waitSession(id);
    assert.equal(engine.getSession(id).status, 'completed');
    assert.deepEqual(JSON.parse(nativeAnswer!), { format: ['Free-form native answer'] });
  } finally { await engine.shutdown(); await rm(cwd, { recursive: true, force: true }); }
});

test('workflow waits for dependencies and passes their actual output', async () => {
  const prompts: string[] = [];
  const { engine, cwd, store } = await fixture(async context => {
    prompts.push(context.prompt);
    context.emit({ type: 'text', itemId: 'one', text: prompts.length === 1 ? 'first result' : 'second result' });
  });
  const id = await engine.createWorkflow({ name: 'pipeline', cwd, steps: [
    { id: 'second', title: 'second', providerId: 'test', prompt: 'review', dependsOn: ['first'] },
    { id: 'first', title: 'first', providerId: 'test', prompt: 'analyze', dependsOn: [] },
  ] });
  engine.startWorkflow(id);
  await until(() => engine.snapshot().workflows[0].status === 'completed');
  assert.match(prompts[0], /\n\nanalyze\n\n/);
  assert.match(prompts[1], /first result/);
  assert.equal(engine.snapshot().sessions.length, 2);
  await engine.shutdown();
  const saved = new StateStore(store.path); await saved.load();
  assert.equal(saved.state.workflows[0].status, 'completed'); await saved.close();
});

test('model selection validates catalogs, dispatches dependent steps and survives restart', async () => {
  const turns: { modelId?: string; prompt: string }[] = [];
  const { engine, cwd, store } = await fixture(async () => {});
  const adapter: ProviderAdapter = {
    info: { id: 'catalog', name: 'Catalog', source: 'builtin', available: true, detail: 'fixture',
      capabilities: { approvals: true, resume: true }, defaultModelId: 'fast',
      models: [{ id: 'fast', name: 'Fast', free: true }, { id: 'review', name: 'Review', free: false }] },
    async run(context) {
      turns.push({ modelId: context.session.modelId, prompt: context.prompt });
      context.emit({ type: 'text', itemId: 'result', text: `${context.session.modelId} result` });
    },
  };
  engine.setProviders([adapter, {
    info: { id: 'codex', name: 'Codex', source: 'builtin', available: true, detail: 'fixture', capabilities: { approvals: true, resume: true } },
    async run() {},
  }], [], []);
  try {
    await assert.rejects(engine.createSession({ title: 'invalid', providerId: 'catalog', cwd, modelId: 'unknown' }), /模型/);
    await assert.rejects(engine.createSession({ title: 'invalid', providerId: 'codex', cwd, modelId: 'invented' }), /模型/);
    await assert.rejects(engine.createWorkflow({ name: 'invalid', cwd, steps: [
      { id: 'a', title: 'a', providerId: 'catalog', modelId: 'unknown', prompt: 'x', dependsOn: [] },
    ] }), /模型/);
    assert.equal(engine.snapshot().sessions.length, 0);
    assert.equal(engine.snapshot().workflows.length, 0);
    const explicit = await engine.createSession({ title: 'chosen', providerId: 'catalog', cwd, modelId: 'review' });
    const defaulted = await engine.createSession({ title: 'default', providerId: 'catalog', cwd });
    const native = await engine.createSession({ title: 'native default', providerId: 'codex', cwd });
    const workflowId = await engine.createWorkflow({ name: 'models', cwd, steps: [
      { id: 'second', title: 'second', providerId: 'catalog', modelId: 'review', prompt: 'review', dependsOn: ['first'] },
      { id: 'first', title: 'first', providerId: 'catalog', prompt: 'analyze', dependsOn: [] },
    ] });
    adapter.info.defaultModelId = 'review';
    engine.startWorkflow(workflowId);
    await until(() => engine.snapshot().workflows.find(workflow => workflow.id === workflowId)?.status === 'completed');
    assert.deepEqual(turns.map(turn => turn.modelId), ['fast', 'review']);
    assert.match(turns[0].prompt, /\n\nanalyze\n\n/);
    assert.match(turns[1].prompt, /fast result/);
    await store.flush();
    await engine.shutdown();
    const restored = new StateStore(store.path);
    await restored.load();
    assert.equal(restored.state.sessions.find(session => session.id === explicit)?.modelId, 'review');
    assert.equal(restored.state.sessions.find(session => session.id === defaulted)?.modelId, 'fast');
    assert.equal(restored.state.sessions.find(session => session.id === native)?.modelId, undefined);
    const workflow = restored.state.workflows.find(item => item.id === workflowId)!;
    assert.deepEqual(workflow.steps.map(step => step.modelId), ['review', 'fast']);
    assert.deepEqual(workflow.steps.map(step => restored.state.sessions.find(session => session.id === step.sessionId)?.modelId), ['review', 'fast']);
    await restored.close();
  } finally {
    await engine.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('failure blocks descendants while independent steps can finish', async () => {
  const ran: string[] = [];
  const { engine, cwd } = await fixture(async context => {
    ran.push(context.session.title);
    if (context.session.title.endsWith(' · a')) throw new Error('provider failed');
  });
  const id = await engine.createWorkflow({ name: 'pipeline', cwd, steps: [
    { id: 'a', title: 'a', providerId: 'test', prompt: 'fail', dependsOn: [] },
    { id: 'b', title: 'b', providerId: 'test', prompt: 'blocked', dependsOn: ['a'] },
    { id: 'c', title: 'c', providerId: 'test', prompt: 'independent', dependsOn: [] },
  ] });
  engine.startWorkflow(id);
  await until(() => engine.snapshot().workflows[0].status === 'failed');
  assert.deepEqual(ran, ['pipeline · a', 'pipeline · c']);
  assert.deepEqual(engine.snapshot().workflows[0].steps.map(step => step.status), ['failed', 'blocked', 'completed']);
  await engine.shutdown();
});

test('a project has one active writer and cancelled approval is cleared', async () => {
  const { engine, cwd } = await fixture(async context => {
    await context.approve({ title: 'command', detail: 'fixture', choices: [{ id: 'accept', label: '允许' }] });
  });
  const first = await engine.createSession({ title: 'one', providerId: 'test', cwd });
  const second = await engine.createSession({ title: 'two', providerId: 'test', cwd });
  engine.sendMessage(first, 'wait');
  await until(() => engine.snapshot().sessions.find(session => session.id === first)?.status === 'waiting_approval');
  assert.throws(() => engine.sendMessage(second, 'competing'), /已有会话或编排运行/);
  engine.cancelSession(first);
  await until(() => engine.snapshot().sessions.find(session => session.id === first)?.status === 'cancelled');
  assert.deepEqual(engine.snapshot().sessions.find(session => session.id === first)?.approvals, []);
  await engine.shutdown();
});

test('approval returns only a displayed choice and streamed IDs are scoped to each turn', async () => {
  const choices: string[] = [];
  const { engine, cwd } = await fixture(async context => {
    choices.push(await context.approve({ title: 'permission', detail: 'fixture', choices: [{ id: 'accept', label: '允许' }] }));
    context.emit({ type: 'text', itemId: 'same-id', text: 'response' });
  });
  const id = await engine.createSession({ title: 'one', providerId: 'test', cwd });
  for (let index = 0; index < 2; index++) {
    engine.sendMessage(id, 'question');
    await until(() => engine.snapshot().sessions[0].approvals.length === 1);
    const approval = engine.snapshot().sessions[0].approvals[0];
    assert.throws(() => engine.decideApproval(approval.id, 'invalid'), /选项无效/);
    engine.decideApproval(approval.id, 'accept');
    await until(() => engine.snapshot().sessions[0].status === 'completed');
  }
  assert.deepEqual(choices, ['accept', 'accept']);
  assert.equal(engine.snapshot().sessions[0].messages.filter(message => message.role === 'assistant').length, 2);
  await engine.shutdown();
});

test('dependency validation rejects cycles and missing steps', () => {
  const base = { name: 'invalid', cwd: '/tmp' };
  assert.throws(() => validateWorkflow({ ...base, steps: [{ id: 'a', title: 'a', providerId: 'test', prompt: 'x', dependsOn: ['missing'] }] }), /不存在/);
  assert.throws(() => validateWorkflow({ ...base, steps: [{ id: 'a', title: 'a', providerId: 'test', prompt: 'x', dependsOn: ['a'] }] }), /循环依赖/);
});

test('workflow reserves its project across async step creation and releases it on cancel', async () => {
  const { engine, cwd } = await fixture(async context => {
    await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  const input = { name: 'one', cwd, steps: [{ id: 'a', title: 'a', providerId: 'test', prompt: 'wait', dependsOn: [] }] };
  const first = await engine.createWorkflow(input);
  const second = await engine.createWorkflow({ ...input, name: 'two' });
  const manual = await engine.createSession({ title: 'manual', providerId: 'test', cwd });
  engine.startWorkflow(first);
  assert.throws(() => engine.startWorkflow(second), /已有会话或编排运行/);
  assert.throws(() => engine.sendMessage(manual, 'competing'), /已有会话或编排运行/);
  engine.cancelWorkflow(first);
  await until(() => engine.snapshot().workflows.find(run => run.id === first)?.status === 'cancelled');
  engine.startWorkflow(second);
  engine.cancelWorkflow(second);
  await engine.shutdown();
});

test('multiple outstanding approvals keep the session waiting until all are answered', async () => {
  const { engine, cwd } = await fixture(async context => {
    await Promise.all(['one', 'two'].map(title => context.approve({ title, detail: title, choices: [{ id: 'accept', label: '允许' }] })));
  });
  const id = await engine.createSession({ title: 'parallel approvals', providerId: 'test', cwd });
  engine.sendMessage(id, 'ask');
  await until(() => engine.snapshot().sessions[0].approvals.length === 2);
  engine.decideApproval(engine.snapshot().sessions[0].approvals[0].id, 'accept');
  await until(() => engine.snapshot().sessions[0].approvals.length === 1);
  assert.equal(engine.snapshot().sessions[0].status, 'waiting_approval');
  engine.decideApproval(engine.snapshot().sessions[0].approvals[0].id, 'accept');
  await until(() => engine.snapshot().sessions[0].status === 'completed');
  await engine.shutdown();
});

test('Codex link preserves Unicode, spaces and query characters', () => {
  const input = { cwd: '/Users/example/new idea', prompt: '你好 & a=1\nsecond line #tag' };
  const url = new URL(buildCodexLink(input));
  assert.equal(url.protocol, 'codex:');
  assert.equal(url.hostname, 'threads');
  assert.equal(url.pathname, '/new');
  assert.equal(url.searchParams.get('path'), input.cwd);
  assert.equal(url.searchParams.get('prompt'), input.prompt);
});

test('restart marks unfinished work interrupted and never dispatches it automatically', async () => {
  const { engine, cwd, store } = await fixture(async () => {});
  const id = await engine.createSession({ title: 'unfinished', providerId: 'test', cwd });
  store.state.sessions[0].status = 'running';
  await engine.shutdown();
  const restored = new StateStore(store.path);
  await restored.load();
  assert.equal(restored.state.sessions.find(session => session.id === id)?.status, 'interrupted');
  await restored.close();
});

test('workspace tabs persist and closing an agent tab does not reopen it on restart', async () => {
  const { engine, cwd, store } = await fixture(async () => {});
  const workspaceId = await engine.createWorkspace({ name: 'Workspace', cwd });
  const sessionId = await engine.createSession({ title: 'one', providerId: 'test', cwd });
  const workspace = engine.snapshot().workspaces[0];
  assert.equal(workspace.id, workspaceId);
  assert.equal(workspace.tabs.length, 1);
  engine.closeTab(workspaceId, workspace.tabs[0].id);
  await engine.shutdown();
  const restored = new StateStore(store.path);
  await restored.load();
  assert.equal(restored.state.workspaces[0].tabs.length, 0);
  assert(restored.state.sessions.some(session => session.id === sessionId));
  const reopened = new WorkbenchEngine(restored, engine.pluginPath, () => {});
  reopened.openSessionTab(workspaceId, sessionId);
  assert.equal(reopened.snapshot().workspaces[0].tabs.length, 1);
  await reopened.shutdown();
});

test('question answers return structured values and withdrawn requests leave no stale approval', async () => {
  let answered: string | undefined;
  const request = new AbortController();
  const { engine, cwd } = await fixture(async context => {
    answered = await context.approve({ title: 'Question', detail: '', choices: [], questions: [
      { id: 'q', header: '选择', question: '哪个？', options: [{ label: 'A' }], multiSelect: false },
    ] });
    try { await context.approve({ title: 'withdraw', detail: '', choices: [{ id: 'allow', label: '允许' }] }, request.signal); }
    catch { assert(request.signal.aborted); }
    context.emit({ type: 'text', itemId: 'done', text: 'done' });
  });
  const id = await engine.createSession({ title: 'question', providerId: 'test', cwd });
  engine.sendMessage(id, 'ask');
  await until(() => engine.snapshot().sessions[0].approvals.some(approval => Boolean(approval.questions)));
  engine.answerQuestions(engine.snapshot().sessions[0].approvals[0].id, { q: ['A'] });
  await until(() => engine.snapshot().sessions[0].approvals.some(approval => approval.title === 'withdraw'));
  const withdrawnId = engine.snapshot().sessions[0].approvals[0].id;
  request.abort();
  await until(() => engine.snapshot().sessions[0].status === 'completed');
  assert.deepEqual(JSON.parse(answered!), { q: ['A'] });
  assert.equal(engine.snapshot().sessions[0].approvals.length, 0);
  assert.throws(() => engine.decideApproval(withdrawnId, 'allow'), /已结束/);
  await engine.shutdown();
});

test('legacy records migrate into one workspace while keeping original sessions', async () => {
  const { engine, cwd, store } = await fixture(async () => {});
  const id = await engine.createSession({ title: 'legacy', providerId: 'test', cwd });
  const { workspaces: _workspaces, ...legacy } = structuredClone(store.state);
  await engine.shutdown();
  const legacyDirectory = join(cwd, 'legacy-import'); await mkdir(legacyDirectory);
  const legacyPath = join(legacyDirectory, 'state.json'); await writeFile(legacyPath, JSON.stringify(legacy));
  const restored = new StateStore(legacyPath);
  await restored.load();
  assert.equal(restored.state.workspaces.length, 1);
  assert.equal(restored.state.workspaces[0].cwd, engine.snapshot().sessions[0].cwd);
  const tab = restored.state.workspaces[0].tabs[0];
  assert.equal(tab.kind, 'agent');
  if (tab.kind === 'agent') assert.equal(tab.sessionId, id);
  await restored.close();
});

test('shutdown disposes replaced providers and saves records when one disposal fails', async () => {
  const { engine, store } = await fixture(async () => {});
  const disposed: string[] = [];
  const adapter = (id: string, fail = false): ProviderAdapter => ({
    info: { id, name: id, source: 'builtin', available: true, detail: 'fixture', capabilities: { resume: true, approvals: true } },
    async run() {},
    async dispose() { disposed.push(id); if (fail) throw new Error('owned runtime did not exit'); },
  });
  const previous = adapter('previous', true);
  engine.setProviders([previous], [], []);
  engine.setProviders([adapter('current')], [], []);
  await assert.rejects(engine.shutdown(), /部分运行时关闭或记录保存失败/);
  assert.deepEqual(disposed.sort(), ['current', 'previous']);
  const saved = new StateStore(store.path); await saved.load(); assert.equal(saved.state.version, 1); await saved.close();
});
