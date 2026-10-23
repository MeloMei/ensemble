import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getEventListeners } from 'node:events';
import type { Session } from '../../shared/types';
import type { ProviderEvent, TurnContext } from './types';
import { createNdjsonDecoder } from './ndjson';
import { loadPluginProviders } from './plugins';

const directories: string[] = [];
after(async () => { await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))); });

async function fixture(source: string, overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-provider-'));
  directories.push(root);
  const plugin = path.join(root, 'plugin');
  await mkdir(plugin);
  const script = path.join(plugin, 'agent.mjs');
  await writeFile(script, source);
  const manifest = {
    apiVersion: 1, id: 'fixture', name: 'Fixture', command: process.execPath, args: [script],
    capabilities: { resume: true, approvals: true }, ...overrides,
  };
  await writeFile(path.join(plugin, 'manifest.json'), JSON.stringify(manifest));
  const loaded = await loadPluginProviders(root);
  return { root, plugin, manifest, loaded };
}

function context(overrides: Partial<TurnContext> = {}): TurnContext {
  const now = new Date().toISOString();
  const session: Session = {
    id: 'session-1', title: 'test', providerId: 'fixture', cwd: tmpdir(), status: 'running',
    messages: [], approvals: [], createdAt: now, updatedAt: now, externalId: 'previous-id',
  };
  return { session, prompt: '中文任务\n$literal', signal: new AbortController().signal, emit: () => {}, approve: async () => 'allow', ...overrides };
}

const readTurn = "import { createInterface } from 'node:readline'; const lines = createInterface({ input: process.stdin });";
const send = "function send(frame) { process.stdout.write(JSON.stringify(frame) + '\\n'); }";

test('NDJSON preserves split UTF-8, CRLF and final records, and rejects invalid or oversized frames', () => {
  const records: unknown[] = [];
  const decoder = createNdjsonDecoder((record) => records.push(record));
  const bytes = Buffer.from('{"text":"中文🐈"}\r\n{"last":true}');
  for (const byte of bytes) decoder.feed(Buffer.from([byte]));
  decoder.end();
  assert.deepEqual(records, [{ text: '中文🐈' }, { last: true }]);
  assert.throws(() => createNdjsonDecoder(() => {}, 4).feed('12345'), /exceeds/);
  assert.throws(() => createNdjsonDecoder(() => {}).feed('not-json\n'));
  assert.throws(() => createNdjsonDecoder(() => {}).feed(Buffer.from([0xff, 10])), /encoded|encoding/i);
});

test('loader rejects reserved, malformed and duplicate IDs without choosing an owner', async () => {
  const { root, manifest } = await fixture('', { id: 'duplicate' });
  for (const [name, extra] of [
    ['duplicate', { id: 'duplicate' }], ['reserved', { id: 'codex' }], ['unknown', { extra: true, id: 'unknown' }],
  ] as const) {
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, 'manifest.json'), JSON.stringify({ ...manifest, ...extra }));
  }
  const loaded = await loadPluginProviders(root);
  assert.equal(loaded.adapters.length, 0);
  assert.equal(loaded.errors.filter((error) => error.includes('Duplicate')).length, 2);
  assert(loaded.errors.some((error) => error.includes('reserved')));
  assert(loaded.errors.some((error) => error.includes('Unrecognized')));
});

test('missing executable is displayed as unavailable without spawning it', async () => {
  const { loaded } = await fixture('', { command: './missing-command' });
  assert.equal(loaded.errors.length, 0);
  assert.equal(loaded.adapters[0].info.available, false);
  await assert.rejects(loaded.adapters[0].run(context()), /Executable unavailable/);
});

test('plugin receives literal turn input and forwards text, activity and external session ID', async () => {
  const { loaded } = await fixture(`${readTurn} ${send}
    lines.once('line', line => {
      send({ type: 'activity', text: line });
      send({ type: 'external-id', id: 'new-id' });
      send({ type: 'text', itemId: 'answer', text: '中文回答' });
      send({ type: 'result', status: 'completed' }); lines.close();
    });`);
  const events: ProviderEvent[] = [];
  const turn = context({ emit: (event) => events.push(event) });
  await loaded.adapters[0].run(turn);
  const activity = events[0];
  assert.equal(activity.type, 'activity');
  if (activity.type !== 'activity') throw new Error('Expected activity');
  assert.deepEqual(JSON.parse(activity.text), {
    type: 'turn', sessionId: 'session-1', externalId: 'previous-id', cwd: tmpdir(), prompt: turn.prompt,
  });
  assert.deepEqual(events.slice(1), [{ type: 'external-id', id: 'new-id' }, { type: 'text', itemId: 'answer', text: '中文回答' }]);
  assert.equal(getEventListeners(turn.signal, 'abort').length, 0);
});

test('plugin protocol v1 rejects text and image attachments before starting the process', async () => {
  const { loaded, root } = await fixture(`import { writeFileSync } from 'node:fs'; writeFileSync('started', 'yes'); ${readTurn} ${send}
    lines.once('line', line => { send({ type: 'activity', text: line }); send({ type: 'result', status: 'completed' }); lines.close(); });`);
  for (const kind of ['text', 'image'] as const) {
    const turn = context({
      prompt: '',
      attachments: [{ id: 'attachment', kind, name: kind === 'text' ? 'note.txt' : 'screen.png',
        mimeType: kind === 'text' ? 'text/plain' : 'image/png', size: 22, sha256: 'fixture',
        ownedPath: path.join(root, 'attachment'), data: Buffer.from('IMPORTANT_FILE_CONTENT') }],
    });
    turn.session.cwd = root;
    await assert.rejects(loaded.adapters[0].run(turn), /apiVersion 1 does not support attachments/);
    assert.equal(getEventListeners(turn.signal, 'abort').length, 0);
  }
  await assert.rejects(readFile(path.join(root, 'started')), { code: 'ENOENT' });
});

test('approval response retains the plugin request ID and selected choice', async () => {
  const { loaded } = await fixture(`${readTurn} ${send}
    lines.on('line', line => {
      const frame = JSON.parse(line);
      if (frame.type === 'turn') send({ type: 'approval', id: 'ask-1', title: '执行？', detail: 'build', choices: [{ id: 'allow', label: '允许' }] });
      else { send({ type: 'activity', text: line }); send({ type: 'result', status: 'completed' }); lines.close(); }
    });`);
  const events: ProviderEvent[] = [];
  let asked = false;
  await loaded.adapters[0].run(context({
    emit: (event) => events.push(event),
    approve: async (input) => { asked = true; assert.equal(input.title, '执行？'); return 'allow'; },
  }));
  assert(asked);
  assert.deepEqual(events, [{ type: 'activity', text: '{"type":"approval-result","id":"ask-1","choiceId":"allow"}' }]);
});

test('success requires a completed result plus exit zero, with valid protocol throughout', async (suite) => {
  for (const [label, body, expected] of [
    ['no result', 'process.exit(0)', /no successful completion/],
    ['nonzero exit', "send({type:'result',status:'completed'}); process.exitCode = 2; lines.close()", /exit 2/],
    ['failed result', "send({type:'result',status:'failed',error:'provider failed'}); lines.close()", /provider failed/],
    ['trailing event', "send({type:'result',status:'completed'}); send({type:'activity',text:'late'}); lines.close()", /after its result/],
    ['unknown event', "send({type:'unexpected'}); lines.close()", /Invalid plugin output/],
    ['oversized frame', "process.stdout.write('x'.repeat(1024 * 1024 + 1)); lines.close()", /exceeds/],
  ] as const) {
    await suite.test(label, async () => {
      const { loaded } = await fixture(`${readTurn} ${send} lines.once('line', () => { ${body}; });`);
      await assert.rejects(loaded.adapters[0].run(context()), expected);
    });
  }
});

test('abort rejects and removes listeners after terminating the plugin process group', async () => {
  const { loaded } = await fixture(`${readTurn} ${send}
    import { spawn } from 'node:child_process';
    lines.once('line', () => {
      const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {stdio:'ignore'});
      send({type:'activity',text:JSON.stringify({root:process.pid,child:descendant.pid})});
      setInterval(()=>{},1000);
    });`);
  const controller = new AbortController();
  let pids: { root: number; child: number } | undefined;
  await assert.rejects(loaded.adapters[0].run(context({ signal: controller.signal, emit(event) {
    if (event.type === 'activity') { pids = JSON.parse(event.text); controller.abort(); }
  } })), { name: 'AbortError' });
  assert(pids);
  const { root, child } = pids;
  assert.throws(() => process.kill(root, 0), /ESRCH/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  // The descendant can briefly be a zombie until the OS reaps it; a live process must not remain.
  if (process.platform !== 'win32') {
    const { execFileSync } = await import('node:child_process');
    let state = '';
    try { state = execFileSync('ps', ['-o', 'stat=', '-p', String(child)], { encoding: 'utf8' }).trim(); } catch {}
    assert(!state || state.startsWith('Z'), `Plugin descendant remains live: ${state}`);
  }
});
