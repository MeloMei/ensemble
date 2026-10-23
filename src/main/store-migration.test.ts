import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { StateStore, type StoreTransaction } from './store';
import { emptyCollaborationState, type CollaborationDefinition, type CollaborationRun } from '../shared/collaboration';

const now = '2026-10-20T00:00:00.000Z';
const definition: CollaborationDefinition = {
  id: 'definition', version: 1, name: 'User-defined collaboration', cwd: '/project',
  participants: [{ id: 'participant', name: 'A', mode: 'external', roles: ['用户自定职责'],
    permissions: { submitTasks: true, sendMessages: true, configureRun: false, publishArtifacts: true } }],
  relationships: [], limits: {}, createdAt: now, updatedAt: now,
};
const run = (status: CollaborationRun['status'] = 'draft'): CollaborationRun => ({
  id: 'run', definitionId: definition.id, definitionVersion: definition.version, definitionSnapshot: structuredClone(definition),
  status, createdBy: 'identity', createdAt: now, updatedAt: now,
});

function legacyState() {
  return {
    version: 1,
    sessions: [{
      id: 'session', title: 'Real historical session', providerId: 'codex', cwd: '/project', status: 'completed',
      externalId: 'native-session-id', nativeId: 'legacy-native-field', archived: true,
      attempts: [{ id: 'old-failure', status: 'failed', prompt: 'first', userMessageId: 'user', retryOf: 'previous',
        startedAt: now, endedAt: now, error: 'retain original error', nativeAttemptMetadata: { turn: 'native-turn' } }],
      messages: [{ id: 'answer', role: 'assistant', text: 'actual result', createdAt: now, nativeTurnId: 'native-turn',
        providerMetadata: { receipt: 'real-response' } }],
      approvals: [], usage: [{ id: 'usage', source: 'codex', scope: 'turn', inputTokens: 17, outputTokens: 3, createdAt: now }],
      createdAt: now, updatedAt: now,
    }],
    workflows: [{ id: 'workflow', name: 'Original failed workflow', cwd: '/project', status: 'failed',
      steps: [{ id: 'step', title: 'original', providerId: 'codex', prompt: 'do work', dependsOn: [], status: 'failed',
        sessionId: 'session', error: 'original failure', attempts: [{ id: 'step-attempt', sessionId: 'session', status: 'failed', startedAt: now, endedAt: now, error: 'original failure' }] }],
      createdAt: now, updatedAt: now }],
    workspaces: [{ id: 'workspace', name: 'Project', cwd: '/project', pinned: true,
      tabs: [{ id: 'agent-tab', kind: 'agent', sessionId: 'session' }], activeTabId: 'agent-tab', createdAt: now, updatedAt: now }],
    mails: [{ id: 'mail', fromSessionId: 'session', toSessionId: 'other', attemptId: 'old-failure', toAttemptId: 'recipient-attempt',
      kind: 'result', text: 'real child result', delivered: true, createdAt: now }],
    receipts: [{ key: 'old-request', hash: 'original-hash', result: { sessionId: 'session', queued: false } }],
    originalEvidence: { report: '/retained/history.json' },
  };
}

test('imports all legacy history once and SQLite becomes the only writable source', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  const legacy = legacyState();
  const source = JSON.stringify(legacy, null, 2);
  await writeFile(path, source);
  const store = new StateStore(path);
  await store.load();
  assert.deepEqual(store.state, { ...legacy, collaboration: emptyCollaborationState() });
  store.state.sessions[0].title = 'Updated only in SQLite';
  await store.flush();
  assert.equal(await readFile(path, 'utf8'), source);
  assert.equal((await readFile(store.databasePath)).subarray(0, 16).toString(), 'SQLite format 3\0');
  await store.close();

  await writeFile(path, '{ invalid legacy source after successful migration');
  const reopened = new StateStore(path);
  await reopened.load();
  assert.equal(reopened.state.sessions.length, 1);
  assert.equal(reopened.state.sessions[0].title, 'Updated only in SQLite');
  assert.equal(reopened.state.sessions[0].externalId, 'native-session-id');
  assert.equal(reopened.state.sessions[0].attempts?.[0].error, 'retain original error');
  assert.equal(reopened.state.workflows[0].steps[0].attempts?.[0].error, 'original failure');
  await reopened.close();
});

test('persists interruption recovery once without altering completed or failed attempts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  const legacy = legacyState();
  legacy.sessions[0].status = 'running';
  legacy.sessions[0].attempts.push({ ...legacy.sessions[0].attempts[0], id: 'unfinished', status: 'running', error: '' });
  const collaboration = emptyCollaborationState();
  collaboration.definitions.push(structuredClone(definition));
  collaboration.runs.push(run('running'));
  collaboration.tasks.push({ id: 'task', runId: 'run', participantId: 'participant', createdBy: 'identity', title: 'work', prompt: 'execute',
    definitionVersion: 1, participantSnapshot: structuredClone(definition.participants[0]),
    dependsOn: [], artifactIds: [], status: 'running', attempts: [{ id: 'attempt', status: 'running', inputArtifactIds: [], outputArtifactIds: [], startedAt: now }],
    attemptId: 'attempt', createdAt: now, updatedAt: now });
  await writeFile(path, JSON.stringify({ ...legacy, collaboration }));
  const store = new StateStore(path);
  await store.load();
  assert.equal(store.state.sessions[0].status, 'interrupted');
  assert.equal(store.state.sessions[0].attempts?.[0].status, 'failed');
  assert.equal(store.state.sessions[0].attempts?.[0].error, 'retain original error');
  assert.equal(store.state.sessions[0].attempts?.[1].status, 'interrupted');
  assert.equal(store.state.collaboration.runs[0].status, 'interrupted');
  assert.equal(store.state.collaboration.tasks[0].attempts[0].status, 'interrupted');
  const endedAt = store.state.collaboration.tasks[0].attempts[0].endedAt;
  assert.deepEqual(store.events('run').map(event => event.type), ['run.interrupted', 'task.interrupted']);
  await store.close();
  const reopened = new StateStore(path);
  await reopened.load();
  assert.equal(reopened.state.collaboration.tasks[0].attempts[0].endedAt, endedAt);
  assert.equal(reopened.events('run').length, 2);
  await reopened.close();
});

test('state, ordered events and request receipts commit together and roll back on commit failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-transaction-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let store = new StateStore(join(directory, 'state.json'));
  await store.load();
  let expiredTransaction: StoreTransaction | undefined;
  store.atomic((state, transaction) => {
    expiredTransaction = transaction;
    state.collaboration.runs.push(run());
    const event = transaction.appendEvent({ id: 'first', runId: 'run', type: 'run.created', source: 'platform', data: {}, createdAt: now });
    transaction.putReceipt({ key: 'request-1', hash: 'hash-1', runId: 'run', result: { seq: event.seq }, createdAt: now });
  });
  const firstSeq = store.events('run')[0].seq;
  assert.deepEqual(store.receipt('request-1')?.result, { seq: firstSeq });
  assert.throws(() => expiredTransaction!.appendEvent({ id: 'out-of-transaction', runId: 'run', type: 'invalid', source: 'platform', data: {}, createdAt: now }), /事务已经结束/);
  await store.close();

  const constraint = new DatabaseSync(store.databasePath);
  constraint.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE commit_parent (id INTEGER PRIMARY KEY);
    CREATE TABLE commit_child (parent_id INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER fail_snapshot_commit AFTER UPDATE ON state_snapshot BEGIN INSERT INTO commit_child(parent_id) VALUES (1); END;
  `);
  constraint.close();
  store = new StateStore(store.path);
  await store.load();
  const originalState = store.state, originalRuns = store.state.collaboration.runs, originalRun = originalRuns[0];
  assert.throws(() => store.atomic((state, transaction) => {
    state.collaboration.runs[0].error = 'must roll back';
    transaction.appendEvent({ id: 'uncommitted', runId: 'run', type: 'task.created', source: 'external', cause: 'first', data: {}, createdAt: now });
    transaction.putReceipt({ key: 'uncommitted-request', hash: 'hash-2', result: { accepted: true }, createdAt: now });
  }), /FOREIGN KEY constraint failed/);
  assert.equal(store.state.collaboration.runs[0].error, undefined);
  assert.equal(store.state, originalState); assert.equal(store.state.collaboration.runs, originalRuns); assert.equal(originalRuns[0], originalRun);
  assert.equal(store.events('run').length, 1);
  assert.equal(store.receipt('uncommitted-request'), undefined);
  await store.close();
  const cleanup = new DatabaseSync(store.databasePath);
  cleanup.exec('DROP TRIGGER fail_snapshot_commit');
  cleanup.close();
  store = new StateStore(store.path);
  await store.load();

  store.atomic((state, transaction) => {
    state.collaboration.runs[0].error = 'committed change';
    transaction.appendEvent({ id: 'second', runId: 'run', type: 'run.updated', source: 'external', cause: 'first', data: {}, createdAt: now });
    transaction.putReceipt({ key: 'request-2', hash: 'hash-2', result: { accepted: true }, createdAt: now });
  });
  assert.equal(store.events('run', firstSeq)[0].id, 'second');
  assert.ok(store.events('run')[1].seq > firstSeq);
  await store.close();
  const reopened = new StateStore(store.path);
  await reopened.load();
  assert.equal(reopened.state.collaboration.runs[0].error, 'committed change');
  assert.equal(reopened.events('run').length, 2);
  assert.deepEqual(reopened.receipt('request-2')?.result, { accepted: true });
  await reopened.close();
});

test('rollback restores replaced nested objects and JSON own properties without changing identity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-rollback-identity-'));
  const store = new StateStore(join(directory, 'state.json'));
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  await store.load();
  const result = JSON.parse('{"__proto__":{"original":true},"entries":[{"value":"original"}]}');
  store.atomic(state => { state.receipts.push({ key: 'json-result', hash: 'fixture', result }); });
  const receipts = store.state.receipts, entry = result.entries[0], proto = Object.getPrototypeOf(result);
  assert.throws(() => store.atomic(state => {
    result.entries[0].value = 'mutated'; result.entries = []; result.added = true;
    delete result.__proto__; state.receipts = [];
    throw new Error('reject changed graph');
  }), /reject changed graph/);
  assert.equal(store.state.receipts, receipts); assert.equal(receipts[0].result, result); assert.equal(result.entries[0], entry);
  assert.equal(entry.value, 'original'); assert.equal(result.added, undefined); assert.equal(Object.getPrototypeOf(result), proto);
  assert.equal(Object.hasOwn(result, '__proto__'), true); assert.deepEqual(result.__proto__, { original: true });
  await store.flush();
});

test('SQLite owns the data directory exclusively until the backend closes its connection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-owner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = new StateStore(join(directory, 'state.json'));
  await first.load();
  first.atomic(state => { state.collaboration.runs.push(run()); });
  const competing = new StateStore(first.path);
  await assert.rejects(competing.load(), /已有后台持有/);
  await competing.close();
  assert.equal(first.state.collaboration.runs.length, 1);
  await first.close();
  const successor = new StateStore(first.path);
  await successor.load();
  assert.equal(successor.state.collaboration.runs.length, 1);
  await successor.close();
});

test('real process death preserves committed changes and discards an unfinished transaction', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-crash-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  const storeUrl = new URL('./store.ts', import.meta.url).href;
  const execute = (commit: boolean) => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { StateStore } from ${JSON.stringify(storeUrl)};
    const store = new StateStore(${JSON.stringify(path)});
    await store.load();
    store.atomic((state, transaction) => {
      state.collaboration.runs.push(${JSON.stringify(run())});
      transaction.appendEvent({ id: 'crash-event', runId: 'run', type: 'run.created', source: 'platform', data: {}, createdAt: ${JSON.stringify(now)} });
      transaction.putReceipt({ key: 'crash-request', hash: 'crash-hash', result: { saved: true }, createdAt: ${JSON.stringify(now)} });
      ${commit ? '' : "process.kill(process.pid, 'SIGKILL');"}
    });
    process.kill(process.pid, 'SIGKILL');
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 });

  const unfinished = execute(false);
  assert.equal(unfinished.signal, 'SIGKILL', unfinished.stderr);
  const afterCrash = new StateStore(path);
  await afterCrash.load();
  assert.equal(afterCrash.state.collaboration.runs.length, 0);
  assert.equal(afterCrash.events('run').length, 0);
  assert.equal(afterCrash.receipt('crash-request'), undefined);
  await afterCrash.close();

  const committed = execute(true);
  assert.equal(committed.signal, 'SIGKILL', committed.stderr);
  const afterCommit = new StateStore(path);
  await afterCommit.load();
  assert.equal(afterCommit.state.collaboration.runs.length, 1);
  assert.equal(afterCommit.events('run').length, 1);
  assert.deepEqual(afterCommit.receipt('crash-request')?.result, { saved: true });
  await afterCommit.close();
});
