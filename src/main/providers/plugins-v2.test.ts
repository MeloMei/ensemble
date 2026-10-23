import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Session } from '../../shared/types';
import type { ProviderCapabilities } from '../../shared/provider-capabilities';
import { AttachmentService } from '../attachment-service';
import { WorkbenchEngine } from '../engine';
import { StateStore } from '../store';
import { loadPluginProviders } from './plugins';
import type { ProviderEvent, TurnContext } from './types';

const capabilities: ProviderCapabilities = { resume: true, approvals: true, images: true, textAttachments: true,
  effort: true, permissions: true, structured: true, usage: true, questions: true };

const source = String.raw`
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';
const mode = process.argv[2], trace = process.argv[3];
const declared = JSON.parse(readFileSync(new URL('manifest.json', import.meta.url), 'utf8')).capabilities;
const lines = createInterface({ input: process.stdin });
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const tool = { type: 'structured', event: { id: 'tool-1', kind: 'tool', title: 'Fixture tool', status: 'completed', nativeId: 'native-tool', input: 'fixture input', output: 'fixture output' } };
const usage = { type: 'usage', usage: { id: 'usage-1', source: 'Fixture', scope: 'turn', inputTokens: 13, outputTokens: 7, createdAt: '2026-10-23T00:00:00.000Z' } };
const question = { type: 'approval', id: 'questions-1', title: 'Choose outputs', detail: '', choices: [], questions: [{ id: 'outputs', question: 'Which outputs?', header: 'Outputs', multiSelect: true, allowCustomAnswer: false, options: [{ label: 'Text' }, { label: 'Image' }] }] };
lines.on('line', line => {
  const frame = JSON.parse(line); appendFileSync(trace, line + '\n');
  if (frame.type === 'initialize') {
    if (mode === 'early-output') { send({ type: 'text', itemId: 'early', text: 'before ready' }); return; }
    const effective = { ...declared };
    for (const [suffix, field] of [['images', 'images'], ['permissions', 'permissions'], ['structured', 'structured'], ['usage', 'usage'], ['questions', 'questions']]) {
      if (mode === 'no-' + suffix) effective[field] = false;
    }
    if (mode === 'undeclared-ready') effective.steer = true;
    send({ type: 'ready', apiVersion: 2, capabilities: effective });
    if (mode === 'duplicate-ready') send({ type: 'ready', apiVersion: 2, capabilities: effective });
    return;
  }
  if (frame.type === 'turn') {
    if (mode === 'no-structured') { send(tool); return; }
    if (mode === 'no-usage') { send(usage); return; }
    if (mode === 'no-questions') { send(question); return; }
    send({ type: 'external-id', id: 'native-plugin-session' });
    send({ type: 'native-turn', turnId: 'native-plugin-turn' });
    send(tool); send(usage); send(question); return;
  }
  if (frame.type === 'approval-result') {
    if (frame.id !== 'questions-1' || JSON.stringify(frame.answers) !== JSON.stringify({ outputs: ['Text', 'Image'] })) process.exit(12);
    send({ type: 'text', itemId: 'answer', text: 'Confirmed both outputs' });
    send({ type: 'result', status: 'completed' }); lines.close();
  }
});
`;

async function fixture(mode = 'full') {
  const root = await mkdtemp(join(tmpdir(), 'ensemble-plugin-v2-'));
  const plugin = join(root, 'plugin'), trace = join(root, 'trace.jsonl'); await mkdir(plugin);
  const script = join(plugin, 'agent.mjs'); await writeFile(script, source);
  await writeFile(join(plugin, 'manifest.json'), JSON.stringify({ apiVersion: 2, id: 'fixture-v2', name: 'Fixture v2',
    command: process.execPath, args: [script, mode, trace], capabilities }));
  const loaded = await loadPluginProviders(root);
  assert.deepEqual(loaded.errors, []); assert.equal(loaded.adapters.length, 1);
  return { root, trace, adapter: loaded.adapters[0], async records() { return (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); } };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('state did not settle');
}

function context(cwd: string, overrides: Partial<TurnContext> = {}): TurnContext {
  const session: Session = { id: 'plugin-session', title: 'Fixture', providerId: 'fixture-v2', cwd, status: 'running',
    messages: [], approvals: [], createdAt: '', updatedAt: '' };
  return { session, prompt: 'fixture request', userMessageId: 'plugin-user', signal: new AbortController().signal,
    emit() {}, approve: async () => { throw new Error('unexpected approval'); }, ...overrides };
}

test('plugin v2 negotiates and carries attachments, settings, tool usage and question answers through the engine', async () => {
  const f = await fixture();
  const store = new StateStore(join(f.root, 'state', 'state.json'));
  const engine = new WorkbenchEngine(store, f.root, () => {}); engine.setProviders([f.adapter], [], []);
  try {
    const text = Buffer.from('UTF-8 附件\n$literal');
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yB9sAAAAASUVORK5CYII=', 'base64');
    await writeFile(join(f.root, 'note.txt'), text); await writeFile(join(f.root, 'image.png'), image);
    const attachments = new AttachmentService(join(f.root, 'attachments'));
    const imported = await attachments.importFiles([join(f.root, 'note.txt'), join(f.root, 'image.png')]);
    engine.setTurnEnricher(async (session, _prompt, messageId) => ({ attachments: await attachments.load(session.messages.find(message => message.id === messageId)?.attachments) }));
    const id = await engine.createSession({ title: 'plugin', providerId: 'fixture-v2', cwd: f.root });
    engine.updateSession(id, { settings: { effort: 'high', permission: 'read-only' } });
    engine.sendPrompt(id, { text: '中文插件任务\n$literal', attachments: imported }, 'plugin-send');
    await until(() => engine.getSession(id).approvals.length === 1);
    const approval = engine.getSession(id).approvals[0];
    assert.equal(approval.questions?.[0].multiSelect, true); assert.equal(approval.questions?.[0].allowCustomAnswer, false);
    engine.answerQuestions(approval.id, { outputs: ['Text', 'Image'] }, 'plugin-answer'); await engine.waitSession(id);
    const session = engine.getSession(id), records = await f.records(), turn = records.find(record => record.type === 'turn');
    assert.equal(records[0].type, 'initialize'); assert.equal(records[0].apiVersion, 2);
    assert.equal(turn.apiVersion, 2); assert.equal(turn.prompt, '中文插件任务\n$literal');
    assert.deepEqual(turn.settings, { effort: 'high', permission: 'read-only' });
    assert.equal(turn.clientUserMessageId, session.messages.find(message => message.role === 'user')?.id);
    assert.deepEqual(turn.attachments.map((attachment: { kind: string; encoding: string; data: string }) => ({ kind: attachment.kind, encoding: attachment.encoding, data: attachment.data })),
      [{ kind: 'text', encoding: 'base64', data: text.toString('base64') }, { kind: 'image', encoding: 'base64', data: image.toString('base64') }]);
    assert.deepEqual(records.find(record => record.type === 'approval-result'), { type: 'approval-result', id: 'questions-1', answers: { outputs: ['Text', 'Image'] } });
    assert.equal(session.status, 'completed'); assert.equal(session.externalId, 'native-plugin-session');
    assert.equal(session.messages.find(message => message.role === 'user')?.nativeTurnId, 'native-plugin-turn');
    assert(session.messages.some(message => message.event?.nativeId === 'native-tool' && message.event.output === 'fixture output'));
    assert.equal(session.usage?.[0].inputTokens, 13); assert.equal(session.usage?.[0].outputTokens, 7);
    assert(session.messages.some(message => message.role === 'assistant' && message.text === 'Confirmed both outputs'));
  } finally { await engine.shutdown(); await rm(f.root, { recursive: true, force: true }); }
});

test('ready capability narrowing rejects unsupported inputs and undeclared rich events before forwarding them', async t => {
  for (const mode of ['no-images', 'no-permissions', 'no-structured', 'no-usage', 'no-questions']) await t.test(mode, async () => {
    const f = await fixture(mode), events: ProviderEvent[] = [];
    let approvals = 0;
    try {
      const turn = context(f.root, { emit: event => events.push(event), approve: async () => { approvals++; return '{}'; } });
      if (mode === 'no-images') turn.attachments = [{ id: 'image', name: 'image.png', kind: 'image', mimeType: 'image/png', size: 3, sha256: 'fixture', ownedPath: '', data: Buffer.from('png') }];
      if (mode === 'no-permissions') turn.session.settings = { permission: 'read-only' };
      await assert.rejects(f.adapter.run(turn), mode === 'no-images' ? /negotiate images/ : mode === 'no-permissions' ? /permission settings/ : /undeclared/);
      const records = await f.records();
      if (mode === 'no-images' || mode === 'no-permissions') assert(!records.some(record => record.type === 'turn'));
      assert.equal(f.adapter.info.capabilities[mode.slice(3) as keyof ProviderCapabilities], false);
      assert.deepEqual(events, []); assert.equal(approvals, 0);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});

test('plugin v2 rejects output before ready, duplicate ready and negotiation of undeclared capabilities', async t => {
  for (const [mode, expected] of [['early-output', /before protocol negotiation/], ['duplicate-ready', /duplicate ready/], ['undeclared-ready', /undeclared capability steer/]] as const) await t.test(mode, async () => {
    const f = await fixture(mode);
    try { await assert.rejects(f.adapter.run(context(f.root)), expected); }
    finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
