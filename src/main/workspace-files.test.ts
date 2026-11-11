import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceFiles } from './workspace-files';

const temporary: string[] = [];
after(async () => { await Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true }))); });
const files = new WorkspaceFiles();

async function directory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-workspace-'));
  temporary.push(root);
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
}

async function repository(): Promise<string> {
  const root = await directory();
  git(root, 'init', '-q', '-b', 'main');
  return root;
}

test('workspace file access stays inside realpath boundaries, including dangling and directory symlinks', async () => {
  const root = await directory(); const outside = await directory();
  await writeFile(path.join(root, 'hello.ts'), 'const message = "中文";\n');
  await mkdir(path.join(root, 'folder'));
  await writeFile(path.join(outside, 'secret.txt'), 'outside');
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'outside.txt'));
  await symlink(outside, path.join(root, 'outside-directory'));
  await symlink(path.join(outside, 'missing'), path.join(root, 'dangling'));
  await symlink(path.join(root, 'hello.ts'), path.join(root, 'inside.ts'));
  assert.deepEqual((await files.list(root)).map((entry) => entry.name), ['folder', 'hello.ts', 'inside.ts']);
  assert.equal((await files.read(root, 'inside.ts')).content, 'const message = "中文";\n');
  assert.equal((await files.read(root, 'hello.ts')).language, 'typescript');
  await assert.rejects(files.read(root, '../secret.txt'), /outside/);
  await assert.rejects(files.read(root, path.join(root, 'hello.ts')), /relative/);
  await assert.rejects(files.read(root, 'outside.txt'), /outside/);
  await assert.rejects(files.list(root, 'outside-directory'), /outside/);
  await assert.rejects(files.diff(root, 'dangling'), /symbolic link/);
  await assert.rejects(files.diff(root, 'outside-directory/missing.txt'), /outside/);
});

test('local branch change creates and switches while rejecting stale and dirty checkouts', async () => {
  const root = await repository();
  const folder = path.join(root, 'project');
  await mkdir(folder);
  await writeFile(path.join(folder, 'test.txt'), 'seed');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Initial');
  assert.equal((await files.changeGitBranch(folder, { action: 'create', name: 'feature/test', expectedBranch: 'main' })).branch, 'feature/test');
  await assert.rejects(files.changeGitBranch(folder, { action: 'switch', name: 'main', expectedBranch: 'old' }), /changed/);
  await assert.rejects(files.changeGitBranch(folder, { action: 'switch', name: '-force', expectedBranch: 'feature/test' }), /valid/);
  await writeFile(path.join(root, 'outside.txt'), 'outside changes');
  await assert.rejects(files.changeGitBranch(folder, { action: 'switch', name: 'main', expectedBranch: 'feature/test' }), /Commit or stash/);
  await unlink(path.join(root, 'outside.txt'));
  assert.equal((await files.changeGitBranch(folder, { action: 'switch', name: 'main', expectedBranch: 'feature/test' })).branch, 'main');
});

test('commit history filters branches and messages and reads committed diffs inside the workspace', async () => {
  const root = await repository();
  const project = path.join(root, 'project');
  await mkdir(project);
  assert.deepEqual(await files.gitHistory(project, '', true, 50), { commits: [], limited: false });
  const name = 'file [literal]*.txt';
  await writeFile(path.join(project, name), 'initial\n');
  await writeFile(path.join(root, 'outside.txt'), 'outside secret\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Initial');
  const initial = git(root, 'rev-parse', 'HEAD').trim();
  git(root, 'switch', '-qc', 'topic');
  await writeFile(path.join(project, name), 'committed content\n');
  git(root, 'commit', '-qam', 'Change [topic]*');
  const topic = git(root, 'rev-parse', 'HEAD').trim();
  git(root, 'switch', '-q', 'main');
  await writeFile(path.join(project, name), 'uncommitted content\n');
  assert.deepEqual((await files.gitHistory(project, '[TOPIC]*', false, 50)).commits, []);
  assert.deepEqual((await files.gitHistory(project, '[TOPIC]*', true, 50)).commits.map(commit => commit.sha), [topic]);
  assert.equal((await files.gitHistory(project, '', true, 1)).limited, true);
  assert.deepEqual(await files.gitCommitFiles(project, initial), [name]);
  assert.deepEqual(await files.gitCommitFiles(project, topic), [name]);
  assert.match((await files.gitCommitDiff(project, initial, name)).patch, /\+initial/);
  const patch = (await files.gitCommitDiff(project, topic, name)).patch;
  assert.match(patch, /\+committed content/);
  assert.doesNotMatch(patch, /uncommitted content|outside secret/);
  await assert.rejects(files.gitCommitDiff(project, topic, '../outside.txt'), /inside the workspace/);
});

test('file reader rejects binary, non-UTF-8 and larger files without returning their contents', async () => {
  const root = await directory();
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([65, 0, 66]));
  await writeFile(path.join(root, 'invalid.txt'), Buffer.from([0xff, 0xfe]));
  await writeFile(path.join(root, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 65));
  await assert.rejects(files.read(root, 'binary.bin'), /Binary/);
  await assert.rejects(files.read(root, 'invalid.txt'), /UTF-8/);
  await assert.rejects(files.read(root, 'large.txt'), /1 MiB/);
});

test('workspace search returns literal matches from the current files in scope', async () => {
  const root = await repository();
  const project = path.join(root, 'nested project');
  await mkdir(path.join(project, 'node_modules'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  await writeFile(path.join(root, 'outside.txt'), 'find.[ME]');
  await writeFile(path.join(project, 'tracked.txt'), 'indexed find.[ME]');
  await writeFile(path.join(project, 'removed.txt'), 'find.[ME]');
  await writeFile(path.join(project, 'node_modules', 'dependency.txt'), 'find.[ME]');
  await symlink(path.join(root, 'outside.txt'), path.join(project, 'outside-link.txt'));
  await symlink(path.join(project, 'ignored.txt'), path.join(project, 'ignored-link.txt'));
  git(root, 'add', '.');
  await unlink(path.join(project, 'removed.txt'));
  await writeFile(path.join(project, 'tracked.txt'), 'findXMe\r\n🙂 FIND.[me] find.[me]\r\nfind.[Me]');
  await writeFile(path.join(project, 'untracked.txt'), '中文find.[ME]');
  await writeFile(path.join(project, 'ignored.txt'), 'find.[ME]');
  await writeFile(path.join(project, 'binary.txt'), 'find.[ME]\0');
  await writeFile(path.join(project, 'invalid.txt'), Buffer.concat([Buffer.from('find.[ME]'), Buffer.from([0xff])]));

  assert.deepEqual(await files.searchText(project, 'find.[me]'), { limited: false, matches: [
    { path: 'tracked.txt', line: 2, column: 4, preview: '🙂 FIND.[me] find.[me]' },
    { path: 'tracked.txt', line: 3, column: 1, preview: 'find.[Me]' },
    { path: 'untracked.txt', line: 1, column: 3, preview: '中文find.[ME]' },
  ] });
  assert.deepEqual(await files.find(project, 'track'), [
    { path: 'tracked.txt', name: 'tracked.txt' }, { path: 'untracked.txt', name: 'untracked.txt' },
  ]);
});

test('plain workspace search reports incomplete scans and root failures', async () => {
  const root = await directory();
  await writeFile(path.join(root, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 65));
  await writeFile(path.join(root, 'text.txt'), `${'a'.repeat(300)}needle${'b'.repeat(300)}\n`);
  const result = await files.searchText(root, 'needle');
  assert.equal(result.limited, true);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].column, 301);
  assert(result.matches[0].preview.length <= 240);
  assert.match(result.matches[0].preview, /^…a+needleb+…$/);
  await unlink(path.join(root, 'large.txt'));
  await writeFile(path.join(root, 'text.txt'), 'needle\n'.repeat(201));
  const capped = await files.searchText(root, 'needle');
  assert.equal(capped.limited, true);
  assert.equal(capped.matches.length, 200);
  assert.equal(capped.matches.at(-1)?.line, 200);
  await assert.rejects(files.searchText(path.join(root, 'missing'), 'needle'), { code: 'ENOENT' });
  const previousPath = process.env.PATH;
  process.env.PATH = root;
  try {
    const withoutGit = await files.searchText(root, 'needle');
    assert.deepEqual(withoutGit, capped);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test('unborn branches expose real untracked and staged-plus-unstaged file contents', async () => {
  const root = await repository();
  const name = '中文 \n "quoted".txt';
  await writeFile(path.join(root, name), 'first line\n');
  const untracked = await files.gitState(root);
  assert.equal(untracked.available, true, untracked.error);
  assert.equal(untracked.branch, 'main');
  assert.deepEqual(untracked.changes.map((change) => [change.path, change.status]), [[name, '??']]);
  assert.match((await files.diff(root, name)).patch, /\+first line/);
  git(root, 'add', '--', name);
  await writeFile(path.join(root, name), 'first line\nworking line\n');
  const staged = await files.gitState(root);
  assert.equal(staged.available, true, staged.error);
  assert.equal(staged.changes[0].staged, true);
  assert.equal(staged.changes[0].additions, 2);
  const indexBefore = await readFile(path.join(root, '.git', 'index'));
  const patch = await files.diff(root, name);
  assert.match(patch.patch, /Staged changes[\s\S]*\+first line[\s\S]*Working tree changes[\s\S]*\+working line/);
  assert.deepEqual(await readFile(path.join(root, '.git', 'index')), indexBefore);
  assert.equal(patch.truncated, false);
  await writeFile(path.join(root, 'image.bin'), Buffer.from([0, 1, 2]));
  assert.equal((await files.diff(root, 'image.bin')).binary, true);
});

test('tracked rename and deletion diffs preserve actual Git changes', async () => {
  const root = await repository();
  await writeFile(path.join(root, 'old name.txt'), 'rename contents\n');
  await writeFile(path.join(root, 'deleted.txt'), 'deleted contents\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture');
  git(root, 'mv', 'old name.txt', 'new name.txt');
  await unlink(path.join(root, 'deleted.txt'));
  const state = await files.gitState(root);
  assert.equal(state.available, true, state.error);
  assert(state.changes.some((change) => change.path === 'new name.txt' && change.status.includes('R')));
  const renamed = await files.diff(root, 'new name.txt');
  assert.match(renamed.patch, /rename from old name\.txt/);
  assert.match(renamed.patch, /rename to new name\.txt/);
  assert.match((await files.diff(root, 'deleted.txt')).patch, /-deleted contents/);
});

test('Git reads are scoped to a workspace nested inside the repository', async () => {
  const root = await repository();
  const nested = path.join(root, 'nested'); await mkdir(nested);
  await writeFile(path.join(root, 'outside.txt'), 'before\n');
  await writeFile(path.join(nested, 'inside.txt'), 'before\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture');
  await writeFile(path.join(root, 'outside.txt'), 'outside changed\n');
  await writeFile(path.join(nested, 'inside.txt'), 'inside changed\n');
  const state = await files.gitState(nested);
  assert.equal(state.available, true, state.error);
  assert.deepEqual(state.changes.map((change) => change.path), ['inside.txt']);
  const patch = (await files.diff(nested, 'inside.txt')).patch;
  assert.match(patch, /\+inside changed/); assert.doesNotMatch(patch, /outside changed/);
  assert.equal((await files.gitState(await directory())).available, false);
});

test('branch comparison pins the merge base and HEAD and scopes a commit-only patch to the project', async () => {
  const root = await repository();
  const project = path.join(root, 'nested [project]');
  const inside = path.join(project, 'inside.txt');
  const attributes = path.join(project, '.gitattributes');
  const outside = path.join(root, 'outside.txt');
  await mkdir(project);
  await writeFile(inside, 'base text\n');
  await writeFile(attributes, '*.txt diff=fixture\n');
  await writeFile(outside, 'outside base\n');
  await writeFile(path.join(project, 'moved.txt'), 'moved beyond scope\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'shared ancestor');
  const mergeBase = git(root, 'rev-parse', 'HEAD').trim();
  git(root, 'checkout', '-qb', 'topic');
  await writeFile(inside, 'target-only text\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'target branch');
  const targetSha = git(root, 'rev-parse', 'HEAD').trim();
  git(root, 'update-ref', 'refs/remotes/origin/topic', targetSha);
  git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/topic');
  git(root, 'tag', 'release', targetSha);
  git(root, 'checkout', '-q', 'main');
  await writeFile(inside, 'committed HEAD text\n');
  await writeFile(outside, 'outside committed change\n');
  git(root, 'mv', 'nested [project]/moved.txt', 'moved-outside.txt');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'current branch');
  const headSha = git(root, 'rev-parse', 'HEAD').trim();
  git(root, 'config', 'diff.external', 'false');
  git(root, 'config', 'diff.fixture.textconv', 'false');
  await writeFile(inside, 'staged-only text\n');
  await writeFile(attributes, '*.txt -diff\n');
  git(root, 'add', '.');
  await writeFile(inside, 'working-only text\n');
  await writeFile(path.join(project, 'untracked.txt'), 'untracked text\n');
  const index = await readFile(path.join(root, '.git', 'index'));
  const status = git(root, '--no-optional-locks', 'status', '--porcelain');

  assert.deepEqual(await files.gitBranchRefs(project), ['refs/heads/main', 'refs/heads/topic', 'refs/remotes/origin/topic']);
  const comparison = await files.gitBranchComparison(project, 'refs/remotes/origin/topic');
  const { patch, ...revisions } = comparison;
  assert.deepEqual(revisions, { targetRef: 'refs/remotes/origin/topic', targetSha, mergeBase, headSha, truncated: false });
  assert.match(patch, /^diff --git a\/inside\.txt b\/inside\.txt/m);
  assert.match(patch, /-base text\n\+committed HEAD text/);
  assert.match(patch, /-moved beyond scope/);
  assert.doesNotMatch(patch, /outside committed change|moved-outside\.txt|target-only|staged-only|working-only|untracked/);
  assert.equal((await files.gitBranchComparison(project, 'refs/heads/main')).patch, '');
  assert.equal((await files.gitBranchComparison(project, 'refs/heads/topic')).patch, patch);
  for (const reference of ['HEAD', '--no-ext-diff', 'refs/tags/release', 'refs/heads/topic~1']) {
    await assert.rejects(files.gitBranchComparison(project, reference), /full local or remote-tracking/);
  }
  for (const reference of ['refs/heads/missing', 'refs/remotes/origin/HEAD']) {
    await assert.rejects(files.gitBranchComparison(project, reference), /unavailable/);
  }
  const unrelated = git(root, 'commit-tree', git(root, 'rev-parse', 'HEAD^{tree}').trim(), '-m', 'unrelated').trim();
  git(root, 'update-ref', 'refs/heads/unrelated', unrelated);
  await assert.rejects(files.gitBranchComparison(project, 'refs/heads/unrelated'), /No common ancestor/);
  assert.deepEqual(await readFile(path.join(root, '.git', 'index')), index);
  assert.equal(git(root, '--no-optional-locks', 'status', '--porcelain'), status);
});

test('branch comparison reports a patch beyond the Git output limit as truncated', async () => {
  const root = await repository();
  git(root, 'commit', '--allow-empty', '-qm', 'base');
  git(root, 'branch', 'base');
  await writeFile(path.join(root, 'large.txt'), 'large patch line\n'.repeat(160_000));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'large commit');
  const comparison = await files.gitBranchComparison(root, 'refs/heads/base');
  assert.equal(comparison.truncated, true);
  assert.match(comparison.patch, /^diff --git a\/large\.txt b\/large\.txt/);
  assert(Buffer.byteLength(comparison.patch) <= 2 * 1024 * 1024);
});

async function until(condition: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for PTY output');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('real native PTY forwards input, resizes, bounds UTF-8 output and reports actual exit', async () => {
  const { TerminalManager } = await import('./terminal-manager');
  const root = await directory(); const shell = path.join(root, 'fixture-shell');
  await writeFile(shell, `#!${process.execPath}\n
process.stdout.write('TTY:' + process.stdin.isTTY + ':' + process.stdout.isTTY + '\\n');
process.on('SIGWINCH', () => process.stdout.write('SIZE:' + process.stdout.columns + ':' + process.stdout.rows + '\\n'));
process.stdin.setEncoding('utf8');
process.stdin.on('data', value => {
  if (value.includes('large')) process.stdout.write('中文'.repeat(80000) + 'END\\n');
  else if (value.includes('finish')) process.stdout.write('DONE\\n', () => process.exit(7));
  else process.stdout.write('INPUT:' + value);
});\n`);
  await chmod(shell, 0o755);
  const previousShell = process.env.SHELL; process.env.SHELL = shell;
  let changes = 0; const manager = new TerminalManager(() => { changes++; });
  try {
    const terminal = manager.create('workspace-fixture', root);
    assert.equal(terminal.outputOffset, 0);
    const current = () => manager.snapshot().find((item) => item.id === terminal.id)!;
    await until(() => current().output.includes('TTY:true:true'));
    manager.resize(terminal.id, 101, 37);
    await until(() => current().output.includes('SIZE:101:37'));
    manager.write(terminal.id, 'ping\n');
    await until(() => current().output.includes('INPUT:ping'));
    manager.write(terminal.id, 'large\n');
    await until(() => current().output.includes('END'));
    const retained = current();
    assert(Buffer.byteLength(retained.output) <= 256 * 1024);
    assert(!retained.output.includes('\ufffd'));
    assert(retained.outputOffset > 0 && retained.outputOffset < 160000);
    const endOffset = retained.outputOffset + retained.output.length;
    manager.write(terminal.id, 'finish\n');
    await until(() => current().status === 'exited');
    assert(current().outputOffset >= retained.outputOffset);
    assert(current().outputOffset + current().output.length > endOffset);
    assert.equal(current().exitCode, 7);
    assert.throws(() => manager.write(terminal.id, 'late'), /not running/);
    assert(changes > 0 && changes < 30);
  } finally {
    await manager.shutdown();
    if (previousShell === undefined) delete process.env.SHELL; else process.env.SHELL = previousShell;
  }
});

test('stopping a real PTY reaps a process that ignores SIGTERM', async () => {
  const { TerminalManager } = await import('./terminal-manager');
  const root = await directory(); const shell = path.join(root, 'stubborn-shell');
  await writeFile(shell, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{}); process.stdout.write('PID:'+process.pid+'\\n'); setInterval(()=>{},1000);\n`);
  await chmod(shell, 0o755);
  const previousShell = process.env.SHELL; process.env.SHELL = shell;
  const manager = new TerminalManager(() => {});
  try {
    const terminal = manager.create('workspace-fixture', root);
    const current = () => manager.snapshot().find((item) => item.id === terminal.id)!;
    await until(() => current().output.includes('PID:'));
    const pid = Number(/PID:(\d+)/.exec(current().output)?.[1]);
    assert(pid > 0);
    manager.stop(terminal.id);
    await until(() => current().status === 'exited');
    assert.equal(current().exitCode, 137);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    await manager.shutdown();
    if (previousShell === undefined) delete process.env.SHELL; else process.env.SHELL = previousShell;
  }
});
