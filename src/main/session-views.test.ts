import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import type { FileContent, Message, ProviderInfo } from '../shared/types';
import type { SessionHistoryWindow } from '../shared/backend';
import type { ProviderAdapter } from './providers/types';
import { createWorkbenchService, type WorkbenchService } from './workbench-service';
import { WorkspaceFiles } from './workspace-files';

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

test('service provider health isolates directory evidence and invalidates authentication after a binary identity change', async () => {
  const fixture = await createFixture(async context => {
    if (context.prompt === 'authentication-error') throw new Error('401 unauthorized fixture');
    context.emit({ type: 'text', itemId: 'health-result', text: 'Completed fixture turn' });
  });
  try {
    const health = async (cwd?: string) => (await fixture.service.call('workbench:provider-health', [cwd]) as ProviderInfo[]).find(provider => provider.id === fixture.info.id)!;
    const initial = await health(fixture.firstProject);
    assert.equal(initial.available, true); assert.equal(initial.health?.cwd, fixture.firstProject);
    assert.equal(initial.health?.checks.binary.status, 'ready');
    assert.equal(initial.health?.checks.authentication.status, 'unknown');
    assert.equal(initial.health?.checks.quota.status, 'unknown'); assert.equal(initial.health?.checks.quota.source, 'no-quota-source');
    assert.equal(Object.values(initial.health!.checks.quota).some(value => value === 0), false);
    const firstId = await fixture.service.engine.createSession({ title: 'Project A', providerId: fixture.info.id, cwd: fixture.firstProject });
    const secondId = await fixture.service.engine.createSession({ title: 'Project B', providerId: fixture.info.id, cwd: fixture.secondProject });
    await fixture.service.call('workbench:send-prompt', [firstId, { text: 'complete' }, 'health-first']); await fixture.service.engine.waitSession(firstId);
    assert.equal((await health(fixture.firstProject)).health?.checks.authentication.status, 'ready');
    assert.equal((await health(fixture.firstProject)).health?.checks.authentication.source, 'completed-turn');
    assert.equal((await health(fixture.secondProject)).health?.checks.authentication.status, 'unknown');
    assert.equal((await health()).health?.checks.authentication.status, 'unknown');
    await fixture.service.call('workbench:send-prompt', [secondId, { text: 'authentication-error' }, 'health-second']); await fixture.service.engine.waitSession(secondId);
    assert.equal((await health(fixture.secondProject)).health?.checks.authentication.status, 'error');
    assert.equal((await health(fixture.firstProject)).health?.checks.authentication.status, 'ready');
    assert.equal((await health(fixture.firstProject)).health?.checks.quota.status, 'unknown');
    fixture.info.detail = 'different-fixture-binary@v2';
    const changed = await health(fixture.firstProject);
    assert.equal(changed.available, true); assert.equal(changed.detail, fixture.info.detail);
    assert.equal(changed.health?.checks.authentication.status, 'unknown');
    assert.equal((await health(fixture.secondProject)).health?.checks.authentication.status, 'unknown');
  } finally { await fixture.close(); }
});

test('service worktree access fences alias saves and persistent removal admission', { timeout: 20_000 }, async () => {
  let providerRuns = 0;
  const fixture = await createFixture(async () => { providerRuns++; });
  const originalWrite = WorkspaceFiles.prototype.write;
  let allowWrite!: () => void, reportEntered!: () => void;
  const gate = new Promise<void>(resolve => { allowWrite = resolve; });
  const entered = new Promise<void>(resolve => { reportEntered = resolve; });
  let saving: Promise<unknown> | undefined;
  try {
    const source = fixture.firstProject, nested = join(source, 'packages', 'app');
    await mkdir(nested, { recursive: true });
    await writeFile(join(source, 'README.md'), 'Access fixture\n');
    await writeFile(join(nested, 'entry.txt'), 'base content\n');
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd: source, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    }).trim();
    git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-qm', 'access fixture base');
    const managedId = await fixture.service.call('workbench:create-workspace', [{ name: 'Access guard', cwd: nested,
      mode: 'worktree', commandId: 'service-access-worktree' }]) as string;
    const operation = fixture.service.store.state.worktreeOperations?.find(item => item.workspaceId === managedId);
    assert(operation);
    const rootAlias = await fixture.service.call('workbench:create-workspace', [{ name: 'Root alias', cwd: operation.path }]) as string;
    const childCwd = join(operation.path, 'packages');
    const childAlias = await fixture.service.call('workbench:create-workspace', [{ name: 'Child alias', cwd: childCwd }]) as string;
    assert.equal(new Set([managedId, rootAlias, childAlias]).size, 3);
    const sessionId = await fixture.service.engine.createSession({ title: 'Must not execute during removal', providerId: fixture.info.id, cwd: childCwd });
    const original = await fixture.service.call('workbench:read-file', [childAlias, 'app/entry.txt']) as FileContent;
    WorkspaceFiles.prototype.write = async function(cwd, input) {
      reportEntered(); await gate;
      return originalWrite.call(this, cwd, input);
    };
    saving = fixture.service.call('workbench:write-file', [childAlias, { path: 'app/entry.txt', content: 'saved via child alias\n', revision: original.revision }]);
    await Promise.race([entered, saving.then(() => assert.fail('The write bypassed its gate'))]);
    assert.equal(await readFile(join(childCwd, 'app', 'entry.txt'), 'utf8'), 'base content\n');
    assert.equal(git('-C', operation.path, 'status', '--porcelain'), '');
    await assert.rejects(fixture.service.call('workbench:remove-worktree', [managedId]), /文件或配置操作未结束/);
    assert.equal((await stat(operation.path)).isDirectory(), true);
    assert.equal(fixture.service.store.state.worktreeOperations?.find(item => item.workspaceId === managedId)?.status, 'ready');
    allowWrite();
    const saved = await saving as FileContent;
    WorkspaceFiles.prototype.write = originalWrite;
    assert.equal(saved.content, 'saved via child alias\n');
    assert.equal(await readFile(join(childCwd, 'app', 'entry.txt'), 'utf8'), saved.content);
    assert.equal(await readFile(join(nested, 'entry.txt'), 'utf8'), 'base content\n');
    fixture.service.store.atomic(state => {
      const pending = state.worktreeOperations!.find(item => item.workspaceId === managedId)!;
      pending.status = 'removing'; pending.cleanupHeadSha = pending.baseSha;
    });
    await fixture.restart();
    assert.equal((await stat(operation.path)).isDirectory(), true);
    assert.equal(fixture.service.store.state.worktreeOperations?.find(item => item.workspaceId === managedId)?.status, 'removing');
    const terminalCount = fixture.service.snapshot().terminals.length;
    for (const [workspaceId, path] of [[rootAlias, 'packages/app/entry.txt'], [childAlias, 'app/entry.txt']]) {
      await assert.rejects(fixture.service.call('workbench:write-file', [workspaceId, { path, content: 'must not write\n', revision: saved.revision }]), /正在回收/);
      await assert.rejects(fixture.service.call('workbench:create-terminal', [workspaceId]), /正在回收/);
    }
    const before = fixture.service.engine.getSession(sessionId);
    assert.throws(() => fixture.service.engine.executeSession(sessionId, { text: 'must not start' }), /正在回收/);
    const after = fixture.service.engine.getSession(sessionId);
    assert.deepEqual(after.attempts, before.attempts);
    assert.deepEqual(after.messages, before.messages);
    assert.equal(after.status, 'idle'); assert.equal(providerRuns, 0);
    assert.equal(fixture.service.snapshot().terminals.length, terminalCount);
    assert.equal(await readFile(join(childCwd, 'app', 'entry.txt'), 'utf8'), saved.content);
  } finally {
    allowWrite(); WorkspaceFiles.prototype.write = originalWrite;
    await saving?.catch(() => {}); await fixture.close();
  }
});

test('service health does not attribute an old runtime completion to its replacement', async () => {
  let started!: () => void, release!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fixture = await createFixture(async () => { started(); await gate; });
  try {
    const id = await fixture.service.engine.createSession({ title: 'Old runtime', providerId: fixture.info.id, cwd: fixture.firstProject });
    await fixture.service.call('workbench:send-prompt', [id, { text: 'old runtime' }, 'old-health-turn']); await running;
    const replacement = { ...fixture.info, detail: 'fixture-binary@v2' };
    fixture.service.engine.setProviders([{ info: replacement, async run() {} }], [], []);
    release(); await fixture.service.engine.waitSession(id);
    const health = async () => (await fixture.service.call('workbench:provider-health', [fixture.firstProject]) as ProviderInfo[]).find(info => info.id === replacement.id)!;
    assert.equal((await health()).health?.checks.authentication.status, 'unknown');
    await fixture.service.call('workbench:send-prompt', [id, { text: 'replacement runtime' }, 'new-health-turn']); await fixture.service.engine.waitSession(id);
    assert.equal((await health()).health?.checks.authentication.status, 'ready');
  } finally { release(); await fixture.close(); }
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
