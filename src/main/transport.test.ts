import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session, Snapshot } from '../shared/types';
import type { SnapshotFrame, TerminalOutputEvent } from '../shared/backend';
import { SnapshotGapError, SnapshotReplica } from '../shared/snapshot-stream';
import { SnapshotProjection } from './snapshot-projection';
import { BackendConnectionTracker, connectBackend } from './backend-client';
import { BoundedEventStream } from './bounded-event-stream';
import { TerminalOutputBuffer, TerminalOutputCoalescer, TERMINAL_OUTPUT_LIMIT, terminalOutputTail } from './terminal-output';

function session(id: string, count: number): Session {
  return { id, title: id, providerId: 'fixture', cwd: '/tmp', status: 'completed', approvals: [], createdAt: 'now', updatedAt: 'now',
    messages: Array.from({ length: count }, (_, index) => ({ id: `${id}-${index}`, role: 'assistant', text: `${id}:${index}:${'x'.repeat(200)}`, createdAt: 'now' })) };
}
function snapshot(sessions: Session[]): Snapshot {
  return { version: 1, sessions, providers: [], workspaces: [], workflows: [], terminals: [], dataPath: '/tmp', pluginPath: '/tmp', pluginErrors: [] };
}
function wire<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

test('subscribed projections exclude unrelated history and send only changed messages', t => {
  const source = snapshot(Array.from({ length: 24 }, (_, index) => session(`session-${index}`, 400)));
  source.sessions[1].draft = { text: 'HIDDEN_DRAFT_BODY' };
  source.sessions[1].attempts = Array.from({ length: 40 }, (_, index) => ({ id: `attempt-${index}`, status: 'completed', prompt: 'HIDDEN_ATTEMPT_BODY', userMessageId: 'one', startedAt: 'now' }));
  source.sessions[1].queue = [{ id: 'queued', commandId: 'queued-command', input: { text: 'HIDDEN_QUEUE_BODY' }, createdAt: 'now', updatedAt: 'now' }];
  source.mails = [
    { id: 'unwatched-mail', fromSessionId: 'session-1', toSessionId: 'session-2', attemptId: 'child-attempt', kind: 'result',
      text: `HIDDEN_MAIL_BODY:${'unrelated output '.repeat(10_000)}`, createdAt: 'now' },
    { id: 'coordinator-inbox', fromSessionId: 'session-1', toSessionId: 'session-0', attemptId: 'child-attempt', kind: 'result',
      text: `WATCHED_COORDINATOR_BODY:${'complete inbox output '.repeat(1000)}`, createdAt: 'now' },
    { id: 'watched-outbox', fromSessionId: 'session-0', toSessionId: 'session-3', attemptId: 'parent-attempt', kind: 'message',
      text: 'WATCHED_OUTBOX_BODY', createdAt: 'now' },
  ];
  const mails = source.mails;
  const projection = new SnapshotProjection('backend-one', 'subscriber', new Set(['session-0']));
  const startFull = performance.now(); const full = JSON.stringify(source); const fullMs = performance.now() - startFull;
  const startProjection = performance.now(); const first = JSON.stringify(projection.frame(source, 1)); const projectionMs = performance.now() - startProjection;
  const reset = JSON.parse(first) as SnapshotFrame;
  assert.equal(reset.type, 'reset');
  if (reset.type !== 'reset') return;
  assert.equal(reset.snapshot.sessions[0].messages.length, 100);
  assert.equal(reset.snapshot.sessions[1].messages.length, 0);
  assert.equal(first.includes('session-1:399:'), false);
  assert.equal(first.includes('HIDDEN_'), false);
  assert.deepEqual(reset.snapshot.mails?.map(mail => mail.id), ['coordinator-inbox', 'watched-outbox']);
  assert.equal(reset.snapshot.mails?.find(mail => mail.id === 'coordinator-inbox')?.text, mails[1].text);
  assert.equal(reset.snapshot.sessions[1].attempts?.length, 32);
  assert.equal(reset.snapshot.sessions[1].attempts?.at(-1)?.id, 'attempt-39');
  assert.ok(first.length < full.length / 20);
  const replica = new SnapshotReplica(); replica.apply(reset);
  const unchangedMessages = reset.snapshot.sessions[1].messages;
  source.sessions[0].messages.at(-1)!.text += ' changed';
  source.sessions[1].messages.at(-1)!.text += ' invisible';
  mails[0].text += `HIDDEN_MAIL_DELTA:${'more unrelated output '.repeat(5000)}`;
  const delta = wire(projection.frame(source, 2)!);
  assert.equal(delta.type, 'delta');
  if (delta.type !== 'delta') return;
  assert.equal(delta.sessions.length, 1);
  assert.equal(delta.sessions[0].messages?.upserts.length, 1);
  assert.equal(JSON.stringify(delta).includes('HIDDEN_MAIL'), false);
  assert.equal(delta.fields?.mails, undefined);
  const applied = replica.apply(delta)!;
  assert.strictEqual(applied.sessions[1].messages, unchangedMessages);
  assert.equal(applied.sessions[0].messages.at(-1)!.text, source.sessions[0].messages.at(-1)!.text);
  source.sessions.splice(1, 1);
  const removed = wire(projection.frame(source, 3)!);
  assert.equal(replica.apply(removed)!.sessions.some(item => item.id === 'session-1'), false);
  projection.watch(['session-2']);
  const receiverReset = wire(projection.frame(source, 4)!);
  const recipient = replica.apply(receiverReset)!;
  assert.deepEqual(recipient.mails?.map(mail => mail.id), ['unwatched-mail']);
  assert.equal(recipient.mails?.[0].text, mails[0].text);
  assert.equal(JSON.stringify(recipient).includes('WATCHED_COORDINATOR_BODY'), false);
  assert.equal(JSON.stringify(recipient).includes('WATCHED_OUTBOX_BODY'), false);
  mails[0].text += ` complete watched output ${'z'.repeat(5000)}`;
  const receiverDelta = wire(projection.frame(source, 5)!);
  assert.equal(receiverDelta.type, 'delta');
  assert.equal(replica.apply(receiverDelta)!.mails?.[0].text, mails[0].text);
  source.mails = undefined;
  const cleared = wire(projection.frame(source, 6)!);
  assert.equal(cleared.type, 'delta');
  assert.deepEqual(replica.apply(cleared)!.mails, []);
  source.mails = mails;
  assert.equal(replica.apply(wire(projection.frame(source, 7)!))!.mails?.[0].text, mails[0].text);
  projection.watch([]);
  const unwatched = replica.apply(wire(projection.frame(source, 8)!))!;
  assert.deepEqual(unwatched.mails, []);
  assert.equal(JSON.stringify(unwatched).includes('HIDDEN_MAIL'), false);
  mails[0].text += ' hidden after unsubscribe';
  assert.equal(projection.frame(source, 9), undefined);
  t.diagnostic(JSON.stringify({ fixtureSessions: 24, messagesPerSession: 400, fullBytes: Buffer.byteLength(full),
    subscribedBytes: Buffer.byteLength(first), deltaBytes: Buffer.byteLength(JSON.stringify(delta)), fullEncodeMs: fullMs, projectionAndEncodeMs: projectionMs }));
});

test('watch resets, missing revisions and backend generations never merge incompatible state', () => {
  const source = snapshot([session('one', 105), session('two', 105)]);
  const projection = new SnapshotProjection('first', 'subscription', new Set(['one']));
  const replica = new SnapshotReplica(); replica.apply(wire(projection.frame(source, 1)!));
  source.sessions[0].title = 'changed';
  projection.frame(source, 2);
  source.sessions[0].title = 'again';
  const gap = wire(projection.frame(source, 3)!);
  assert.throws(() => replica.apply(gap), SnapshotGapError);
  projection.watch(['two']);
  const restored = replica.apply(wire(projection.frame(source, 3)!))!;
  assert.equal(restored.sessions[0].messages.length, 0);
  assert.equal(restored.sessions[1].messages[0].id, 'two-5');
  const replacement = new SnapshotProjection('second', 'new-subscription', new Set(['one']));
  replica.apply(wire(replacement.frame(source, 1)!));
  assert.throws(() => replica.apply(gap), SnapshotGapError);
  const states: unknown[] = []; const tracker = new BackendConnectionTracker(state => states.push(state));
  const first = tracker.begin('first'); tracker.received(first, { type: 'reset', instanceId: 'first', revision: 1, subscriptionId: 'one', snapshot: source });
  tracker.disconnected(first, new Error('stream closed'));
  assert.equal(tracker.current.synced, false); assert.equal(tracker.current.status, 'reconnecting');
  const second = tracker.begin('second');
  assert.equal(tracker.received(first, gap), false);
  assert.equal(tracker.current.synced, false);
  tracker.received(second, { type: 'reset', instanceId: 'second', revision: 1, subscriptionId: 'two', snapshot: source });
  assert.equal(tracker.current.synced, true); assert.equal(tracker.current.instanceId, 'second');
  assert.ok(states.length >= 5);
});

test('discovery reports an incompatible live backend without replacing its process', async () => {
  const dataPath = await mkdtemp(join(tmpdir(), 'ensemble-stream-version-'));
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ready: true, instanceId: 'old-backend' }));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    await writeFile(join(dataPath, 'backend.json'), JSON.stringify({ version: 1, url: `http://127.0.0.1:${address.port}`,
      token: 'a'.repeat(64), instanceId: 'old-backend', pid: process.pid, startedAt: 'now' }));
    const client = await connectBackend(dataPath, { command: '/does-not-exist', entryPath: '/does-not-exist' });
    assert.throws(() => client.assertSnapshotStreaming(), /后台版本.*不兼容/);
    assert.equal((await connectBackend(dataPath)).endpoint.instanceId, 'old-backend');
    assert.equal(server.listening, true);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dataPath, { recursive: true, force: true }); }
});

test('terminal leading/trailing output preserves UTF-16 offsets across split Unicode and a bounded tail', async () => {
  const events: TerminalOutputEvent[] = []; const history = new TerminalOutputBuffer();
  const coalescer = new TerminalOutputCoalescer('terminal', event => events.push(event), data => history.append(data));
  coalescer.append('A'); assert.equal(events.length, 1);
  coalescer.append('\ud83d'); assert.equal(events.length, 1);
  coalescer.append('\ude80中'); coalescer.append('B');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(events, [{ type: 'append', terminalId: 'terminal', data: 'A', offset: 0 },
    { type: 'append', terminalId: 'terminal', data: '🚀中B', offset: 1 }]);
  const burst = '😀'.repeat(100_000); coalescer.append(burst); coalescer.dispose();
  let end = 0, received = '';
  for (const event of events) {
    assert.equal(event.type, 'append'); if (event.type !== 'append') continue;
    assert.equal(event.offset, end); received += event.data; end += event.data.length;
  }
  assert.equal(received, `A🚀中B${burst}`);
  const { output, outputOffset } = history.snapshot();
  assert.ok(Buffer.byteLength(output) <= TERMINAL_OUTPUT_LIMIT);
  assert.equal(outputOffset + output.length, end);
  assert.equal(received.slice(outputOffset), output);
  assert.equal(/^[\udc00-\udfff]/u.test(output), false);
});

test('terminal history incrementally evicts small chunks without splitting UTF-8 characters', t => {
  const history = new TerminalOutputBuffer();
  let received = '🚀中é'.repeat(40_000);
  history.append(received);
  const chunk = 'a'.repeat(61) + '中';
  const started = performance.now();
  for (let index = 0; index < 4096; index++) history.append(chunk);
  const appendMs = performance.now() - started;
  received += chunk.repeat(4096);
  for (const addition of ['🚀', 'é', 'a', '中', '🚀'.repeat(100_000), 'b']) {
    history.append(addition); received += addition;
    const { output, outputOffset } = history.snapshot();
    assert.equal(output, terminalOutputTail(received));
    assert.equal(received.slice(outputOffset), output);
    assert.ok(Buffer.byteLength(output) <= TERMINAL_OUTPUT_LIMIT);
    assert.equal(/^[\udc00-\udfff]/u.test(output), false);
  }
  t.diagnostic(JSON.stringify({ chunks: 4096, chunkBytes: Buffer.byteLength(chunk), appendMs }));
});

class SlowResponse extends EventEmitter {
  writableLength = 0;
  writes: string[] = [];
  blocked = true;
  destroyed = false;
  write(value: string): boolean { this.writes.push(value); this.writableLength += Buffer.byteLength(value); return !this.blocked; }
  destroy(): this { this.destroyed = true; this.emit('close'); return this; }
  drain(): void { this.writableLength = 0; this.blocked = false; this.emit('drain'); }
}

test('slow streams keep one dirty marker, catch up once after drain and release listeners', () => {
  const response = new SlowResponse(); let catchUps = 0, releases = 0;
  const stream = new BoundedEventStream(response as unknown as ServerResponse, () => {
    catchUps++; stream.send('terminal', { type: 'tail', output: 'latest bounded tail' });
  }, () => { releases++; });
  stream.send('terminal', { data: 'first' });
  for (let index = 0; index < 10_000; index++) stream.send('terminal', { data: 'discarded pending append' });
  assert.equal(response.writes.length, 1); assert.ok(response.writableLength < 100);
  response.drain();
  assert.equal(catchUps, 1); assert.equal(response.writes.length, 2);
  stream.close(); stream.close();
  assert.equal(releases, 1); assert.equal(response.listenerCount('drain'), 0); assert.equal(response.listenerCount('close'), 0);
});
