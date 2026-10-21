// Atomic save flow adapted from Paseo 05920a236cb6ba8eeae128ee7bb6677cc226cd3a, packages/server/src/server/file-explorer/service.ts:433-531.
// Copyright (c) 2025-present Mohamed Boudra. Apache-2.0; see licenses/Paseo-Apache-2.0.txt.
// Modified: own path boundaries, content-and-file revision, shared mutation queue, and explicit save errors.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import type { FileContent, FileDiff, FileEntry, GitCommitPreview, GitMutation, GitState } from '../shared/types';
import { parsePorcelainV1Records, type PorcelainV1Record } from './vendor/orca/porcelain-v1-records';

const FILE_LIMIT = 1024 * 1024;
const ENTRY_LIMIT = 2000;
const GIT_TIMEOUT_MS = 5000;
const GIT_OUTPUT_LIMIT = 2 * 1024 * 1024;

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function normalizedRelative(value: string): string {
  if (typeof value !== 'string' || value.includes('\0') || path.isAbsolute(value)) {
    throw new Error('A workspace-relative path is required');
  }
  return value.split(path.sep).join('/');
}

async function workspaceRoot(cwd: string): Promise<string> {
  if (!path.isAbsolute(cwd)) throw new Error('Workspace directory must be absolute');
  const root = await realpath(cwd);
  if (!(await stat(root)).isDirectory()) throw new Error('Workspace directory is not a directory');
  return root;
}

async function scopedPath(root: string, relativePath: string, allowMissing = false): Promise<string> {
  normalizedRelative(relativePath);
  const candidate = path.resolve(root, relativePath);
  if (!within(root, candidate)) throw new Error('Path is outside the workspace');
  let existing = candidate;
  for (;;) {
    try {
      const canonical = await realpath(existing);
      if (!within(root, canonical)) throw new Error('Path resolves outside the workspace');
      return existing === candidate ? canonical : candidate;
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT' || existing === root) throw error;
      try {
        if ((await lstat(existing)).isSymbolicLink()) throw new Error('Cannot resolve a symbolic link inside the workspace');
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      }
      existing = path.dirname(existing);
    }
  }
}

class BinaryFileError extends Error {}

function digest(...parts: (string | Buffer)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
}

async function fileBytes(file: string) {
  const before = await stat(file);
  if (!before.isFile()) throw new Error('Only regular files can be opened');
  if (before.size > FILE_LIMIT) throw new Error('File exceeds the 1 MiB limit');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const initial = await handle.stat({ bigint: true });
    if (!initial.isFile()) throw new Error('Only regular files can be opened');
    const buffer = Buffer.alloc(FILE_LIMIT + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > FILE_LIMIT) throw new Error('File exceeds the 1 MiB limit');
    const final = await handle.stat({ bigint: true });
    if (initial.size !== final.size || initial.mtimeNs !== final.mtimeNs || initial.ctimeNs !== final.ctimeNs) {
      throw new Error('File changed while reading; reload it');
    }
    const bytes = buffer.subarray(0, size);
    return { bytes, size, mode: Number(final.mode),
      revision: digest(`${final.dev}:${final.ino}:${final.mode}:${final.size}:${final.mtimeNs}:${final.ctimeNs}`, bytes) };
  } finally { await handle.close(); }
}

async function textFile(file: string): Promise<{ content: string; size: number; revision: string }> {
  const { bytes, size, revision } = await fileBytes(file);
  if (bytes.some((byte) => byte === 0 || (byte < 32 && ![9, 10, 12, 13].includes(byte)))) {
    throw new BinaryFileError('Binary files cannot be opened as text');
  }
  try { return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), size, revision }; }
  catch { throw new BinaryFileError('Binary or non-UTF-8 files cannot be opened as text'); }
}

const mutations = new Map<string, Promise<unknown>>();

async function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutations.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  mutations.set(key, current);
  try { return await current; }
  finally { if (mutations.get(key) === current) mutations.delete(key); }
}

async function writablePath(root: string, relativePath: string, allowMissing = false): Promise<string> {
  const relative = normalizedRelative(relativePath);
  if (!relative || relative.split('/').some(part => part === '.git')) throw new Error('A workspace file path is required');
  const target = await scopedPath(root, relative, allowMissing);
  if (target === root) throw new Error('A workspace file path is required');
  let current = root;
  for (const part of path.relative(root, path.resolve(root, relative)).split(path.sep)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Symbolic links cannot be changed from the file panel');
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return target;
}

async function mutationKey(root: string): Promise<string> {
  try { return await realpath((await git(root, ['rev-parse', '--show-toplevel'])).stdout.trim()); }
  catch (error) {
    if (/not a git repository/i.test(error instanceof Error ? error.message : String(error))) return root;
    throw error;
  }
}

export async function workspaceExecutionKey(cwd: string): Promise<string> {
  return mutationKey(await workspaceRoot(cwd));
}

type GitOutput = { stdout: string; stderr: string; code: number; truncated: boolean };

function git(cwd: string, args: string[], allowedCodes = [0], allowTruncated = false, timeout = GIT_TIMEOUT_MS): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], {
      cwd, shell: false, windowsHide: true, timeout, maxBuffer: GIT_OUTPUT_LIMIT,
      encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' },
    }, (error, stdout, stderr) => {
      const truncated = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      const code = typeof error?.code === 'number' ? error.code : error ? -1 : 0;
      if ((truncated && allowTruncated) || (!truncated && allowedCodes.includes(code))) {
        resolve({ stdout, stderr, code, truncated });
      } else {
        reject(new Error(truncated ? 'Git output exceeds the 2 MiB limit; select a smaller workspace' :
          error?.killed ? `Git operation exceeded ${timeout / 1000} seconds` : stderr.trim() || stdout.trim() || error?.message || `Git exited ${code}`));
      }
    });
  });
}

function numstat(output: string): Map<string, { additions: number; deletions: number }> {
  const fields = output.split('\0');
  const result = new Map<string, { additions: number; deletions: number }>();
  for (let index = 0; index < fields.length; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[index]);
    if (!match) continue;
    const file = match[3] || fields[index += 2];
    if (file) result.set(file, { additions: Number(match[1]) || 0, deletions: Number(match[2]) || 0 });
  }
  return result;
}

function language(file: string): string {
  const extension = path.extname(file).toLowerCase().slice(1);
  return ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
    json: 'json', md: 'markdown', py: 'python', sh: 'shell', zsh: 'shell', yml: 'yaml', yaml: 'yaml',
    html: 'html', css: 'css', rs: 'rust', go: 'go', java: 'java', c: 'c', cpp: 'cpp', sql: 'sql' } as Record<string, string>)[extension] ?? 'text';
}

const diffOptions = ['--no-ext-diff', '--no-textconv', '--relative', '--no-color'];

async function statusRecords(root: string): Promise<{ repoRoot: string; records: PorcelainV1Record[] }> {
  const [repository, status] = await Promise.all([
    git(root, ['rev-parse', '--show-toplevel']),
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']),
  ]);
  const records = parsePorcelainV1Records(status.stdout);
  if (records.length > ENTRY_LIMIT) throw new Error('Git changes exceed the 2000 entry limit; select a smaller workspace');
  return { repoRoot: repository.stdout.trim(), records };
}

export class WorkspaceFiles {
  async list(cwd: string, relativePath = ''): Promise<FileEntry[]> {
    const root = await workspaceRoot(cwd);
    const directory = await scopedPath(root, relativePath);
    if (!(await stat(directory)).isDirectory()) throw new Error('Path is not a directory');
    const entries: FileEntry[] = [];
    const reader = await opendir(directory);
    let examined = 0;
    for await (const entry of reader) {
      if (++examined > ENTRY_LIMIT) throw new Error('Directory exceeds the 2000 entry limit');
      if (entry.name === '.git') continue;
      const filePath = path.join(relativePath, entry.name);
      try {
        const file = await scopedPath(root, filePath);
        const info = await stat(file);
        if (!info.isDirectory() && !info.isFile()) continue;
        entries.push({ path: normalizedRelative(filePath), name: entry.name,
          kind: info.isDirectory() ? 'directory' : 'file', size: info.size });
      } catch (error) {
        if (!entry.isSymbolicLink() && !['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    return entries.sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === 'directory' ? -1 : 1);
  }

  async read(cwd: string, relativePath: string): Promise<FileContent> {
    const root = await workspaceRoot(cwd);
    const file = await scopedPath(root, relativePath);
    const contents = await textFile(file);
    return { path: normalizedRelative(relativePath), ...contents, language: language(relativePath) };
  }

  async write(cwd: string, input: { path: string; content: string; revision: string }): Promise<FileContent> {
    const root = await workspaceRoot(cwd);
    return serialized(await mutationKey(root), async () => {
      const file = await writablePath(root, input.path);
      const original = await textFile(file);
      if (!input.revision || original.revision !== input.revision) throw new Error('File changed on disk; reload before saving');
      const content = original.content.startsWith('\uFEFF') && !input.content.startsWith('\uFEFF') ? `\uFEFF${input.content}` : input.content;
      const encoded = Buffer.from(content, 'utf8');
      if (encoded.length > FILE_LIMIT) throw new Error('File exceeds the 1 MiB limit');
      if (encoded.some(byte => byte === 0 || (byte < 32 && ![9, 10, 12, 13].includes(byte)))) throw new Error('Binary files cannot be saved as text');
      const mode = (await lstat(file)).mode & 0o777;
      const temporary = path.join(path.dirname(file), `.workbench-${randomUUID()}.tmp`);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(temporary, 'wx', mode);
        await handle.chmod(mode);
        await handle.writeFile(encoded);
        await handle.sync();
        await handle.close(); handle = undefined;
        await writablePath(root, input.path);
        if ((await textFile(file)).revision !== input.revision) throw new Error('File changed on disk; reload before saving');
        await rename(temporary, file);
        return this.read(root, input.path);
      } finally {
        await handle?.close();
        await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      }
    });
  }

  async mutate(cwd: string, input: GitMutation): Promise<GitState> {
    const root = await workspaceRoot(cwd);
    const key = await mutationKey(root);
    return serialized(key, async () => {
      const file = await writablePath(root, input.path, true);
      const relative = normalizedRelative(path.relative(root, file));
      const status = await statusRecords(root);
      const record = status.records.find(item => path.resolve(status.repoRoot, item.path) === file);
      const original = record?.originalPath ? path.resolve(status.repoRoot, record.originalPath) : undefined;
      if (original && !within(root, original)) throw new Error('Rename crosses the workspace boundary');
      if (original) await writablePath(root, path.relative(root, original), true);
      const paths = [relative, ...(original ? [normalizedRelative(path.relative(root, original))] : [])];
      const info = await lstat(file).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
      if (info && !info.isFile()) throw new Error('Select one regular file for a Git operation');
      if (input.action === 'discard') {
        const entries = (await git(root, ['ls-files', '--stage', '-z', '--', relative])).stdout.split('\0').filter(Boolean);
        if (entries.length !== 1 || !/^(100644|100755) [0-9a-f]+ 0\t/.test(entries[0])) {
          throw new Error('Only an indexed regular file can be restored; untracked files are never deleted');
        }
        const current = await this.diff(root, relative);
        if (!input.revision || current.revision !== input.revision || current.truncated) {
          throw new Error('File or diff changed; refresh and review before discarding');
        }
        await git(root, ['restore', '--worktree', '--', relative]);
      } else if (input.action === 'stage') {
        await git(root, ['add', '--', ...paths]);
      } else if (input.action === 'unstage') {
        await git(root, ['reset', '--quiet', '--', ...paths]);
      } else throw new Error('Unsupported Git operation');
      return this.gitState(root);
    });
  }

  async commitPreview(cwd: string): Promise<GitCommitPreview> {
    const root = await workspaceRoot(cwd);
    const repository = (await git(root, ['rev-parse', '--show-toplevel'])).stdout.trim();
    const [head, index, patch, names, conflicts] = await Promise.all([
      git(repository, ['rev-parse', '--verify', 'HEAD'], [0, 128]),
      git(repository, ['ls-files', '--stage', '-z']),
      git(repository, ['diff', '--cached', '--binary', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv']),
      git(repository, ['diff', '--cached', '--name-only', '-z']),
      git(repository, ['ls-files', '--unmerged', '-z']),
    ]);
    if (conflicts.stdout) throw new Error('Resolve index conflicts before committing');
    return { revision: digest(repository, head.code === 0 ? head.stdout.trim() : 'unborn', index.stdout, patch.stdout),
      patch: patch.stdout, paths: names.stdout.split('\0').filter(Boolean), truncated: false };
  }

  async commit(cwd: string, input: { message: string; revision: string }): Promise<string> {
    const root = await workspaceRoot(cwd);
    const repository = (await git(root, ['rev-parse', '--show-toplevel'])).stdout.trim();
    return serialized(repository, async () => {
      if (!input.message.trim() || input.message.includes('\0')) throw new Error('A commit message is required');
      const preview = await this.commitPreview(root);
      if (!preview.paths.length) throw new Error('The index has no staged changes');
      if (!input.revision || preview.revision !== input.revision) throw new Error('Staged changes or HEAD changed; review the complete index again');
      await git(repository, ['commit', '-m', input.message], [0], false, 120_000);
      return (await git(repository, ['rev-parse', 'HEAD'])).stdout.trim();
    });
  }

  async gitState(cwd: string): Promise<GitState> {
    try {
      const root = await workspaceRoot(cwd);
      const [status, branch, staged, unstaged] = await Promise.all([
        statusRecords(root),
        git(root, ['symbolic-ref', '--short', '-q', 'HEAD'], [0, 1]),
        git(root, ['diff', '--cached', '--numstat', '-z', ...diffOptions, '--', '.']),
        git(root, ['diff', '--numstat', '-z', ...diffOptions, '--', '.']),
      ]);
      const stagedStats = numstat(staged.stdout);
      const unstagedStats = numstat(unstaged.stdout);
      const branchName = branch.stdout.trim() || (await git(root, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
      return { available: true, branch: branchName, changes: status.records.flatMap((record) => {
        const absolute = path.resolve(status.repoRoot, record.path);
        if (!within(root, absolute)) return [];
        const relative = normalizedRelative(path.relative(root, absolute));
        const first = stagedStats.get(relative); const second = unstagedStats.get(relative);
        return [{ path: relative, status: record.xy, staged: record.xy[0] !== ' ' && record.xy[0] !== '?',
          additions: (first?.additions ?? 0) + (second?.additions ?? 0),
          deletions: (first?.deletions ?? 0) + (second?.deletions ?? 0) }];
      }) };
    } catch (error) {
      return { available: false, branch: '', changes: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  async diff(cwd: string, relativePath: string): Promise<FileDiff> {
    const root = await workspaceRoot(cwd);
    await scopedPath(root, relativePath, true);
    const relative = normalizedRelative(path.relative(root, path.resolve(root, relativePath)));
    if (!relative) throw new Error('A file path is required');
    const status = await statusRecords(root);
    let fileIdentity: string | undefined = 'missing';
    try { fileIdentity = (await fileBytes(path.resolve(root, relative))).revision; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') fileIdentity = 'missing';
      else if ((error as NodeJS.ErrnoException).code === 'ELOOP' || /1 MiB|Only regular/.test(String(error))) fileIdentity = undefined;
      else throw error;
    }
    const revisionFor = (...parts: string[]) => fileIdentity === undefined ? undefined : digest(root, relative, fileIdentity, ...parts);
    const record = status.records.find((item) => path.resolve(status.repoRoot, item.path) === path.resolve(root, relative));
    if (record?.xy === '??') {
      const file = await scopedPath(root, relative);
      try { await textFile(file); } catch (error) {
        if (error instanceof BinaryFileError) return { path: relative, patch: 'Binary file added', binary: true, truncated: false, revision: revisionFor() };
        throw error;
      }
      const added = await git(root, ['diff', '--no-index', ...diffOptions, '--', process.platform === 'win32' ? 'NUL' : '/dev/null', relative], [0, 1], true);
      return { path: relative, patch: added.stdout, binary: false, truncated: added.truncated, revision: revisionFor(added.stdout) };
    }
    const original = record?.originalPath ? path.relative(root, path.resolve(status.repoRoot, record.originalPath)) : undefined;
    const paths = [relative];
    if (original && within(root, path.resolve(root, original))) {
      await scopedPath(root, original, true);
      paths.push(original);
    }
    const [staged, unstaged, index] = await Promise.all([
      git(root, ['diff', '--cached', ...diffOptions, '--', ...paths], [0], true),
      git(root, ['diff', ...diffOptions, '--', ...paths], [0], true),
      git(root, ['ls-files', '--stage', '-z', '--', ...paths]),
    ]);
    const sections = [staged.stdout ? `Staged changes\n${staged.stdout}` : '', unstaged.stdout ? `Working tree changes\n${unstaged.stdout}` : ''].filter(Boolean);
    const patch = sections.join('\n');
    return { path: relative, patch, binary: /(?:Binary files .* differ|GIT binary patch)/.test(patch),
      truncated: staged.truncated || unstaged.truncated, revision: revisionFor(index.stdout, staged.stdout, unstaged.stdout) };
  }
}
