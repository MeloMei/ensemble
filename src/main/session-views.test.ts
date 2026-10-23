import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import type { Message, ProviderInfo } from '../shared/types';
import type { SessionHistoryWindow } from '../shared/backend';
import type { ProviderAdapter } from './providers/types';
import { createWorkbenchService, type WorkbenchService } from './workbench-service';

async function createFixture(run: ProviderAdapter['run'] = async () => {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ensemble-session-views-')));
  const firstProject = join(directory, 'views-project-a'), secondProject = join(directory, 'views-project-b');
  await Promise.all([mkdir(firstProject), mkdir(secondProject)]);
  const info: ProviderInfo = { id: 'views-fixture', name: 'Views fixture', source: 'plugin', available: true,
    detail: 'fixture-binary@v1', capabilities: { resume: true, approvals: false } };
  const options = { dataPath: join(directory, 'data'), command: process.execPath, bridgePath: join(directory, 'bridge.cjs'),
    providers: [{ info, run }], publish() {} };
  let current: WorkbenchService | undefined;
  try { current = await createWorkbenchService(options); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return {
    directory, firstProject, secondProject, info,
    get service() { assert(current, 'Fixture backend is closed'); return current; },
    async restart() { await current!.shutdown(); current = undefined; current = await createWorkbenchService(options); },
    async close() { try { await current?.shutdown(); } finally { await rm(directory, { recursive: true, force: true }); } },
  };
}

const timestamp = '2026-10-23T00:00:00Z';
const sorted = (values: string[]) => [...values].sort();

test('service history cursors and search preserve bounded views and recover full matching messages', async () => {
  const fixture = await createFixture();
  const { service } = fixture;
  try {
    const id = await service.engine.createSession({ title: 'History fixture', providerId: fixture.info.id, cwd: fixture.firstProject });
    const archivedId = await service.engine.createSession({ title: 'Archived needle title', providerId: fixture.info.id, cwd: fixture.firstProject });
    service.engine.updateSession(archivedId, { archived: true });
    const logId = await service.engine.createSession({ title: 'Activity-only fixture', providerId: fixture.info.id, cwd: fixture.secondProject });
    const longId = `native-message-${'long-'.repeat(60)}`;
    assert(longId.length > 200 && longId.length < 4096);
    const messages: Message[] = Array.from({ length: 450 }, (_, index) => ({ id: index === 225 ? longId : `message-${index}`,
      role: index % 3 ? 'assistant' : 'user', text: `History row ${index}`, createdAt: timestamp }));
    const fullText = `${'Long prefix. '.repeat(2500)}NEEDLE body match${' Long suffix.'.repeat(2500)}`;
    messages[300] = { ...messages[300], text: fullText };
    messages[301] = { ...messages[301], role: 'activity', text: '', event: { id: 'large-tool', kind: 'tool', title: 'Large tool', status: 'completed',
      input: `${'tool input '.repeat(2000)}needle event match`, output: 'tool output '.repeat(3000) }, attachments: [{
      id: 'attachment', name: 'large-note.txt', kind: 'text', ownedPath: join(fixture.directory, 'not-opened.txt'),
      mimeType: 'text/plain', size: 3000, sha256: 'a'.repeat(64),
    }] };
    service.store.atomic(state => {
      state.sessions.find(session => session.id === id)!.messages = messages;
      state.sessions.find(session => session.id === logId)!.messages = [{ id: 'plain-activity', role: 'activity', text: 'activity-only-secret', createdAt: timestamp }];
    });

    let page = await service.call('workbench:session-history', [id, undefined, 73]) as SessionHistoryWindow;
    assert.deepEqual(page.messages.map(message => message.id), messages.slice(-73).map(message => message.id));
    let all = page.messages;
    while (page.hasMore) {
      assert(page.beforeCursor);
      const next = await service.call('workbench:session-history', [id, page.beforeCursor, 73]) as SessionHistoryWindow;
      assert(next.messages.length > 0 && next.messages.length <= 73);
      assert.equal(next.messages.some(message => all.some(existing => existing.id === message.id)), false);
      all = [...next.messages, ...all]; page = next;
    }
    assert.deepEqual(all.map(message => message.id), messages.map(message => message.id));
    assert.equal(new Set(all.map(message => message.id)).size, 450);

    const around = await service.call('workbench:session-history-around', [id, longId, 21]) as SessionHistoryWindow;
    assert.deepEqual(around.messages.map(message => message.id), messages.slice(215, 236).map(message => message.id));
    assert(around.beforeCursor && around.afterCursor && around.hasMore && around.hasAfter);
    const beforeLongId = await service.call('workbench:session-history', [id, longId, 10]) as SessionHistoryWindow;
    const afterLongId = await service.call('workbench:session-history-after', [id, longId, 10]) as SessionHistoryWindow;
    assert.deepEqual(beforeLongId.messages.map(message => message.id), messages.slice(215, 225).map(message => message.id));
    assert.deepEqual(afterLongId.messages.map(message => message.id), messages.slice(226, 236).map(message => message.id));
    const before = await service.call('workbench:session-history', [id, around.beforeCursor, 21]) as SessionHistoryWindow;
    const after = await service.call('workbench:session-history-after', [id, around.afterCursor, 21]) as SessionHistoryWindow;
    assert.deepEqual([...before.messages, ...around.messages, ...after.messages].map(message => message.id), messages.slice(194, 257).map(message => message.id));

    const search = await service.call('workbench:session-search', [id, 'needle', 10]) as { messages: Message[]; truncated: boolean };
    assert.equal(search.truncated, false);
    assert.deepEqual(search.messages.map(message => message.id), [messages[300].id, messages[301].id]);
    for (const summary of search.messages) {
      assert(summary.text.length <= 2000 && /needle/i.test(summary.text));
      assert.deepEqual(Object.keys(summary).sort(), ['createdAt', 'id', 'role', 'text']);
    }
    assert.equal((await service.call('workbench:session-search', [id, 'needle', 1]) as { truncated: boolean }).truncated, true);
    const raw = await service.call('workbench:session-history-around', [id, messages[300].id, 5]) as SessionHistoryWindow;
    assert.equal(raw.messages.find(message => message.id === messages[300].id)?.text, fullText);
    assert.deepEqual(raw.messages.find(message => message.id === messages[301].id)?.event, messages[301].event);
    assert.deepEqual(raw.messages.find(message => message.id === messages[301].id)?.attachments, messages[301].attachments);
    assert.deepEqual(await service.call('workbench:session-search', [logId, 'activity-only-secret', 10]), { messages: [], truncated: false });

    const results = await service.call('workbench:search-sessions', ['needle']) as { sessionIds: string[] };
    assert.deepEqual(Object.keys(results), ['sessionIds']);
    assert.deepEqual(results.sessionIds, [id]);
    assert.deepEqual(sorted((await service.call('workbench:search-sessions', ['needle', true]) as { sessionIds: string[] }).sessionIds), sorted([id, archivedId]));
    assert.deepEqual((await service.call('workbench:search-sessions', [basename(fixture.firstProject), true]) as { sessionIds: string[] }).sessionIds.sort(), sorted([id, archivedId]));

    const expired = longId;
    service.store.atomic(state => { const item = state.sessions.find(session => session.id === id)!; item.messages = item.messages.filter(message => message.id !== expired); });
    await assert.rejects(service.call('workbench:session-history', [id, expired, 20]), /游标.*失效/);
    await assert.rejects(service.call('workbench:session-history-after', [id, expired, 20]), /游标.*失效/);
    await assert.rejects(service.call('workbench:session-history-around', [id, expired, 20]), /游标.*失效/);
  } finally { await fixture.close(); }
});
test('service read acknowledgements persist exact revisions without clearing failures or newer results', async () => {
  const fixture = await createFixture(async context => {
    if (context.prompt === 'fail') throw new Error('Fixture requested failure');
    context.emit({ type: 'text', itemId: 'result', text: 'Fixture completed' });
  });
  try {
    const id = await fixture.service.engine.createSession({ title: 'Attention fixture', providerId: fixture.info.id, cwd: fixture.firstProject });
    await fixture.service.call('workbench:send-prompt', [id, { text: 'fail' }, 'attention-failure']); await fixture.service.engine.waitSession(id);
    const failed = fixture.service.engine.getSession(id);
    assert.equal(failed.status, 'failed'); assert.equal(failed.attention?.reason, 'failure');
    assert(failed.attention && failed.attention.revision > failed.attention.seenRevision);
    const failureRevision = failed.attention.revision;
    await fixture.service.call('workbench:mark-session-seen', [id, failureRevision]);
    let state = fixture.service.engine.getSession(id);
    assert.equal(state.status, 'failed'); assert.equal(state.error, 'Fixture requested failure');
    assert.equal(state.attempts?.at(-1)?.status, 'failed'); assert.equal(state.attention?.seenRevision, failureRevision);
    await fixture.restart();
    state = fixture.service.engine.getSession(id);
    assert.equal(state.status, 'failed'); assert.equal(state.attention?.revision, failureRevision); assert.equal(state.attention?.seenRevision, failureRevision);

    await fixture.service.call('workbench:set-session-queue-paused', [id, false]);
    await fixture.service.call('workbench:send-prompt', [id, { text: 'complete' }, 'attention-new-result']); await fixture.service.engine.waitSession(id);
    const completed = fixture.service.engine.getSession(id);
    assert.equal(completed.status, 'completed'); assert.equal(completed.attention?.reason, 'result');
    assert(completed.attention && completed.attention.revision > failureRevision);
    const resultRevision = completed.attention.revision;
    await fixture.service.call('workbench:mark-session-seen', [id, failureRevision]);
    assert.equal(fixture.service.engine.getSession(id).attention?.seenRevision, failureRevision);
    await assert.rejects(fixture.service.call('workbench:mark-session-seen', [id, resultRevision + 1]), /尚未收到/);
    await fixture.service.call('workbench:mark-session-seen', [id, 0]);
    assert.equal(fixture.service.engine.getSession(id).attention?.seenRevision, failureRevision);
    await fixture.restart();
    state = fixture.service.engine.getSession(id);
    assert.equal(state.attention?.revision, resultRevision); assert.equal(state.attention?.seenRevision, failureRevision);
    assert.equal(state.attention?.reason, 'result');
    await fixture.service.call('workbench:mark-session-seen', [id, resultRevision]);
    await fixture.restart();
    assert.equal(fixture.service.engine.getSession(id).attention?.seenRevision, resultRevision);
  } finally { await fixture.close(); }
});
test('service Stop forwarding fences a delayed request to its captured attempt', async () => {
  let firstStarted!: () => void, secondStarted!: () => void, releaseFirst!: () => void;
  const first = new Promise<void>(resolve => { firstStarted = resolve; });
  const second = new Promise<void>(resolve => { secondStarted = resolve; });
  const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let runs = 0, cancelled = false;
  const fixture = await createFixture(async context => {
    if (++runs === 1) { firstStarted(); await gate; return; }
    secondStarted();
    await new Promise<void>(resolve => context.signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
  });
  try {
    const id = await fixture.service.engine.createSession({ title: 'Stop route', providerId: fixture.info.id, cwd: fixture.firstProject });
    await fixture.service.call('workbench:send-prompt', [id, { text: 'first' }, 'route-first']); await first;
    const previousAttempt = fixture.service.engine.getSession(id).attempts!.at(-1)!.id;
    releaseFirst(); await fixture.service.engine.waitSession(id);
    await fixture.service.call('workbench:send-prompt', [id, { text: 'second' }, 'route-second']); await second;
    const currentAttempt = fixture.service.engine.getSession(id).attempts!.at(-1)!.id;
    await assert.rejects(fixture.service.call('workbench:cancel-session', [id, 'delayed-stop', previousAttempt]), /回合已结束/);
    assert.equal(cancelled, false); assert.equal(fixture.service.engine.getSession(id).status, 'running');
    await fixture.service.call('workbench:cancel-session', [id, 'current-stop', currentAttempt]);
    await fixture.service.engine.waitSession(id);
    assert.equal(cancelled, true); assert.equal(fixture.service.engine.getSession(id).status, 'cancelled');
  } finally { releaseFirst(); await fixture.close(); }
});
