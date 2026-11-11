// Atomic save flow adapted from Paseo 05920a236cb6ba8eeae128ee7bb6677cc226cd3a, packages/server/src/server/file-explorer/service.ts:433-531.
// Copyright (c) 2025-present Mohamed Boudra. Apache-2.0; see licenses/Paseo-Apache-2.0.txt.
// Modified: own path boundaries, content-and-file revision, shared mutation queue, and explicit save errors.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import type { FileContent, FileDiff, FileEntry, FileImage, GitBranchChange, GitBranchComparison, GitCommitPreview, GitHistory, GitHistoryCommit, GitMutation, GitState, GitSyncRequest, GitSyncState,
  WorkspaceFileMatch, WorkspaceTextMatch, WorkspaceTextSearch } from '../shared/types';
import { rasterImageMimeFromPath } from '../shared/raster-image';
import { detectRasterImageMime } from './raster-image';
import { parsePorcelainV1Records, type PorcelainV1Record } from './vendor/orca/porcelain-v1-records';

const FILE_LIMIT = 1024 * 1024;
const IMAGE_FILE_LIMIT = 4 * 1024 * 1024;
const ENTRY_LIMIT = 2000;
const GIT_TIMEOUT_MS = 5000;
const GIT_OUTPUT_LIMIT = 2 * 1024 * 1024;

class WorkspaceBoundaryError extends Error {}
class NonRegularFileError extends Error {}
class BinaryFileError extends Error {}
class GitTimeoutError extends Error {}

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
  if (!within(root, candidate)) throw new WorkspaceBoundaryError('Path is outside the workspace');
  let existing = candidate;
  for (;;) {
    try {
      const canonical = await realpath(existing);
      if (!within(root, canonical)) throw new WorkspaceBoundaryError('Path resolves outside the workspace');
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

function digest(...parts: (string | Buffer)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
}

async function fileBytes(file: string, limit = FILE_LIMIT) {
  const before = await stat(file);
  if (!before.isFile()) throw new NonRegularFileError('Only regular files can be opened');
  const sizeError = () => new Error(`File exceeds the ${limit / 1024 / 1024} MiB limit`);
  if (before.size > limit) throw sizeError();
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const initial = await handle.stat({ bigint: true });
    if (!initial.isFile()) throw new NonRegularFileError('Only regular files can be opened');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > limit) throw sizeError();
    const final = await handle.stat({ bigint: true });
    if (initial.size !== final.size || initial.mtimeNs !== final.mtimeNs || initial.ctimeNs !== final.ctimeNs) {
      throw new Error('File changed while reading; reload it');
    }
    const bytes = buffer.subarray(0, size);
    return { bytes, size, mode: Number(final.mode),
      revision: digest(`${final.dev}:${final.ino}:${final.mode}:${final.size}:${final.mtimeNs}:${final.ctimeNs}`, bytes) };
  } finally { await handle.close(); }
}

function decodeText(bytes: Buffer): string {
  if (bytes.some((byte) => byte === 0 || (byte < 32 && ![9, 10, 12, 13].includes(byte)))) {
    throw new BinaryFileError('Binary files cannot be opened as text');
  }
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new BinaryFileError('Binary or non-UTF-8 files cannot be opened as text'); }
}

async function textFile(file: string): Promise<{ content: string; size: number; revision: string }> {
  const { bytes, size, revision } = await fileBytes(file);
  return { content: decodeText(bytes), size, revision };
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

function git(cwd: string, args: string[], allowedCodes = [0], allowTruncated = false, timeout = GIT_TIMEOUT_MS,
  environment?: NodeJS.ProcessEnv, input?: string): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], {
      cwd, shell: false, windowsHide: true, timeout, maxBuffer: GIT_OUTPUT_LIMIT,
      encoding: 'utf8', env: { ...process.env, ...environment, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' },
    }, (error, stdout, stderr) => {
      const truncated = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      const code = typeof error?.code === 'number' ? error.code : error ? -1 : 0;
      if ((truncated && allowTruncated) || (!truncated && allowedCodes.includes(code))) {
        resolve({ stdout, stderr, code, truncated });
      } else if (error?.code === 'ENOENT') {
        reject(error);
      } else if (!truncated && error?.killed) {
        reject(new GitTimeoutError(`Git operation exceeded ${timeout / 1000} seconds`));
      } else {
        reject(new Error(truncated ? 'Git output exceeds the 2 MiB limit; select a smaller workspace' :
          stderr.trim() || stdout.trim() || error?.message || `Git exited ${code}`));
      }
    });
    if (input !== undefined) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(input);
    }
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
    json: 'json', md: 'markdown', markdown: 'markdown', py: 'python', sh: 'shell', zsh: 'shell', yml: 'yaml', yaml: 'yaml',
    html: 'html', css: 'css', rs: 'rust', go: 'go', java: 'java', c: 'c', cpp: 'cpp', sql: 'sql' } as Record<string, string>)[extension] ?? 'text';
}

const diffSafetyOptions = ['--no-ext-diff', '--no-textconv', '--no-color'];
const diffOptions = [...diffSafetyOptions, '--relative'];

const branchRefPattern = /^refs\/(?:heads|remotes)\//;
const commitShaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const workspaceReadEnvironment: NodeJS.ProcessEnv = {
  GIT_DIR: undefined, GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined,
  GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '',
};

function branchGit(root: string, args: string[], { allowedCodes = [0], allowTruncated = false, attributes }: {
  allowedCodes?: number[]; allowTruncated?: boolean; attributes?: string;
} = {}) {
  return git(root, args, allowedCodes, allowTruncated, GIT_TIMEOUT_MS, { ...workspaceReadEnvironment, GIT_ATTR_SOURCE: attributes });
}

async function branchRefs(root: string, patterns: string[]) {
  const { stdout } = await branchGit(root, [
    'for-each-ref', `--count=${ENTRY_LIMIT + 1}`, '--sort=refname', '--format=%(refname)%00%(symref)%00%(objecttype)%00%(objectname)', '--', ...patterns,
  ]);
  const rows = stdout.split('\n').filter(Boolean);
  if (rows.length > ENTRY_LIMIT) throw new Error('Git branch references exceed the 2000 entry limit');
  return rows.flatMap(row => {
    const [ref, symbolic, type, sha] = row.split('\0');
    return branchRefPattern.test(ref) && !symbolic && type === 'commit' && commitShaPattern.test(sha) ? [{ ref, sha }] : [];
  });
}

async function statusRecords(root: string): Promise<{ repoRoot: string; records: PorcelainV1Record[] }> {
  const [repository, status] = await Promise.all([
    git(root, ['rev-parse', '--show-toplevel']),
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']),
  ]);
  const records = parsePorcelainV1Records(status.stdout);
  if (records.length > ENTRY_LIMIT) throw new Error('Git changes exceed the 2000 entry limit; select a smaller workspace');
  return { repoRoot: repository.stdout.trim(), records };
}

export class MissingWorkspaceDirectoryError extends Error {}

const FILE_SEARCH_EXCLUDED = new Set(['.git', '.hg', '.svn', 'node_modules', '.worktrees', '.venv']);
const DIRECTORY_SEARCH_ENTRY_LIMIT = 30_000;
const TEXT_SEARCH_TIMEOUT_MS = 3000;
const TEXT_SEARCH_FILE_LIMIT = 5000;
const TEXT_SEARCH_BYTE_LIMIT = 64 * 1024 * 1024;
const TEXT_SEARCH_MATCH_LIMIT = 200;
const TEXT_SEARCH_PREVIEW_LIMIT = 240;

type WorkspacePaths = { paths: string[]; limited: boolean };

function searchExcluded(relativePath: string): boolean {
  return relativePath.split('/').some(part => FILE_SEARCH_EXCLUDED.has(part));
}

async function plainWorkspacePaths(root: string, deadline: number): Promise<WorkspacePaths> {
  const paths: string[] = [];
  const directories = [''];
  let examined = 0;
  let limited = false;
  for (const directory of directories) {
    if (performance.now() >= deadline) return { paths, limited: true };
    const entries = await opendir(path.join(root, directory)).catch(error => {
      if (directory && ['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        limited = true;
        return undefined;
      }
      throw error;
    });
    if (!entries) continue;
    for await (const entry of entries) {
      if (++examined > DIRECTORY_SEARCH_ENTRY_LIMIT || performance.now() >= deadline) return { paths, limited: true };
      if (FILE_SEARCH_EXCLUDED.has(entry.name)) continue;
      const relativePath = path.join(directory, entry.name);
      if (entry.isDirectory()) directories.push(relativePath);
      else if (entry.isFile()) paths.push(normalizedRelative(relativePath));
    }
  }
  return { paths, limited };
}

async function workspacePaths(root: string, { deadline = Infinity, fallbackOnGitError = false } = {}): Promise<WorkspacePaths> {
  try {
    const gitFiles = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
      [0, 128], true, Math.max(1, Math.min(GIT_TIMEOUT_MS, Math.ceil(deadline - performance.now()))),
      { ...workspaceReadEnvironment, LC_ALL: 'C' });
    if (gitFiles.truncated || gitFiles.code === 0) {
      const paths = new Set(gitFiles.stdout.split('\0').slice(0, -1).filter(relativePath => !searchExcluded(relativePath)));
      return { paths: [...paths], limited: gitFiles.truncated || Boolean(gitFiles.stderr.trim()) };
    }
    if (!/^fatal: not a git repository\b/m.test(gitFiles.stderr)) throw new Error(gitFiles.stderr.trim() || 'Could not list workspace files');
  } catch (error) {
    if (!fallbackOnGitError && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof GitTimeoutError) return { paths: [], limited: true };
      throw error;
    }
  }
  return plainWorkspacePaths(root, deadline);
}

function textMatchPreview(line: string, index: number): string {
  if (line.length <= TEXT_SEARCH_PREVIEW_LIMIT) return line;
  const start = Math.max(0, index - 60);
  const end = Math.min(line.length, start + TEXT_SEARCH_PREVIEW_LIMIT - 2);
  const excerpt = line.slice(start, end).replace(/^[\udc00-\udfff]|[\ud800-\udbff]$/g, '');
  return `${start ? '…' : ''}${excerpt}${end < line.length ? '…' : ''}`;
}

export class WorkspaceFiles {
  async find(cwd: string, query: string): Promise<WorkspaceFileMatch[]> {
    let root: string;
    try { root = await workspaceRoot(cwd); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const { paths } = await workspacePaths(root, { fallbackOnGitError: true });
    const needle = query.trim().toLowerCase();
    const candidates = paths.flatMap(relativePath => {
      const name = path.basename(relativePath);
      const file = name.toLowerCase();
      const match = relativePath.toLowerCase().indexOf(needle);
      if (match < 0) return [];
      const rank = file === needle ? 0 : file.startsWith(needle) ? 1 : file.includes(needle) ? 2 : 3;
      return [{ path: relativePath, name, rank }];
    }).sort((left, right) => left.rank - right.rank || left.path.length - right.path.length || left.path.localeCompare(right.path));
    const matches: WorkspaceFileMatch[] = [];
    for (const candidate of candidates) {
      const file = await scopedPath(root, candidate.path).then(value => stat(value)).catch(() => undefined);
      if (file?.isFile()) matches.push({ path: candidate.path, name: candidate.name });
      if (matches.length === 30) break;
    }
    return matches;
  }

  async searchText(cwd: string, query: string): Promise<WorkspaceTextSearch> {
    const matches: WorkspaceTextMatch[] = [];
    if (!query || /[\r\n]/.test(query)) return { matches, limited: false };
    const deadline = performance.now() + TEXT_SEARCH_TIMEOUT_MS;
    const root = await workspaceRoot(cwd);
    const candidates = await workspacePaths(root, { deadline });
    const needle = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
    let limited = candidates.limited;
    let examined = 0;
    let scannedBytes = 0;
    for (const relativePath of candidates.paths.sort()) {
      if (++examined > TEXT_SEARCH_FILE_LIMIT || scannedBytes >= TEXT_SEARCH_BYTE_LIMIT || performance.now() >= deadline) {
        return { matches, limited: true };
      }
      let content: string;
      try {
        const file = await scopedPath(root, relativePath);
        if (file !== path.resolve(root, relativePath)) continue;
        const { bytes, size } = await fileBytes(file);
        scannedBytes += size;
        content = decodeText(bytes);
      } catch (error) {
        if (error instanceof BinaryFileError || error instanceof WorkspaceBoundaryError || error instanceof NonRegularFileError ||
          (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        limited = true;
        continue;
      }
      const separator = content.includes('\r\n') ? '\r\n' : content.includes('\r') ? '\r' : '\n';
      let lineNumber = 0;
      for (const line of content.split(separator)) {
        if (lineNumber % 256 === 0 && performance.now() >= deadline) return { matches, limited: true };
        lineNumber++;
        const index = line.search(needle);
        if (index < 0) continue;
        if (matches.length >= TEXT_SEARCH_MATCH_LIMIT) return { matches, limited: true };
        matches.push({ path: relativePath, line: lineNumber, column: index + 1, preview: textMatchPreview(line, index) });
      }
    }
    return { matches, limited };
  }

  async list(cwd: string, relativePath = ''): Promise<FileEntry[]> {
    const root = await workspaceRoot(cwd).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MissingWorkspaceDirectoryError(error.message, { cause: error });
      throw error;
    });
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

  async readImage(cwd: string, relativePath: string): Promise<FileImage> {
    const root = await workspaceRoot(cwd);
    const file = await scopedPath(root, relativePath);
    const relative = normalizedRelative(relativePath);
    const mimeType = rasterImageMimeFromPath(relative);
    if (!mimeType) throw new Error('Image preview supports PNG, JPEG, GIF, and WebP');
    const { bytes, size, revision } = await fileBytes(file, IMAGE_FILE_LIMIT);
    if (detectRasterImageMime(bytes) !== mimeType) throw new Error('Image format does not match the file extension');
    return { path: relative, base64: bytes.toString('base64'), size, mimeType, revision };
  }

  async resolveFilePaths(cwd: string, relativePaths: string[]): Promise<string[]> {
    const root = await workspaceRoot(cwd);
    return Promise.all(relativePaths.map(relativePath => scopedPath(root, relativePath)));
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
      const requested = [...new Set('paths' in input ? input.paths : [input.path])];
      if (!requested.length || requested.length > ENTRY_LIMIT) throw new Error('Select between 1 and 2000 workspace files');
      const status = await statusRecords(root);
      const records = new Map(status.records.map(record => [path.resolve(status.repoRoot, record.path), record]));
      const paths = new Set<string>();
      for (const item of requested) {
        const file = await writablePath(root, item, true);
        const relative = normalizedRelative(path.relative(root, file));
        const record = records.get(file);
        if ('paths' in input && (!record || (input.action === 'stage' ? record.xy[1] === ' ' : [' ', '?'].includes(record.xy[0])))) {
          throw new Error('Selected Git changes are out of date; refresh and select the files again');
        }
        const info = await lstat(file).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
        if (info && !info.isFile()) throw new Error('Select regular files for a Git operation');
        paths.add(relative);
        if (record?.originalPath) {
          const original = path.resolve(status.repoRoot, record.originalPath);
          if (!within(root, original)) throw new Error('Rename crosses the workspace boundary');
          const originalRelative = normalizedRelative(path.relative(root, original));
          await writablePath(root, originalRelative, true);
          paths.add(originalRelative);
        }
      }
      if (input.action === 'discard') {
        const relative = normalizedRelative(path.relative(root, path.resolve(root, input.path)));
        const entries = (await git(root, ['ls-files', '--stage', '-z', '--', relative])).stdout.split('\0').filter(Boolean);
        if (entries.length !== 1 || !/^(100644|100755) [0-9a-f]+ 0\t/.test(entries[0])) {
          throw new Error('Only an indexed regular file can be restored; untracked files are never deleted');
        }
        const current = await this.diff(root, relative);
        if (!input.revision || current.revision !== input.revision || current.truncated) {
          throw new Error('File or diff changed; refresh and review before discarding');
        }
        await git(root, ['restore', '--worktree', '--', relative]);
      } else {
        const operation = input.action === 'stage' ? ['add'] : ['reset', '--quiet'];
        await git(root, [...operation, '--pathspec-from-file=-', '--pathspec-file-nul'], [0], false, GIT_TIMEOUT_MS, undefined, [...paths].join('\0') + '\0');
      }
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

  async gitBranchRefs(cwd: string): Promise<string[]> {
    const root = await workspaceRoot(cwd);
    return (await branchRefs(root, ['refs/heads/', 'refs/remotes/'])).map(({ ref }) => ref);
  }

  async changeGitBranch(cwd: string, change: GitBranchChange): Promise<GitState> {
    const root = await workspaceRoot(cwd);
    const repository = await mutationKey(root);
    return serialized(repository, async () => {
      const ref = `refs/heads/${change.name}`;
      if (!change.name || change.name.startsWith('-') || change.name.includes('\0')
        || (await branchGit(repository, ['check-ref-format', ref], { allowedCodes: [0, 1] })).code !== 0) {
        throw new Error('Enter a valid local branch name');
      }
      const status = await this.gitState(repository);
      if (!status.available) throw new Error(status.error ?? 'Git repository is unavailable');
      if (status.branch !== change.expectedBranch) throw new Error('The current branch changed; refresh before switching');
      if (status.changes.length) throw new Error('Commit or stash your changes before changing branches');
      const refs = await branchRefs(repository, ['refs/heads/']);
      if (refs.some(item => item.ref === ref) !== (change.action === 'switch')) {
        throw new Error(change.action === 'switch' ? 'This local branch is unavailable' : 'This branch already exists');
      }
      const args = change.action === 'create' ? ['switch', '-c', change.name] : ['switch', '--no-guess', '--', change.name];
      await git(repository, args);
      return this.gitState(root);
    });
  }

  async gitSyncState(cwd: string): Promise<GitSyncState> {
    const repository = await mutationKey(await workspaceRoot(cwd));
    const [head, configured] = await Promise.all([
      branchGit(repository, ['symbolic-ref', '-q', 'HEAD'], { allowedCodes: [0, 1] }),
      branchGit(repository, ['remote']),
    ]);
    const remotes = configured.stdout.trim().split('\n').filter(value => value && value !== '.' && !value.startsWith('-'));
    const current = head.stdout.trim();
    const branch = current.startsWith('refs/heads/') ? current.slice('refs/heads/'.length) : null;
    if (!branch) return { branch, remotes };
    const { stdout } = await branchGit(repository, ['for-each-ref', '--count=1',
      '--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)', '--', current]);
    const [name, remote, ref, tracking] = stdout.trimEnd().split('\0');
    if (name !== current || !remotes.includes(remote) || !ref.startsWith('refs/heads/')) return { branch, remotes };
    const count = await branchGit(repository, ['rev-list', '--left-right', '--count', `HEAD...${tracking}`, '--'], { allowedCodes: [0, 128] });
    const [ahead, behind] = count.code === 0 ? count.stdout.trim().split(/\s+/).map(Number) : [];
    return { branch, remotes, upstream: { remote, ref, ahead, behind } };
  }

  async syncGit(cwd: string, request: GitSyncRequest): Promise<GitSyncState> {
    const repository = await mutationKey(await workspaceRoot(cwd));
    return serialized(repository, async () => {
      const current = await this.gitSyncState(repository);
      if (!current.branch || current.branch !== request.expectedBranch) throw new Error('The current branch changed; refresh before syncing');
      if (!current.remotes.includes(request.remote) || (current.upstream && current.upstream.remote !== request.remote)) {
        throw new Error('The selected Git remote is no longer available for this branch');
      }
      const upstream = current.upstream;
      const local = `refs/heads/${current.branch}`;
      let args: string[];
      if (request.action === 'fetch') args = ['fetch', '--no-recurse-submodules', '--', request.remote];
      else if (request.action === 'pull') {
        if (!upstream) throw new Error('Set an upstream before pulling');
        const status = await this.gitState(repository);
        if (!status.available || status.changes.length) throw new Error('Commit or stash changes before pulling');
        args = ['pull', '--ff-only', '--no-rebase', '--no-recurse-submodules', '--', request.remote, upstream.ref];
      } else args = ['push', '--no-recurse-submodules', ...(!upstream ? ['--set-upstream'] : []), '--', request.remote, `${local}:${upstream?.ref ?? local}`];
      try {
        await git(repository, args, [0], false, 120_000, { GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:http:ssh:git:file' });
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (/authenticat|credential|permission denied/i.test(message)) throw new Error('Git authentication failed. Check this remote’s credentials and try again.');
        if (/non-fast-forward|rejected|diverg/i.test(message)) throw new Error('The remote branch has diverged. Fetch and review its commits before syncing.');
        if (error instanceof GitTimeoutError) throw new Error('Git sync timed out. Check the remote and try again.');
        throw new Error('Git sync failed. Check the remote’s availability and configuration.');
      }
      return this.gitSyncState(repository);
    });
  }

  async gitHistory(cwd: string, query: string, allBranches: boolean, limit: number): Promise<GitHistory> {
    const root = await workspaceRoot(cwd);
    const head = await branchGit(root, ['rev-parse', '--verify', 'HEAD^{commit}'], { allowedCodes: [0, 128] });
    if (!allBranches && head.code !== 0) return { commits: [], limited: false };
    if (head.code !== 0) {
      const refs = await branchGit(root, ['for-each-ref', '--count=1', '--format=%(objectname)', 'refs/heads', 'refs/remotes']);
      if (!refs.stdout.trim()) return { commits: [], limited: false };
    }
    const refs = allBranches ? ['--branches', '--remotes', ...(head.code === 0 ? ['HEAD'] : [])] : ['HEAD'];
    const filter = query ? ['--fixed-strings', '--regexp-ignore-case', `--grep=${query}`] : [];
    const format = ['%H', '%P', '%s', '%an', '%aI', '%D'].join('%x00');
    const result = await branchGit(root, ['log', '--topo-order', '--full-history', '--parents', '-z', `--max-count=${limit + 1}`,
      `--format=${format}`, ...filter, ...refs, '--', '.']);
    const fields = result.stdout.split('\0');
    const commits: GitHistoryCommit[] = [];
    for (let index = 0; index + 5 < fields.length; index += 6) {
      const [sha, parentList, subject, author, authoredAt, refs] = fields.slice(index, index + 6);
      if (!commitShaPattern.test(sha)) throw new Error('Git returned an invalid commit history record');
      commits.push({ sha, parents: parentList.split(' ').filter(parent => commitShaPattern.test(parent)), subject, author, authoredAt, refs });
    }
    return { commits: commits.slice(0, limit), limited: commits.length > limit };
  }

  private async commitDiffArgs(root: string, sha: string) {
    if (!commitShaPattern.test(sha)) throw new Error('Select a valid commit');
    const { stdout } = await branchGit(root, ['rev-list', '--parents', '-n', '1', `${sha}^{commit}`, '--']);
    const [commit, parent] = stdout.trim().split(' ');
    if (commit !== sha) throw new Error('The selected commit is unavailable');
    return parent ? ['diff', parent, sha] : ['show', '--format=', '--root', sha];
  }

  private async commitPaths(root: string, args: string[]) {
    const { stdout } = await branchGit(root, [...args, '--name-only', '-z', '--no-renames', ...diffOptions, '--', '.']);
    const files = stdout.split('\0').filter(Boolean);
    if (files.length > ENTRY_LIMIT) throw new Error('Commit changes exceed the 2000 entry limit');
    return files;
  }

  async gitCommitFiles(cwd: string, sha: string): Promise<string[]> {
    const root = await workspaceRoot(cwd);
    return this.commitPaths(root, await this.commitDiffArgs(root, sha));
  }

  async gitCommitDiff(cwd: string, sha: string, path: string): Promise<FileDiff> {
    const root = await workspaceRoot(cwd);
    const args = await this.commitDiffArgs(root, sha);
    if (!(await this.commitPaths(root, args)).includes(path)) throw new Error('The file did not change in this commit inside the workspace');
    const result = await branchGit(root, [...args, '--no-renames', ...diffOptions, '--', path], { allowTruncated: true });
    return { path, patch: result.stdout, binary: /^Binary files .* differ$/m.test(result.stdout), truncated: result.truncated };
  }

  async gitBranchComparison(cwd: string, targetRef: string): Promise<GitBranchComparison> {
    const root = await workspaceRoot(cwd);
    if (!branchRefPattern.test(targetRef) || targetRef.includes('\0') ||
      (await branchGit(root, ['check-ref-format', targetRef], { allowedCodes: [0, 1] })).code !== 0) {
      throw new Error('Select a full local or remote-tracking branch reference');
    }
    const [references, head, gitDir, topLevel] = await Promise.all([
      branchRefs(root, [targetRef]),
      branchGit(root, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], { allowedCodes: [0, 128] }),
      branchGit(root, ['rev-parse', '--absolute-git-dir']),
      branchGit(root, ['rev-parse', '--show-toplevel']),
    ]);
    const target = references.find(item => item.ref === targetRef);
    if (!target) throw new Error('The selected branch reference is unavailable');
    const headSha = head.stdout.trim();
    if (head.code !== 0 || !commitShaPattern.test(headSha)) throw new Error('The current HEAD has no commit');
    const ancestor = await branchGit(root, ['merge-base', target.sha, headSha], { allowedCodes: [0, 1] });
    const mergeBase = ancestor.stdout.trim();
    if (ancestor.code !== 0 || !commitShaPattern.test(mergeBase)) throw new Error('No common ancestor was found for the selected branch and HEAD');

    const repository = await realpath(topLevel.stdout.replace(/\n$/, ''));
    if (!within(repository, root)) throw new Error('The project directory is outside its Git repository');
    const project = normalizedRelative(path.relative(repository, root));
    // Bare mode excludes working tree and index attributes even on older Git versions.
    const { stdout: patch, truncated } = await branchGit(root, [
      `--git-dir=${gitDir.stdout.replace(/\n$/, '')}`, '--bare', 'diff', ...diffSafetyOptions,
      project ? `--relative=${project}/` : '--relative', '--submodule=short', '--ignore-submodules=none',
      mergeBase, headSha, '--', project || '.',
    ], { allowTruncated: true, attributes: headSha });
    return { targetRef, targetSha: target.sha, mergeBase, headSha, patch, truncated };
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
