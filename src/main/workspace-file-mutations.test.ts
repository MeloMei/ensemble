import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceFiles, workspaceExecutionKey } from './workspace-files';

const owned: string[] = [];
after(async () => { await Promise.all(owned.map(directory => rm(directory, { recursive: true, force: true }))); });
const files = new WorkspaceFiles();
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });

async function directory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-file-mutations-')); owned.push(root); return root;
}
async function repository(): Promise<string> {
  const root = await directory(); git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false'); git(root, 'config', 'core.hooksPath', '/dev/null');
  return root;
}

test('execution identity is shared by nested repository directories and canonical aliases', async () => {
  const root = await repository(); const nested = path.join(root, 'nested'); await mkdir(nested);
  const aliasDirectory = await directory(); const alias = path.join(aliasDirectory, 'alias'); await symlink(nested, alias);
  assert.equal(await workspaceExecutionKey(root), await workspaceExecutionKey(nested));
  assert.equal(await workspaceExecutionKey(root), await workspaceExecutionKey(alias));
  const plain = await directory(); assert.equal(await workspaceExecutionKey(plain), await import('node:fs/promises').then(fs => fs.realpath(plain)));
});

test('atomic saves preserve BOM, CRLF and mode, reject stale writes and serialize competing drafts', async () => {
  const root = await directory(); const target = path.join(root, 'script.sh');
  await writeFile(target, '\uFEFFecho before\r\n'); await chmod(target, 0o750);
  const original = await files.read(root, 'script.sh');
  assert.equal(original.content, '\uFEFFecho before\r\n');
  const changed = await files.write(root, { path: 'script.sh', content: 'echo after\r\n', revision: original.revision });
  assert.equal(changed.content, '\uFEFFecho after\r\n');
  assert.equal((await stat(target)).mode & 0o777, 0o750);
  await assert.rejects(files.write(root, { path: 'script.sh', content: 'stale', revision: original.revision }), /changed/);
  const concurrent = await Promise.allSettled(['one', 'two'].map(content => files.write(root, { path: 'script.sh', content, revision: changed.revision })));
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await readdir(root)).some(name => name.endsWith('.tmp')), false);
  const current = await files.read(root, 'script.sh');
  await assert.rejects(files.write(root, { path: 'script.sh', content: '\u0001', revision: current.revision }), /Binary/);
  await symlink(target, path.join(root, 'link.sh'));
  await assert.rejects(files.write(root, { path: 'link.sh', content: 'bad', revision: current.revision }), /Symbolic/);
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, '.git', 'config'), 'owned');
  await assert.rejects(files.write(root, { path: '.git/config', content: 'bad', revision: 'invalid' }), /workspace file/);
});

test('selected literal paths stage and unstage on an unborn branch without affecting sibling files', async () => {
  const root = await repository(); const name = 'literal [x]*\n中文.txt';
  await writeFile(path.join(root, name), 'selected\n'); await writeFile(path.join(root, 'sibling.txt'), 'untouched\n');
  await files.mutate(root, { action: 'stage', path: name });
  assert.deepEqual(git(root, 'diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean), [name]);
  await files.mutate(root, { action: 'unstage', path: name });
  assert.equal(git(root, 'diff', '--cached', '--name-only'), '');
  assert.equal(await readFile(path.join(root, name), 'utf8'), 'selected\n');
  await assert.rejects(files.mutate(root, { action: 'stage', path: '.' }), /workspace file/);
});

test('discard checks the actual worktree version, restores from index, and never deletes untracked files', async () => {
  const root = await repository(); const target = path.join(root, 'tracked.txt');
  await writeFile(target, 'head\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'seed');
  await writeFile(target, 'index\n'); await files.mutate(root, { action: 'stage', path: 'tracked.txt' });
  await writeFile(target, 'working\n'); const preview = await files.diff(root, 'tracked.txt');
  const indexBefore = git(root, 'ls-files', '--stage', '-z');
  await writeFile(target, 'late edit\n');
  await assert.rejects(files.mutate(root, { action: 'discard', path: 'tracked.txt', revision: preview.revision }), /changed/);
  const current = await files.diff(root, 'tracked.txt');
  await files.mutate(root, { action: 'discard', path: 'tracked.txt', revision: current.revision });
  assert.equal(await readFile(target, 'utf8'), 'index\n');
  assert.equal(git(root, 'ls-files', '--stage', '-z'), indexBefore);
  await unlink(target); const deleted = await files.diff(root, 'tracked.txt');
  await files.mutate(root, { action: 'discard', path: 'tracked.txt', revision: deleted.revision });
  assert.equal(await readFile(target, 'utf8'), 'index\n');
  await writeFile(path.join(root, 'new.txt'), 'keep me');
  await assert.rejects(files.mutate(root, { action: 'discard', path: 'new.txt', revision: (await files.diff(root, 'new.txt')).revision }), /untracked/);
  assert.equal(await readFile(path.join(root, 'new.txt'), 'utf8'), 'keep me');
});

test('commit preview includes the complete repository index, rejects changed index and keeps unstaged edits', async () => {
  const root = await repository(); const nested = path.join(root, 'nested'); await mkdir(nested);
  await writeFile(path.join(root, 'outside.txt'), 'outside staged\n'); await writeFile(path.join(nested, 'inside.txt'), 'inside staged\n');
  git(root, 'add', '.'); const preview = await files.commitPreview(nested);
  assert.deepEqual(preview.paths, ['nested/inside.txt', 'outside.txt']);
  assert.match(preview.patch, /outside staged/);
  await writeFile(path.join(root, 'later.txt'), 'late index\n'); git(root, 'add', 'later.txt');
  await assert.rejects(files.commit(nested, { message: 'stale', revision: preview.revision }), /changed/);
  const complete = await files.commitPreview(nested);
  await writeFile(path.join(nested, 'inside.txt'), 'working only\n');
  const sha = await files.commit(nested, { message: 'exact staged commit', revision: complete.revision });
  assert.equal(git(root, 'show', `${sha}:nested/inside.txt`), 'inside staged\n');
  assert.equal(await readFile(path.join(nested, 'inside.txt'), 'utf8'), 'working only\n');
  assert.match(git(root, 'status', '--porcelain'), / M nested\/inside.txt/);
  assert.equal(git(root, 'diff', '--cached'), '');
});

test('commit preserves actual Git hook rejection and leaves HEAD unchanged', async () => {
  const root = await repository(); await writeFile(path.join(root, 'file.txt'), 'before\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'seed'); const head = git(root, 'rev-parse', 'HEAD');
  const hooks = path.join(root, 'fixture-hooks'); await mkdir(hooks);
  const hook = path.join(hooks, 'pre-commit'); await writeFile(hook, '#!/bin/sh\necho FIXTURE_HOOK_REJECTED >&2\nexit 1\n'); await chmod(hook, 0o755);
  git(root, 'config', 'core.hooksPath', hooks);
  await writeFile(path.join(root, 'file.txt'), 'staged\n'); git(root, 'add', 'file.txt');
  const preview = await files.commitPreview(root);
  await assert.rejects(files.commit(root, { message: 'must reject', revision: preview.revision }), /FIXTURE_HOOK_REJECTED/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
});
