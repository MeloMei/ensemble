import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { startBackend } from './backend-server';
import { BackendClient, BackendConnectionTracker, BackendFrameTooLargeError } from './backend-client';
import { BoundedEventStream } from './bounded-event-stream';
import type { Snapshot, Message } from '../shared/types';
import type { TerminalOutputEvent } from '../shared/backend';

async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 400; index++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('focused stream condition did not arrive');
}

test('backend watch changes and restart recover bounded session tails without cloning full history', async () => {
  const dataPath = await realpath(await mkdtemp(join(tmpdir(), 'ensemble-stream-')));
  const options = { dataPath, command: process.execPath, bridgePath: join(dataPath, 'bridge.cjs'), providers: [{
    info: { id: 'fixture', name: 'fixture', source: 'plugin' as const, available: true, detail: '', capabilities: { resume: false, approvals: false } }, async run() {},
  }] };
  let backend = await startBackend(options);
  const controller = new AbortController(); const nextController = new AbortController();
  const tracker = new BackendConnectionTracker(() => {});
  let latest: Snapshot | undefined; let observed = 0;
  let subscription: Promise<void> | undefined, restored: Promise<void> | undefined;
  try {
    const ids: string[] = [];
    for (const title of ['one', 'two']) ids.push(await backend.service.engine.createSession({ title, cwd: dataPath, providerId: 'fixture' }));
    for (const session of backend.service.store.state.sessions) session.messages = Array.from({ length: 125 }, (_, index): Message => ({
      id: `${session.id}-${index}`, role: 'assistant', text: `${session.title}:${index}`, createdAt: '2026-10-23T00:00:00Z',
    }));
    const fullSnapshot = backend.service.engine.snapshot.bind(backend.service.engine);
    backend.service.engine.snapshot = () => { throw new Error('UI stream must not clone full history'); };
    const client = new BackendClient(backend.endpoint);
    const generation = tracker.begin(backend.endpoint.instanceId);
    subscription = client.subscribe((snapshot, frame) => {
      if (tracker.received(generation, frame)) { latest = snapshot; observed++; }
    }, controller.signal).catch(error => { if (!controller.signal.aborted) tracker.disconnected(generation, error); });
    await until(() => !!latest);
    assert.equal(latest!.sessions.every(session => session.messages.length === 0), true);
    await client.watchSessions([ids[0], ids[1]]);
    await until(() => latest!.sessions.every(session => session.messages.length === 100));
    await client.watchSessions([ids[1]]);
    await until(() => latest!.sessions.find(session => session.id === ids[0])!.messages.length === 0);
    const page = await client.call<{ messages: Message[] }>('workbench:session-history', ids[1], undefined, 10);
    assert.equal(page.messages.length, 10);
    const before = observed;
    await client.call('workbench:save-session-draft', ids[1], { text: 'keep' });
    await until(() => observed > before);
    assert.equal(latest!.sessions.find(session => session.id === ids[1])!.draft?.text, 'keep');
    assert.equal((await client.snapshot()).sessions.find(session => session.id === ids[0])!.messages.length, 0);
    const origin = await fetch(`${backend.endpoint.url}/snapshot`, { headers: { Authorization: `Bearer ${backend.endpoint.token}`, Origin: 'https://example.com' } });
    assert.equal(origin.status, 403);
    backend.service.engine.snapshot = fullSnapshot;
    const previousInstance = backend.endpoint.instanceId;
    await backend.close(); await subscription;
    tracker.disconnected(generation);
    assert.equal(tracker.current.synced, false);
    assert.equal(latest!.sessions.find(session => session.id === ids[1])!.messages.at(-1)!.text, 'two:124');
    backend = await startBackend(options);
    assert.notEqual(backend.endpoint.instanceId, previousInstance);
    const nextClient = new BackendClient(backend.endpoint); await nextClient.watchSessions([ids[1]]);
    const nextGeneration = tracker.begin(backend.endpoint.instanceId);
    restored = nextClient.subscribe((snapshot, frame) => {
      if (tracker.received(nextGeneration, frame)) latest = snapshot;
    }, nextController.signal).catch(error => { if (!nextController.signal.aborted) throw error; });
    await until(() => tracker.current.synced);
    assert.equal(tracker.current.instanceId, backend.endpoint.instanceId);
    assert.equal(latest!.sessions.find(session => session.id === ids[1])!.messages.length, 100);
    assert.equal(tracker.received(generation, { type: 'reset', instanceId: previousInstance, subscriptionId: 'late', revision: 999, snapshot: latest! }), false);
  } finally {
    controller.abort(); nextController.abort();
    await Promise.allSettled([subscription, restored].filter((promise): promise is Promise<void> => !!promise));
    await backend.close(); await rm(dataPath, { recursive: true, force: true });
  }
});

test('rapid watch changes coalesce into one latest-target catch-up without repeated history resets', async t => {
  const dataPath = await realpath(await mkdtemp(join(tmpdir(), 'ensemble-watch-burst-')));
  const backend = await startBackend({ dataPath, command: process.execPath, bridgePath: join(dataPath, 'bridge.cjs'), providers: [{
    info: { id: 'fixture', name: 'fixture', source: 'plugin', available: true, detail: '', capabilities: { resume: false, approvals: false } }, async run() {},
  }] });
  const controller = new AbortController();
  const originalFetch = globalThis.fetch;
  const watches: string[][] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/watch')) {
      watches.push(JSON.parse(String(init?.body)).sessionIds);
      if (watches.length === 1) await gate;
    }
    return originalFetch(input, init);
  };
  let latest: Snapshot | undefined, resets = 0, subscription: Promise<void> | undefined;
  try {
    const ids: string[] = [];
    for (const title of ['first', 'second', 'latest']) ids.push(await backend.service.engine.createSession({ title, cwd: dataPath, providerId: 'fixture' }));
    for (const session of backend.service.store.state.sessions) session.messages = [{ id: `${session.id}-message`, role: 'assistant', text: session.title, createdAt: 'now' }];
    const client = new BackendClient(backend.endpoint);
    await client.watchSessions([ids[0]]);
    subscription = client.subscribe((snapshot, frame) => { latest = snapshot; if (frame.type === 'reset') resets++; }, controller.signal)
      .catch(error => { if (!controller.signal.aborted) throw error; });
    await until(() => latest?.sessions.find(session => session.id === ids[0])?.historyLoaded === true);
    const pending = [client.watchSessions([ids[1]])];
    await until(() => watches.length === 1);
    for (let index = 0; index < 12; index++) pending.push(client.watchSessions([ids[index % 2 ? 2 : 0]]));
    release(); await Promise.all(pending);
    await until(() => latest?.sessions.find(session => session.id === ids[2])?.historyLoaded === true);
    await until(() => resets === watches.length + 1);
    t.diagnostic(JSON.stringify({ watchChanges: pending.length, watchRequests: watches.length, historyResets: resets - 1 }));
    assert.deepEqual(watches, [[ids[1]], [ids[2]]]);
    assert.equal(resets, 3);
    assert.equal(latest!.sessions.find(session => session.id === ids[0])!.messages.length, 0);
    assert.equal(latest!.sessions.find(session => session.id === ids[2])!.messages[0].text, 'latest');
  } finally {
    release(); globalThis.fetch = originalFetch; controller.abort();
    await subscription;
    await backend.close(); await rm(dataPath, { recursive: true, force: true });
  }
});

test('failed watch changes restart the current stream while late failures cannot cancel its replacement', async () => {
  const dataPath = await realpath(await mkdtemp(join(tmpdir(), 'ensemble-watch-recovery-')));
  const backend = await startBackend({ dataPath, command: process.execPath, bridgePath: join(dataPath, 'bridge.cjs'), providers: [{
    info: { id: 'fixture', name: 'fixture', source: 'plugin', available: true, detail: '', capabilities: { resume: false, approvals: false } }, async run() {},
  }] });
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  const subscriptions: Promise<void>[] = [];
  const originalFetch = globalThis.fetch;
  let watchFault: 'immediate' | 'deferred' | undefined;
  let failDeferredWatch: (() => void) | undefined;
  globalThis.fetch = (input, init) => {
    if (String(input).endsWith('/watch') && watchFault) {
      const fault = watchFault; watchFault = undefined;
      if (fault === 'immediate') return Promise.resolve(new Response('', { status: 503 }));
      return new Promise<Response>(resolve => { failDeferredWatch = () => resolve(new Response('', { status: 503 })); });
    }
    return originalFetch(input, init);
  };
  let latest: Snapshot | undefined, streamFailure: unknown, replacementFailure: unknown;
  try {
    const first = await backend.service.engine.createSession({ title: 'first', cwd: dataPath, providerId: 'fixture' });
    const second = await backend.service.engine.createSession({ title: 'second', cwd: dataPath, providerId: 'fixture' });
    for (const session of backend.service.store.state.sessions) session.messages = [{ id: `${session.id}-message`, role: 'assistant', text: session.title, createdAt: 'now' }];
    const client = new BackendClient(backend.endpoint);
    await client.watchSessions([first]);
    subscriptions.push(client.subscribe(snapshot => { latest = snapshot; }, controllers[0].signal).catch(error => { if (!controllers[0].signal.aborted) streamFailure = error; }));
    await until(() => latest?.sessions.find(session => session.id === first)?.historyLoaded === true);
    watchFault = 'immediate';
    await assert.rejects(client.watchSessions([second]), /订阅已失效/);
    await until(() => streamFailure !== undefined);
    await subscriptions[0];
    assert.equal(latest!.sessions.find(session => session.id === second)!.historyLoaded, false);
    subscriptions.push(client.subscribe(snapshot => { latest = snapshot; }, controllers[1].signal).catch(error => { if (!controllers[1].signal.aborted) throw error; }));
    await until(() => latest?.sessions.find(session => session.id === second)?.historyLoaded === true);
    assert.equal(latest!.sessions.find(session => session.id === second)!.messages[0].text, 'second');
    watchFault = 'deferred';
    const delayed = client.watchSessions([first]);
    await until(() => !!failDeferredWatch);
    controllers[1].abort(); await subscriptions[1];
    subscriptions.push(client.subscribe(snapshot => { latest = snapshot; }, controllers[2].signal).catch(error => { if (!controllers[2].signal.aborted) replacementFailure = error; }));
    await until(() => latest?.sessions.find(session => session.id === first)?.historyLoaded === true);
    failDeferredWatch!(); await delayed;
    await client.call('workbench:save-session-draft', first, { text: 'new stream remains active' });
    await until(() => latest?.sessions.find(session => session.id === first)?.draft?.text === 'new stream remains active');
    assert.equal(replacementFailure, undefined);
  } finally {
    failDeferredWatch?.(); globalThis.fetch = originalFetch;
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(subscriptions);
    await backend.close(); await rm(dataPath, { recursive: true, force: true });
  }
});

test('real PTY output uses an independent Unicode-safe tail and append stream', async t => {
  const dataPath = await realpath(await mkdtemp(join(tmpdir(), 'ensemble-terminal-stream-')));
  const backend = await startBackend({ dataPath, command: process.execPath, bridgePath: join(dataPath, 'bridge.cjs'), providers: [] });
  const controller = new AbortController(); const stateController = new AbortController();
  let subscription: Promise<void> | undefined, stateSubscription: Promise<void> | undefined;
  let output = '', end: number | undefined, stateEvents = 0;
  const events: TerminalOutputEvent[] = [];
  const latencies: number[] = [];
  try {
    const workspaceId = await backend.service.engine.createWorkspace({ name: 'terminal fixture', cwd: dataPath });
    const client = new BackendClient(backend.endpoint);
    const id = await client.call<string>('workbench:create-terminal', workspaceId);
    stateSubscription = client.subscribe(() => { stateEvents++; }, stateController.signal).catch(error => { if (!stateController.signal.aborted) throw error; });
    subscription = client.subscribeTerminal(id, event => {
      events.push(event);
      if (event.type === 'tail') {
        if (end === undefined) { output = event.output; end = event.outputOffset + event.output.length; }
        else {
          assert.ok(event.outputOffset <= end);
          output += event.output.slice(Math.max(0, end - event.outputOffset)); end = Math.max(end, event.outputOffset + event.output.length);
        }
      } else {
        assert.notEqual(end, undefined); assert.ok(event.offset <= end!);
        output += event.data.slice(Math.max(0, end! - event.offset)); end = Math.max(end!, event.offset + event.data.length);
      }
    }, controller.signal).catch(error => { if (!controller.signal.aborted) throw error; });
    await until(() => end !== undefined && stateEvents > 0);
    await client.call('workbench:write-terminal', id, 'stty -echo\n');
    await new Promise(resolve => setTimeout(resolve, 50));
    const before = stateEvents;
    for (let index = 0; index < 5; index++) {
      const started = performance.now();
      const marker = `STREAM🚀${index}`;
      const escaped = [...Buffer.from(marker)].map(byte => `\\${byte.toString(8).padStart(3, '0')}`).join('');
      await client.call('workbench:write-terminal', id, `printf '${escaped}\\n'\n`);
      await until(() => output.includes(marker)); latencies.push(performance.now() - started);
      assert.equal(output.split(marker).length - 1, 1);
    }
    assert.equal(stateEvents, before);
    assert.equal((await client.snapshot()).terminals[0].output, '');
    assert.ok(events.some(event => event.type === 'append'));
    latencies.sort((a, b) => a - b);
    t.diagnostic(JSON.stringify({ kind: 'local-pty-echo', samples: latencies.length, p50Ms: latencies[2], p95Ms: latencies[4], snapshotEventsDuringEcho: stateEvents - before }));
    await client.call('workbench:stop-terminal', id);
  } finally {
    controller.abort(); stateController.abort();
    await Promise.allSettled([subscription, stateSubscription].filter((promise): promise is Promise<void> => !!promise));
    await backend.close(); await rm(dataPath, { recursive: true, force: true });
  }
});

test('oversized session frames report their limit and recover after switching the watched session', async () => {
  const dataPath = await realpath(await mkdtemp(join(tmpdir(), 'ensemble-stream-limit-')));
  const backend = await startBackend({ dataPath, command: process.execPath, bridgePath: join(dataPath, 'bridge.cjs'), providers: [{
    info: { id: 'fixture', name: 'fixture', source: 'plugin', available: true, detail: '', capabilities: { resume: false, approvals: false } }, async run() {},
  }] });
  const controller = new AbortController(), restoredController = new AbortController();
  const streams = new Map<BoundedEventStream, { disposed: boolean; response: ServerResponse }>();
  const originalSend = BoundedEventStream.prototype.send;
  BoundedEventStream.prototype.send = function(event, value) {
    if (event === 'snapshot') streams.set(this, this as unknown as { disposed: boolean; response: ServerResponse });
    originalSend.call(this, event, value);
  };
  let subscription: Promise<void> | undefined, restored: Promise<void> | undefined;
  const tracker = new BackendConnectionTracker(() => {});
  let latest: Snapshot | undefined, failure: unknown;
  try {
    const small = await backend.service.engine.createSession({ title: 'small', cwd: dataPath, providerId: 'fixture' });
    const large = await backend.service.engine.createSession({ title: 'large', cwd: dataPath, providerId: 'fixture' });
    backend.service.store.state.sessions.find(session => session.id === small)!.messages = [{ id: 'small-message', role: 'assistant', text: 'readable cached result', createdAt: 'now' }];
    backend.service.store.state.sessions.find(session => session.id === large)!.messages = [{ id: 'large-message', role: 'assistant', text: 'x'.repeat(8 * 1024 * 1024 + 1), createdAt: 'now' }];
    const client = new BackendClient(backend.endpoint);
    await client.watchSessions([small]);
    const generation = tracker.begin(backend.endpoint.instanceId);
    subscription = client.subscribe((snapshot, frame) => {
      if (tracker.received(generation, frame)) latest = snapshot;
    }, controller.signal).catch(error => {
      if (!controller.signal.aborted) { failure = error; tracker.disconnected(generation, error); }
    });
    await until(() => tracker.current.synced);
    const cached = latest;
    assert.equal(cached!.sessions.find(session => session.id === small)!.messages[0].text, 'readable cached result');
    const failedStream = [...streams.values()][0];
    assert.ok(failedStream);
    const socket = failedStream.response.socket!;
    const writtenBeforeFailure = socket.bytesWritten;
    await client.watchSessions([large]);
    await subscription;
    assert.ok(failure instanceof BackendFrameTooLargeError);
    assert.equal(failure.code, 'FRAME_TOO_LARGE'); assert.equal(failure.limitBytes, 8 * 1024 * 1024);
    assert.match(tracker.current.error ?? '', /8 MiB/);
    assert.equal(tracker.current.synced, false);
    assert.strictEqual(latest, cached);
    assert.equal(failedStream.disposed, true);
    assert.equal(failedStream.response.writableEnded, true);
    assert.equal(failedStream.response.listenerCount('drain'), 0);
    assert.ok(socket.bytesWritten - writtenBeforeFailure < 1024, 'The oversized body was sent instead of the small reason event');
    await client.watchSessions([small]);
    const nextGeneration = tracker.begin(backend.endpoint.instanceId);
    assert.match(tracker.current.error ?? '', /8 MiB/);
    assert.equal(tracker.current.synced, false);
    restored = client.subscribe((snapshot, frame) => {
      if (tracker.received(nextGeneration, frame)) latest = snapshot;
    }, restoredController.signal).catch(error => { if (!restoredController.signal.aborted) throw error; });
    await until(() => tracker.current.synced);
    assert.equal(tracker.current.error, undefined);
    assert.equal(latest!.sessions.find(session => session.id === small)!.messages[0].text, 'readable cached result');
    assert.equal(latest!.sessions.find(session => session.id === large)!.messages.length, 0);
    restoredController.abort(); await restored;
    await until(() => [...streams.values()].every(stream => stream.disposed));
    assert.equal(streams.size, 2);
    for (const stream of streams.values()) assert.equal(stream.response.listenerCount('drain'), 0);
  } finally {
    controller.abort(); restoredController.abort();
    await Promise.allSettled([subscription, restored].filter((promise): promise is Promise<void> => !!promise));
    BoundedEventStream.prototype.send = originalSend;
    await backend.close(); await rm(dataPath, { recursive: true, force: true });
  }
});
