import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkbenchEngine } from './engine';
import { ManagedWorktrees } from './managed-worktrees';
import { StateStore } from './store';
import type { ProviderAdapter, TurnContext } from './providers/types';
import type { WorktreeOperation } from '../shared/types';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('state did not settle');
}

async function fixture(run: (context: TurnContext) => Promise<void> = async () => { throw new Error('unexpected provider execution'); }) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ensemble-worktree-')));
  const source = join(directory, 'source'), nested = join(source, 'packages', 'app'), managed = join(directory, 'managed');
  await mkdir(nested, { recursive: true });
  git(source, 'init', '-q', '-b', 'main');
  await writeFile(join(source, 'README.md'), 'source repository\n');
  await writeFile(join(nested, 'entry.txt'), 'base contents\n');
  git(source, 'add', '.'); git(source, 'commit', '-qm', 'base');
  const provider: ProviderAdapter = { info: { id: 'fixture', name: 'Fixture', source: 'plugin', available: true, detail: '', capabilities: { resume: true, approvals: true } }, run };
  const statePath = join(directory, 'data', 'state.json');
  const initialStore = new StateStore(statePath); await initialStore.load();
  const initialEngine = new WorkbenchEngine(initialStore, '', () => {}); initialEngine.setProviders([provider], [], []);
  const current = {
    directory, source, nested, managed, store: initialStore, engine: initialEngine,
    worktrees: new ManagedWorktrees(initialStore, initialEngine, managed),
    async restart() {
      await current.engine.shutdown();
      current.store = new StateStore(statePath); await current.store.load();
      current.engine = new WorkbenchEngine(current.store, '', () => {}); current.engine.setProviders([provider], [], []);
      await current.engine.prepareExecutionKeys();
      current.worktrees = new ManagedWorktrees(current.store, current.engine, managed);
    },
    async close() { await current.engine.shutdown(); await rm(directory, { recursive: true, force: true }); },
  };
  return current;
}

test('managed creation keeps relative cwd, isolates files and replays one durable command across restart', async () => {
  const f = await fixture();
  try {
    const input = { name: 'feature', cwd: f.nested, mode: 'worktree' as const, commandId: 'create-feature' };
    const first = f.worktrees.create(input), duplicate = f.worktrees.create(input);
    assert.equal(first, duplicate);
    await assert.rejects(f.worktrees.create({ ...input, name: 'different while in flight' }), /commandId/);
    const id = await first, metadata = f.worktrees.metadata(id)!;
    assert.equal(f.engine.workspace(id).cwd, join(metadata.path, 'packages', 'app'));
    assert.notEqual(metadata.path, f.source); assert.equal(metadata.repoRoot, f.source);
    assert.equal(git(metadata.path, 'branch', '--show-current'), metadata.branch);
    assert.equal(git(metadata.path, 'rev-parse', 'HEAD'), metadata.baseSha);
    await writeFile(join(metadata.path, 'packages', 'app', 'entry.txt'), 'independent edit\n');
    assert.equal(await readFile(join(f.nested, 'entry.txt'), 'utf8'), 'base contents\n');
    assert.equal(git(f.source, 'status', '--porcelain'), '');
    assert.equal(await f.worktrees.create(input), id);
    await assert.rejects(f.worktrees.create({ ...input, branch: 'another-branch' }), /commandId/);
    await f.restart();
    assert.equal(await f.worktrees.create(input), id);
    assert.equal(f.store.state.worktreeOperations?.length, 1);
    const second = await f.worktrees.create({ ...input, commandId: 'create-second' });
    assert.notEqual(second, id); assert.notEqual(f.worktrees.metadata(second)?.path, metadata.path);
    assert.equal(await readFile(join(f.engine.workspace(second).cwd, 'entry.txt'), 'utf8'), 'base contents\n');
  } finally { await f.close(); }
});

test('managed removal preserves dirty, untracked, unmerged and running or queued work', async () => {
  let calls = 0;
  const f = await fixture(async context => {
    calls++;
    await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  try {
    const id = await f.worktrees.create({ name: 'protected', cwd: f.nested, mode: 'worktree', commandId: 'protected' });
    const metadata = f.worktrees.metadata(id)!, cwd = f.engine.workspace(id).cwd;
    const tracked = join(cwd, 'entry.txt'), untracked = join(cwd, 'new.txt');
    await writeFile(tracked, 'dirty\n'); await assert.rejects(f.worktrees.remove(id), /未提交/);
    assert.equal(await readFile(tracked, 'utf8'), 'dirty\n');
    git(metadata.path, 'restore', '--', '.');
    await writeFile(untracked, 'untracked\n'); await assert.rejects(f.worktrees.remove(id), /未提交/);
    assert.equal(await readFile(untracked, 'utf8'), 'untracked\n'); await rm(untracked);
    await writeFile(tracked, 'committed work\n'); git(metadata.path, 'add', '.'); git(metadata.path, 'commit', '-qm', 'unmerged work');
    const unmergedHead = git(metadata.path, 'rev-parse', 'HEAD');
    await assert.rejects(f.worktrees.remove(id), /尚未合入/);
    assert.equal(git(metadata.path, 'rev-parse', 'HEAD'), unmergedHead);
    git(metadata.path, 'reset', '--hard', metadata.baseSha);
    const sessionId = await f.engine.createSession({ title: 'active', providerId: 'fixture', cwd });
    f.engine.sendPrompt(sessionId, { text: 'hold' }, 'hold'); await until(() => calls === 1);
    await assert.rejects(f.worktrees.remove(id), /运行中或排队/);
    f.engine.cancelSession(sessionId); await f.engine.waitSession(sessionId);
    f.engine.setSessionQueuePaused(sessionId, true); f.engine.sendPrompt(sessionId, { text: 'queued' }, 'queued');
    await assert.rejects(f.worktrees.remove(id), /运行中或排队/);
    assert.equal(f.engine.getSession(sessionId).queue?.length, 1);
    assert.equal(f.worktrees.metadata(id)?.path, metadata.path); assert.equal((await stat(metadata.path)).isDirectory(), true);
    assert.equal(await readFile(join(f.nested, 'entry.txt'), 'utf8'), 'base contents\n');
  } finally { await f.close(); }
});

test('an uncommitted source directory is rejected before creating an orphan checkout or branch', async () => {
  const f = await fixture();
  try {
    const localDirectory = join(f.nested, 'local-only');
    await mkdir(localDirectory);
    await writeFile(join(localDirectory, 'note.txt'), 'local contents\n');
    await assert.rejects(f.worktrees.create({ name: 'local only', cwd: localDirectory, mode: 'worktree',
      branch: 'ensemble/local-only', commandId: 'untracked-source-directory' }), /没有保存在当前提交/);
    assert.equal(f.store.state.worktreeOperations?.length ?? 0, 0);
    assert.equal(f.engine.commandReceipt('untracked-source-directory'), undefined);
    assert.equal(git(f.source, 'branch', '--list', 'ensemble/local-only'), '');
    assert.equal(git(f.source, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1);
    await assert.rejects(stat(f.managed), { code: 'ENOENT' });
    assert.equal(await readFile(join(localDirectory, 'note.txt'), 'utf8'), 'local contents\n');
  } finally { await f.close(); }
});

test('clean managed removal deletes only the owned checkout and keeps source Git history', async () => {
  const f = await fixture();
  try {
    const id = await f.worktrees.create({ name: 'complete', cwd: f.nested, mode: 'worktree', commandId: 'complete' });
    const metadata = f.worktrees.metadata(id)!, sourceHead = git(f.source, 'rev-parse', 'HEAD');
    const cwd = f.engine.workspace(id).cwd;
    const sessionId = await f.engine.createSession({ title: 'history', providerId: 'fixture', cwd });
    const rootAliasId = await f.engine.createWorkspace({ name: 'root alias', cwd: metadata.path });
    const rootAlias = { ...f.engine.workspace(rootAliasId) };
    const workflowId = await f.engine.createWorkflow({ name: 'history', cwd,
      steps: [{ id: 'step', title: 'archived plan', providerId: 'fixture', prompt: 'keep history', dependsOn: [] }] });
    await f.worktrees.remove(id);
    await assert.rejects(stat(metadata.path), { code: 'ENOENT' });
    assert.equal((await stat(f.source)).isDirectory(), true); assert.equal(git(f.source, 'rev-parse', 'HEAD'), sourceHead);
    assert.equal(git(f.source, 'status', '--porcelain'), '');
    assert.equal(await readFile(join(f.nested, 'entry.txt'), 'utf8'), 'base contents\n');
    assert(!git(f.source, 'worktree', 'list', '--porcelain').includes(metadata.path));
    assert.equal(git(f.source, 'branch', '--list', metadata.branch), '');
    assert(!f.store.state.workspaces.some(workspace => workspace.id === id));
    assert.equal(f.store.state.worktreeOperations?.[0].status, 'removed');
    assert.equal(f.engine.getSession(sessionId).archived, true);
    assert(!f.store.state.workspaces.some(workspace => workspace.id === rootAliasId));
    f.store.atomic(state => { state.workspaces.push({ ...rootAlias, id: 'legacy-retired-alias' }); });
    await f.restart();
    assert(!f.store.state.workspaces.some(workspace => [cwd, metadata.path].includes(workspace.cwd)));
    assert.equal(f.engine.getSession(sessionId).archived, true);
    assert(f.store.state.workflows.some(workflow => workflow.id === workflowId));
    await f.worktrees.remove(id);
  } finally { await f.close(); }
});

test('durable removal resumes after checkout deletion and branch deletion without recreating data', async t => {
  for (const cut of ['after-checkout', 'after-branch'] as const) await t.test(cut, async () => {
    const f = await fixture();
    try {
      const id = await f.worktrees.create({ name: cut, cwd: f.nested, mode: 'worktree', commandId: cut });
      const metadata = f.worktrees.metadata(id)!;
      const internal = f.worktrees as unknown as { removeBranch(operation: WorktreeOperation): Promise<void> };
      const removeBranch = internal.removeBranch.bind(f.worktrees);
      internal.removeBranch = async operation => {
        if (cut === 'after-branch') await removeBranch(operation);
        throw new Error(`simulated backend exit ${cut}`);
      };
      await assert.rejects(f.worktrees.remove(id), /simulated backend exit/);
      assert.equal(f.store.state.worktreeOperations![0].status, 'removing');
      assert.equal(f.store.state.worktreeOperations![0].cleanupHeadSha, metadata.baseSha);
      assert.equal(f.worktrees.metadata(id)?.status, 'removing');
      await assert.rejects(stat(metadata.path), { code: 'ENOENT' });
      assert.equal(Boolean(git(f.source, 'branch', '--list', metadata.branch)), cut === 'after-checkout');
      await f.restart();
      assert.equal(f.worktrees.metadata(id)?.status, 'removing');
      await f.worktrees.remove(id);
      assert.equal(f.store.state.worktreeOperations![0].status, 'removed');
      assert.equal(git(f.source, 'branch', '--list', metadata.branch), '');
      assert(!f.store.state.workspaces.some(workspace => workspace.id === id));
      assert.equal(await readFile(join(f.nested, 'entry.txt'), 'utf8'), 'base contents\n');
    } finally { await f.close(); }
  });
});

test('root and subdirectory aliases share admitted access and block removal until every write ends', async () => {
  const f = await fixture();
  let releaseRoot!: () => void, releaseSub!: () => void;
  const rootGate = new Promise<void>(resolve => { releaseRoot = resolve; });
  const subGate = new Promise<void>(resolve => { releaseSub = resolve; });
  let rootWrite: Promise<void> | undefined, subWrite: Promise<void> | undefined;
  try {
    const id = await f.worktrees.create({ name: 'access', cwd: f.nested, mode: 'worktree', commandId: 'access' });
    const metadata = f.worktrees.metadata(id)!;
    const rootAlias = await f.engine.createWorkspace({ name: 'root alias', cwd: metadata.path });
    const subAlias = await f.engine.createWorkspace({ name: 'subdirectory alias', cwd: join(metadata.path, 'packages') });
    assert.deepEqual(new Set(f.worktrees.workspaceIds(id)), new Set([id, rootAlias, subAlias]));
    rootWrite = f.worktrees.access(rootAlias, async () => { await rootGate; await writeFile(join(metadata.path, 'README.md'), 'admitted root edit\n'); });
    subWrite = f.worktrees.access(subAlias, async () => { await subGate; await writeFile(join(metadata.path, 'packages', 'app', 'entry.txt'), 'admitted subdirectory edit\n'); });
    await assert.rejects(f.worktrees.remove(id), /操作未结束/);
    assert.equal(f.store.state.worktreeOperations![0].status, 'ready');
    releaseRoot(); await rootWrite;
    await assert.rejects(f.worktrees.remove(id), /操作未结束/);
    releaseSub(); await subWrite;
    assert.equal(await readFile(join(metadata.path, 'README.md'), 'utf8'), 'admitted root edit\n');
    assert.equal(await readFile(join(metadata.path, 'packages', 'app', 'entry.txt'), 'utf8'), 'admitted subdirectory edit\n');
    await assert.rejects(f.worktrees.remove(id), /未提交/);
    git(metadata.path, 'restore', '--', '.');
    await f.worktrees.remove(id);
    assert(!f.store.state.workspaces.some(workspace => [id, rootAlias, subAlias].includes(workspace.id)));
  } finally { releaseRoot(); releaseSub(); await Promise.allSettled([rootWrite, subWrite]); await f.close(); }
});

test('persisted removal blocks access and ordinary or managed execution after a real restart', async () => {
  const f = await fixture();
  try {
    const id = await f.worktrees.create({ name: 'persisted', cwd: f.nested, mode: 'worktree', commandId: 'persisted' });
    const metadata = f.worktrees.metadata(id)!, cwd = f.engine.workspace(id).cwd;
    const alias = await f.engine.createWorkspace({ name: 'root alias', cwd: metadata.path });
    const sessionId = await f.engine.createSession({ title: 'history', providerId: 'fixture', cwd });
    f.store.atomic(() => {
      const operation = f.store.state.worktreeOperations![0];
      operation.status = 'removing'; operation.cleanupHeadSha = git(metadata.path, 'rev-parse', 'HEAD');
    });
    await f.restart();
    assert.equal((await stat(metadata.path)).isDirectory(), true);
    let accessed = false;
    await assert.rejects(f.worktrees.access(id, () => { accessed = true; }), /回收/);
    await assert.rejects(f.worktrees.access(alias, () => { accessed = true; }), /回收/);
    assert.equal(accessed, false);
    await assert.rejects(f.engine.createSession({ title: 'blocked', providerId: 'fixture', cwd }), /回收/);
    assert.throws(() => f.engine.sendPrompt(sessionId, { text: 'ordinary' }, 'blocked-removing'), /回收/);
    assert.throws(() => f.engine.executeSession(sessionId, { text: 'managed' }, { owner: 'managed-attempt' }), /回收/);
    assert.equal(f.engine.getSession(sessionId).attempts?.length ?? 0, 0);
    assert.equal(f.engine.commandReceipt('blocked-removing'), undefined);
    await f.worktrees.remove(id);
    assert.equal(f.store.state.worktreeOperations![0].status, 'removed');
  } finally { await f.close(); }
});

test('creating journal operations recover before and after the native checkout was created', async t => {
  for (const cut of ['before-git', 'after-git'] as const) await t.test(cut, async () => {
    const f = await fixture();
    try {
      const input = { name: 'recover', cwd: f.nested, mode: 'worktree' as const, commandId: `recover-${cut}` };
      f.engine.withProjectMutation = async () => {
        const intent = f.store.state.worktreeOperations![0];
        if (cut === 'after-git') git(intent.repoRoot, 'worktree', 'add', '-b', intent.branch, intent.path, intent.baseSha);
        throw new Error(`simulated backend exit ${cut}`);
      };
      await assert.rejects(f.worktrees.create(input), /simulated backend exit/);
      assert.equal(f.store.state.worktreeOperations?.[0].status, 'creating');
      const recorded = { ...f.store.state.worktreeOperations![0] };
      await f.restart();
      const workspaceId = await f.worktrees.create(input);
      assert.equal(f.store.state.worktreeOperations?.length, 1);
      assert.equal(f.store.state.worktreeOperations?.[0].status, 'ready');
      assert.equal(f.worktrees.metadata(workspaceId)?.path, recorded.path);
      assert.equal(f.engine.workspace(workspaceId).cwd, join(recorded.path, recorded.relativeCwd));
      assert.equal(git(recorded.path, 'rev-parse', 'HEAD'), recorded.baseSha);
      assert.equal(git(f.source, 'worktree', 'list', '--porcelain').split('\n').filter(line => line === `worktree ${recorded.path}`).length, 1);
    } finally { await f.close(); }
  });
});

test('removal and queued-message admission cannot delete accepted work', async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let removing: Promise<void> | undefined;
  try {
    const id = await f.worktrees.create({ name: 'race', cwd: f.nested, mode: 'worktree', commandId: 'race' });
    const metadata = f.worktrees.metadata(id)!;
    const sessionId = await f.engine.createSession({ title: 'paused', providerId: 'fixture', cwd: f.engine.workspace(id).cwd });
    f.engine.setSessionQueuePaused(sessionId, true);
    const mutate = f.engine.withProjectMutation.bind(f.engine);
    let locked = false;
    f.engine.withProjectMutation = (cwd, operation) => mutate(cwd, async () => { locked = true; await gate; return operation(); });
    removing = f.worktrees.remove(id); await until(() => locked);
    let accepted = false;
    try { f.engine.sendPrompt(sessionId, { text: 'must survive removal' }, 'during-removal'); accepted = true; }
    catch (error) { assert.match((error as Error).message, /已有会话或编排运行|回收/); }
    release();
    if (accepted) {
      assert.equal(f.engine.getSession(sessionId).queue?.length, 1);
      await assert.rejects(removing, /运行中或排队/);
      assert.equal((await stat(metadata.path)).isDirectory(), true);
      assert.equal(f.worktrees.metadata(id)?.path, metadata.path);
    } else {
      assert.equal(f.engine.getSession(sessionId).queue?.length ?? 0, 0);
      assert.equal(f.engine.commandReceipt('during-removal'), undefined);
      await removing;
      await assert.rejects(stat(metadata.path), { code: 'ENOENT' });
    }
  } finally { release(); await removing?.catch(() => {}); await f.close(); }
});

test('a worktree created from another managed checkout keeps a stable repository after its source is removed', async () => {
  const f = await fixture();
  try {
    const first = await f.worktrees.create({ name: 'first checkout', cwd: f.nested, mode: 'worktree', commandId: 'source-checkout' });
    const sourceCheckout = f.worktrees.metadata(first)!;
    const sourceCwd = f.engine.workspace(first).cwd;
    await writeFile(join(sourceCwd, 'entry.txt'), 'committed source checkout contents\n');
    git(sourceCheckout.path, 'add', '.'); git(sourceCheckout.path, 'commit', '-qm', 'source checkout commit');
    const sourceHead = git(sourceCheckout.path, 'rev-parse', 'HEAD');
    assert.notEqual(sourceHead, git(f.source, 'rev-parse', 'HEAD'));
    const second = await f.worktrees.create({ name: 'derived checkout', cwd: sourceCwd, mode: 'worktree', commandId: 'derived-checkout' });
    const derived = f.worktrees.metadata(second)!;
    assert.equal(derived.repoRoot, f.source);
    assert.notEqual(derived.repoRoot, sourceCheckout.path);
    assert.equal(derived.baseSha, sourceHead);
    assert.equal(f.engine.workspace(second).cwd, join(derived.path, 'packages', 'app'));
    assert.equal(await readFile(join(f.engine.workspace(second).cwd, 'entry.txt'), 'utf8'), 'committed source checkout contents\n');
    git(f.source, 'merge', '--ff-only', sourceCheckout.branch);
    await f.worktrees.remove(first);
    await assert.rejects(stat(sourceCheckout.path), { code: 'ENOENT' });
    await f.restart();
    assert.equal(f.worktrees.metadata(second)?.repoRoot, f.source);
    await f.worktrees.remove(second);
    await assert.rejects(stat(derived.path), { code: 'ENOENT' });
    assert.equal(git(f.source, 'branch', '--list', sourceCheckout.branch), '');
    assert.equal(git(f.source, 'branch', '--list', derived.branch), '');
    assert.equal(git(f.source, 'rev-parse', 'HEAD'), sourceHead);
    assert.equal(await readFile(join(f.nested, 'entry.txt'), 'utf8'), 'committed source checkout contents\n');
  } finally { await f.close(); }
});
