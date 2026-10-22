import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BackendClient } from '../main/backend-client';
import { TerminalInputWriter } from './terminal-input-writer';

test('terminal input preserves byte order through delayed transport and flush waits for new queued input', async () => {
  const received: Record<string, string> = {};
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const { command, args: [id, data] } = JSON.parse(body);
    assert.equal(command, 'workbench:write-terminal');
    if (id === 'one' && data === 'A') { started(); await gate; }
    received[id] = (received[id] ?? '') + data;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ result: null }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const client = new BackendClient({ version: 1, url: `http://127.0.0.1:${address.port}`, token: 'a'.repeat(64), pid: process.pid, instanceId: 'terminal-input-test', startedAt: new Date().toISOString() });
    const writer = new TerminalInputWriter((id, data) => client.call('workbench:write-terminal', id, data));
    const first = writer.write('one', 'A');
    await firstStarted;
    const closing = writer.flush();
    const queued = [writer.write('one', 'B'), writer.write('one', 'C')];
    await writer.write('two', 'independent');
    assert.equal(received.one, undefined);
    assert.equal(received.two, 'independent');
    release();
    await closing;
    assert.equal(received.one, 'ABC');
    await Promise.all([first, ...queued]);
  } finally { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('terminal input rejects a failed batch without sending its suffix or automatically retrying it', async () => {
  const sent: string[] = [];
  const writer = new TerminalInputWriter(async (_id, data) => {
    sent.push(data);
    if (data === 'failed') throw new Error('connection lost');
  });
  const failed = writer.write('one', 'failed');
  const suffix = writer.write('one', 'must not run');
  const result = Promise.allSettled([failed, suffix]);
  await assert.rejects(writer.flush(), /connection lost/);
  assert.deepEqual((await result).map(value => value.status), ['rejected', 'rejected']);
  assert.deepEqual(sent, ['failed']);
  await writer.write('one', 'new input');
  await writer.flush();
  assert.deepEqual(sent, ['failed', 'new input']);
});

test('terminal flush waits for other terminals before reporting an input failure', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writer = new TerminalInputWriter(async id => {
    if (id === 'failed') throw new Error('connection lost');
    await gate;
  });
  let settled = false;
  const failed = writer.write('failed', 'A').catch(() => {});
  const slow = writer.write('slow', 'B');
  const closing = assert.rejects(writer.flush().finally(() => { settled = true; }), /connection lost/);
  try {
    await failed;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    release(); await slow; await closing;
    assert.equal(writer.hasPending, false);
  } finally { release(); await slow; await closing; }
});

test('terminal flush observes a new write that fails while another terminal is draining', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writer = new TerminalInputWriter(async id => {
    if (id === 'new') throw new Error('new input failed');
    await gate;
  });
  const first = writer.write('first', 'A');
  const closing = writer.flush();
  const result = assert.rejects(closing, /new input failed/);
  try {
    await assert.rejects(writer.write('new', 'B'), /new input failed/);
    release(); await first; await result;
  } finally { release(); await first; }
});
