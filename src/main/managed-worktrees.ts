import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { CreateWorkspaceInput, ManagedWorktree, WorktreeOperation } from '../shared/types';
import type { StateStore } from './store';
import type { WorkbenchEngine } from './engine';
import { commandHash, previousSessionCommand, runSessionCommand } from './session-commands';
import { workspacePathContains as contains } from './workspace-path';

const execute = promisify(execFile);
const active = new Set(['queued', 'running', 'waiting_approval', 'waiting_children']);
const timestamp = () => new Date().toISOString();
async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execute('git', args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return result.stdout.trim();
}
export class ManagedWorktrees {
  private readonly requests = new Map<string, { hash: string; promise: Promise<string> }>();
  private readonly repositories = new Map<string, Promise<unknown>>();
  private readonly removals = new Set<string>();
  private readonly accesses = new Map<string, number>();

  constructor(private store: StateStore, private engine: WorkbenchEngine, private directory: string,
    private beforeRemove: (workspaceId: string) => void = () => {}) {}

  metadata(workspaceId: string): ManagedWorktree | undefined {
    const operation = this.store.state.worktreeOperations?.find(item => item.workspaceId === workspaceId && (item.status === 'ready' || item.status === 'removing'));
    return operation ? { repoRoot: operation.repoRoot, path: operation.path, branch: operation.branch,
      baseSha: operation.baseSha, createdAt: operation.createdAt, ownership: 'created', status: operation.status as 'ready' | 'removing' } : undefined;
  }

  assertWorkspaceAvailable(workspaceId: string): void {
    const owner = this.owner(workspaceId);
    if (owner?.status === 'removed') throw new Error('这个工作区已回收，请重新选择项目。');
    if (owner?.status === 'removing' || this.removals.has(this.resource(workspaceId, owner))) throw new Error('工作区正在回收，请等待操作结束或继续回收。');
  }

  async access<T>(workspaceId: string, operation: () => T | Promise<T>): Promise<T> {
    this.assertWorkspaceAvailable(workspaceId);
    if (!this.store.state.workspaces.some(workspace => workspace.id === workspaceId)) throw new Error('工作区不存在。');
    const resource = this.resource(workspaceId);
    this.accesses.set(resource, (this.accesses.get(resource) ?? 0) + 1);
    try { return await operation(); }
    finally {
      const remaining = this.accesses.get(resource)! - 1;
      if (remaining) this.accesses.set(resource, remaining); else this.accesses.delete(resource);
    }
  }

  workspaceIds(workspaceId: string): string[] {
    const owner = this.owner(workspaceId);
    return owner ? this.store.state.workspaces.filter(workspace => contains(owner.path, workspace.cwd)).map(workspace => workspace.id)
      : this.store.state.workspaces.filter(workspace => workspace.id === workspaceId).map(workspace => workspace.id);
  }

  private owner(workspaceId: string): WorktreeOperation | undefined {
    const operations = this.store.state.worktreeOperations ?? [];
    const direct = operations.find(operation => operation.workspaceId === workspaceId);
    if (direct) return direct;
    const workspace = this.store.state.workspaces.find(item => item.id === workspaceId);
    return workspace ? operations.find(operation => contains(operation.path, workspace.cwd)) : undefined;
  }

  private resource(workspaceId: string, owner = this.owner(workspaceId)): string {
    return owner ? `worktree:${owner.commandId}` : `workspace:${workspaceId}`;
  }

  create(input: CreateWorkspaceInput): Promise<string> {
    const commandId = input.commandId ?? randomUUID();
    const payload = { name: input.name.trim(), cwd: input.cwd, branch: input.branch ?? null };
    const hash = commandHash('create-worktree', payload);
    try { previousSessionCommand(this.store, 'create-worktree', commandId, payload); }
    catch (error) { return Promise.reject(error); }
    const previous = this.store.state.worktreeOperations?.find(item => item.commandId === commandId);
    if (previous && previous.inputHash !== hash) return Promise.reject(new Error('commandId 已用于不同的工作区创建请求。'));
    const pending = this.requests.get(commandId);
    if (pending) return pending.hash === hash ? pending.promise : Promise.reject(new Error('commandId 已用于不同的工作区创建请求。'));
    const request = this.provision(input, commandId, hash).finally(() => this.requests.delete(commandId));
    this.requests.set(commandId, { hash, promise: request });
    return request;
  }

  private async provision(input: CreateWorkspaceInput, commandId: string, inputHash: string): Promise<string> {
    let operation = this.store.state.worktreeOperations?.find(item => item.commandId === commandId);
    if (operation?.status === 'ready' && operation.workspaceId) return operation.workspaceId;
    if (operation && operation.status !== 'creating') throw new Error(operation.error ?? '这次创建操作已经结束，请重新创建工作区。');
    if (!operation) {
      const sourceCwd = await realpath(input.cwd);
      if (!(await stat(sourceCwd)).isDirectory()) throw new Error('项目路径必须是目录。');
      const sourceRoot = await realpath(await git(sourceCwd, ['rev-parse', '--show-toplevel']));
      const relativeCwd = relative(sourceRoot, sourceCwd);
      if (!contains(sourceRoot, sourceCwd)) throw new Error('执行目录不属于该 Git 仓库。');
      const mainWorktree = (await git(sourceRoot, ['worktree', 'list', '--porcelain', '-z'])).split('\0')[0];
      if (!mainWorktree.startsWith('worktree ')) throw new Error('无法确定仓库的主工作区，不能创建独立工作区。');
      const repoRoot = await realpath(mainWorktree.slice('worktree '.length));
      const baseSha = await git(sourceCwd, ['rev-parse', 'HEAD']);
      if (relativeCwd) {
        let kind: string;
        try { kind = await git(sourceRoot, ['cat-file', '-t', `${baseSha}:${relativeCwd.split(sep).join('/')}`]); }
        catch (error) { throw new Error('所选子目录没有保存在当前提交中，不能在独立工作区中使用。请先提交该目录或选择仓库根目录。', { cause: error }); }
        if (kind !== 'tree') throw new Error('所选路径在当前提交中不是目录，不能在独立工作区中使用。');
      }
      const suffix = createHash('sha256').update(commandId).digest('hex').slice(0, 12);
      const slug = (input.name.trim() || basename(repoRoot)).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'task';
      const branch = input.branch?.trim() || `ensemble/${slug}-${suffix}`;
      await git(repoRoot, ['check-ref-format', '--branch', branch]);
      try { await git(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]); throw new Error('该分支已经存在，请选择新的分支名。'); }
      catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = join(await realpath(this.directory), suffix);
      operation = { commandId, inputHash, name: input.name.trim() || basename(repoRoot), sourceCwd, relativeCwd,
        repoRoot, path, branch, baseSha, status: 'creating', ownership: 'created', createdAt: timestamp(), updatedAt: timestamp() };
      const accepted = runSessionCommand(this.store, 'create-worktree', commandId,
        { name: input.name.trim(), cwd: input.cwd, branch: input.branch ?? null }, () => {
          (this.store.state.worktreeOperations ??= []).push(operation!);
          return { operationId: commandId };
        });
      if (accepted.replayed) throw new Error('创建收据缺少工作区归属记录，不能重复创建。');
    }
    const current = operation;
    return this.serialize(current.repoRoot, () => this.engine.withProjectMutation(current.sourceCwd, async () => {
      try {
        await this.validateLocation(current);
        const registered = await this.registered(current);
        if (!registered) {
          let branchExists = false;
          try { branchExists = (await git(current.repoRoot, ['rev-parse', '--verify', `refs/heads/${current.branch}`])) === current.baseSha; }
          catch (error) { if ((error as { code?: number }).code !== 128 && (error as { code?: number }).code !== 1) throw error; }
          await git(current.repoRoot, branchExists ? ['worktree', 'add', current.path, current.branch]
            : ['worktree', 'add', '-b', current.branch, current.path, current.baseSha]);
        }
        if (await git(current.path, ['symbolic-ref', '--short', 'HEAD']) !== current.branch) throw new Error('工作区分支与创建记录不符，保留目录供检查。');
        const cwd = await realpath(join(current.path, current.relativeCwd));
        if (!contains(current.path, cwd)) throw new Error('工作区子目录越过了独立 checkout。');
        const workspaceId = await this.engine.createWorkspace({ name: current.name, cwd });
        this.store.atomic(() => { current.workspaceId = workspaceId; current.status = 'ready'; current.updatedAt = timestamp(); });
        this.engine.publishState();
        return workspaceId;
      } catch (error) {
        this.store.atomic(() => { current.status = 'failed'; current.error = error instanceof Error ? error.message : '工作区创建失败。'; current.updatedAt = timestamp(); });
        throw new Error(`工作区创建未完成：${current.error}。已保留创建记录；目录 ${current.path}，分支 ${current.branch}。`, { cause: error });
      }
    }));
  }

  async remove(workspaceId: string): Promise<void> {
    if (this.store.state.worktreeOperations?.some(item => item.workspaceId === workspaceId && item.status === 'removed')) return;
    const operation = this.store.state.worktreeOperations?.find(item => item.workspaceId === workspaceId && (item.status === 'ready' || item.status === 'removing'));
    if (!operation) throw new Error('只能回收 Ensemble 创建并仍有归属记录的工作区。');
    const resource = this.resource(workspaceId, operation);
    if (this.removals.has(resource)) throw new Error('工作区正在回收，请等待操作结束。');
    const checkReferences = () => {
      if (this.accesses.has(resource)) throw new Error('工作区仍有文件或配置操作未结束，不能回收。');
      this.beforeRemove(workspaceId);
      if (this.store.state.sessions.some(session => contains(operation.path, session.cwd) && (active.has(session.status) || session.queue?.length))) {
        throw new Error('工作区仍有运行中或排队的任务，不能回收。');
      }
    };
    checkReferences();
    this.removals.add(resource);
    let stage = '检查回收条件';
    try {
      await this.serialize(operation.repoRoot, () => this.engine.withProjectMutation(operation.repoRoot, async () => {
        checkReferences();
        const exists = await this.validateLocation(operation);
        if (exists) {
          if (!await this.registered(operation)) throw new Error('Git 工作区已变化，不能根据旧记录删除目录。');
          if (await git(operation.path, ['symbolic-ref', '--short', 'HEAD']) !== operation.branch) throw new Error('工作区已切换分支，不能自动回收。');
          if (await git(operation.path, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('工作区有未提交文件，保留目录和分支。');
          const head = await git(operation.path, ['rev-parse', 'HEAD']);
          await this.assertMerged(operation, head);
          checkReferences();
          this.store.atomic(() => { operation.status = 'removing'; operation.cleanupHeadSha = head; operation.updatedAt = timestamp(); delete operation.error; });
          this.engine.publishState();
          stage = '删除独立目录';
          await git(operation.repoRoot, ['worktree', 'remove', operation.path]);
        } else if (operation.status !== 'removing' || !operation.cleanupHeadSha) {
          throw new Error('工作区目录不存在且没有持久回收记录，不能删除分支。');
        }
        stage = '删除分支';
        await this.removeBranch(operation);
        stage = '保存回收结果';
        this.store.atomic(state => {
          operation.status = 'removed'; operation.updatedAt = timestamp(); delete operation.error;
          for (const session of state.sessions) if (contains(operation.path, session.cwd)) session.archived = true;
          state.workspaces = state.workspaces.filter(workspace => !contains(operation.path, workspace.cwd));
        });
        this.engine.publishState();
      }));
    } catch (error) {
      if (operation.status === 'removing') {
        const message = `工作区回收尚未完成（${stage}）：${error instanceof Error ? error.message : String(error)}`;
        try { this.store.atomic(() => { operation.error = message; operation.updatedAt = timestamp(); }); this.engine.publishState(); }
        catch (recordError) { throw new AggregateError([error, recordError], '回收中断，无法保存错误记录。'); }
        throw new Error(message, { cause: error });
      }
      throw error;
    } finally { this.removals.delete(resource); }
  }

  private async assertMerged(operation: WorktreeOperation, head: string): Promise<void> {
    try { await git(operation.repoRoot, ['merge-base', '--is-ancestor', head, 'HEAD']); }
    catch { throw new Error('工作区有尚未合入来源仓库的提交，保留目录和分支。'); }
  }

  private async removeBranch(operation: WorktreeOperation): Promise<void> {
    if (!operation.cleanupHeadSha) throw new Error('回收记录缺少待删除提交，保留分支。');
    let head: string | undefined;
    try { head = await git(operation.repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${operation.branch}`]); }
    catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
    if (head !== undefined) {
      if (head !== operation.cleanupHeadSha) throw new Error('工作区分支已指向其他提交，保留分支。');
      await this.assertMerged(operation, head);
    }
    if (await this.registered(operation)) await git(operation.repoRoot, ['worktree', 'remove', operation.path]);
    if (head !== undefined) await git(operation.repoRoot, ['branch', '-d', operation.branch]);
  }

  private async validateLocation(operation: WorktreeOperation): Promise<boolean> {
    if (operation.ownership !== 'created' || dirname(operation.path) !== await realpath(this.directory)
      || operation.path === operation.repoRoot || contains(operation.path, operation.repoRoot)) throw new Error('工作区归属或目录边界无效。');
    let entry: Awaited<ReturnType<typeof lstat>>;
    try { entry = await lstat(operation.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(operation.path) !== operation.path) throw new Error('工作区实际目录已经变化，保留创建记录。');
    return true;
  }

  private async registered(operation: WorktreeOperation): Promise<boolean> {
    const fields = (await git(operation.repoRoot, ['worktree', 'list', '--porcelain', '-z'])).split(/[\0\n]/);
    return fields.includes(`worktree ${operation.path}`);
  }

  private serialize<T>(repoRoot: string, action: () => Promise<T>): Promise<T> {
    const prior = this.repositories.get(repoRoot) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(action);
    this.repositories.set(repoRoot, next);
    void next.finally(() => { if (this.repositories.get(repoRoot) === next) this.repositories.delete(repoRoot); }).catch(() => {});
    return next;
  }
}
