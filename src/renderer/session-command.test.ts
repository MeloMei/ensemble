import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session, SessionCommandReceipt } from '../shared/types';
import { recoverSessionCommands, runSessionCommand, runSessionStopCommand } from './session-command';

function environment(lookup: (id: string) => Promise<SessionCommandReceipt | undefined>) {
  const previous = ['localStorage', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); },
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { workbench: { commandReceipt: lookup } } });
  return { values, restore() { for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  } } };
}

const receipt = (commandId: string, kind: string, result: unknown): SessionCommandReceipt => ({ commandId, kind, result, createdAt: '' });
async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  assert.fail('command state did not settle');
}

test('Stop retries reuse a command only within the same attempt after an acknowledgement is lost', async () => {
  const receipts = new Map<string, SessionCommandReceipt>();
  const runtime = environment(async id => receipts.get(id));
  const session = (attemptId?: string): Pick<Session, 'id' | 'attempts'> => ({ id: 'stop-retry-session',
    ...(attemptId ? { attempts: [{ id: attemptId, status: 'running', prompt: 'work', userMessageId: 'user', startedAt: '' }] } : {}) });
  const ids: string[] = [];
  let lost = true;
  try {
    await runSessionStopCommand(session('A'), async (commandId, expectedAttemptId) => {
      assert.equal(expectedAttemptId, 'A');
      ids.push(commandId); receipts.set(commandId, receipt(commandId, 'cancel-session', null));
      if (lost) { lost = false; throw new Error('acknowledgement lost'); }
    });
    await runSessionStopCommand(session('B'), async (commandId, expectedAttemptId) => { assert.equal(expectedAttemptId, 'B'); ids.push(commandId); });
    assert.equal(ids[0], ids[1]); assert.notEqual(ids[0], ids[2]);
    await assert.rejects(runSessionStopCommand(session(), async commandId => { ids.push(commandId); throw new Error('acknowledgement lost'); }), /acknowledgement lost/);
    await runSessionStopCommand(session(), async commandId => { ids.push(commandId); });
    assert.notEqual(ids[3], ids[4]);
  } finally { runtime.restore(); }
});

test('receipt recovery completes late send/create callbacks, retires only their IDs and leaves terminal replays out of automatic recovery', async () => {
  const receipts = new Map<string, SessionCommandReceipt>(), results = new Map<string, unknown>();
  const ids = { send: [] as string[], create: [] as string[] }, effects = { send: 0, create: 0 }, callbacks = { send: 0, create: 0 };
  let connected = false, lookupOverride: ((id: string) => Promise<SessionCommandReceipt | undefined>) | undefined;
  let queries = 0;
  const runtime = environment(async id => {
    queries++;
    if (lookupOverride) return lookupOverride(id);
    if (!connected && receipts.get(id)?.kind === 'send-prompt') throw new Error('offline');
    return receipts.get(id);
  });
  const sendScope = 'send:receipt-recovery', createScope = 'create-session:receipt-recovery';
  const sendKey = `ensemble:command:${sendScope}`, createKey = `ensemble:command:${createScope}`;
  const draftA = { text: 'same text' }; let currentDraft = draftA;
  let sendLost = false, createLost = false;
  const send = (expected: typeof draftA) => async (id: string) => {
    ids.send.push(id);
    if (!results.has(id)) { effects.send++; results.set(id, null); receipts.set(id, receipt(id, 'send-prompt', { sessionId: 'session', queueItemId: id })); }
    if (!sendLost) { sendLost = true; throw new Error('lost send acknowledgement'); }
    callbacks.send++; if (currentDraft === expected) currentDraft = { text: '' };
  };
  const create = async (id: string) => {
    ids.create.push(id);
    if (!createLost) { createLost = true; throw new Error('request is still being processed'); }
    if (!results.has(id)) { effects.create++; results.set(id, `session-${effects.create}`); receipts.set(id, receipt(id, 'create-session', results.get(id))); }
    callbacks.create++; return results.get(id) as string;
  };
  let releaseLookup: ((value: SessionCommandReceipt) => void) | undefined, releaseOperation: (() => void) | undefined;
  try {
    const sendError = runSessionCommand(sendScope, draftA, send(draftA)).then(() => undefined, error => error as Error);
    const createInput = { title: 'same title', cwd: '/fixture', providerId: 'fixture' };
    const createError = runSessionCommand(createScope, createInput, create).then(() => undefined, error => error as Error);
    assert.match((await sendError)!.message, /核对/); assert.match((await createError)!.message, /核对/);
    const savedSend = runtime.values.get(sendKey)!, savedCreate = runtime.values.get(createKey)!;
    assert.deepEqual(callbacks, { send: 0, create: 0 });
    effects.create++; results.set(ids.create[0], 'session-1'); receipts.set(ids.create[0], receipt(ids.create[0], 'create-session', 'session-1'));
    const newerDraft = { text: 'same text' }; currentDraft = newerDraft;
    connected = true; await recoverSessionCommands();
    assert.deepEqual(effects, { send: 1, create: 1 }); assert.deepEqual(callbacks, { send: 1, create: 1 });
    assert.equal(currentDraft, newerDraft); assert.equal(ids.send[0], ids.send[1]); assert.equal(ids.create[0], ids.create[1]);
    await runSessionCommand(sendScope, newerDraft, send(newerDraft));
    await runSessionCommand(createScope, createInput, create);
    assert.deepEqual(effects, { send: 2, create: 2 }); assert.notEqual(ids.send[0], ids.send[2]); assert.notEqual(ids.create[0], ids.create[2]);

    const callsBeforeReload = ids.send.length; runtime.values.set(sendKey, savedSend);
    const untouchedDraft = { text: 'new saved draft' }; currentDraft = untouchedDraft;
    await recoverSessionCommands();
    assert(!runtime.values.has(sendKey)); assert.equal(ids.send.length, callsBeforeReload); assert.equal(currentDraft, untouchedDraft);

    runtime.values.set(createKey, savedCreate);
    let lookupStarted = false;
    lookupOverride = async id => {
      if (id !== ids.create[0]) return receipts.get(id);
      lookupStarted = true; return new Promise(resolve => { releaseLookup = resolve as (value: SessionCommandReceipt) => void; });
    };
    const oldRecovery = recoverSessionCommands(); await until(() => lookupStarted);
    let newId = '';
    const newerCreate = runSessionCommand(createScope, { ...createInput, title: 'new intent' }, async id => {
      newId = id; await new Promise<void>(resolve => { releaseOperation = resolve; }); return 'new-session';
    });
    await until(() => Boolean(newId)); releaseLookup!(receipts.get(ids.create[0])!); await oldRecovery;
    assert.equal(JSON.parse(runtime.values.get(createKey)!).commandId, newId);
    releaseOperation!(); await newerCreate; lookupOverride = undefined;

    let modalCommand = '', oldCompletions = 0, currentCompletions = 0;
    await assert.rejects(runSessionCommand('create-session:manual-owner', createInput, async id => {
      modalCommand = id;
      if (!receipts.has(id)) throw new Error('old modal lost acknowledgement');
      oldCompletions++; return 'same-session';
    }), /核对/);
    receipts.set(modalCommand, receipt(modalCommand, 'create-session', 'same-session'));
    await runSessionCommand('create-session:manual-owner', createInput, async id => {
      assert.equal(id, modalCommand); currentCompletions++; return 'same-session';
    });
    assert.equal(oldCompletions, 0); assert.equal(currentCompletions, 1);

    let failedCalls = 0;
    await assert.rejects(runSessionCommand('create-worktree:terminal-failure', { cwd: '/fixture' }, async id => {
      failedCalls++; receipts.set(id, receipt(id, 'create-worktree', { operationId: 'failed' })); throw new Error('provision failed');
    }), /provision failed/);
    const queriesAfterFailure = queries;
    await recoverSessionCommands(); await recoverSessionCommands();
    assert.equal(failedCalls, 2); assert.equal(queries, queriesAfterFailure);
  } finally { releaseLookup?.(receipt('cleanup', 'cleanup', null)); releaseOperation?.(); runtime.restore(); }
});
