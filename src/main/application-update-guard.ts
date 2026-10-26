import type { Snapshot } from '../shared/types';

export class ApplicationUpdateGuard {
  private lease?: { token: string; expiresAt: number };
  private calls = 0;

  constructor(private readonly snapshot: () => Snapshot) {}

  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    this.expire();
    if (this.lease) throw new Error('Ensemble 正在安装更新，请稍后重试。');
    this.calls++;
    try { return await operation(); }
    finally { this.calls--; }
  }

  begin(token: string): void {
    this.expire();
    if (this.lease) throw new Error('另一个更新已经开始，请稍后重试。');
    const state = this.snapshot();
    const active = this.calls > 0
      || state.sessions.some(item => ['queued', 'running', 'waiting_approval', 'waiting_children'].includes(item.status) || item.queue?.length)
      || state.workflows.some(item => item.status === 'running')
      || state.terminals.some(item => item.status === 'running')
      || state.collaboration?.runs.some(item => item.status === 'running')
      || state.collaboration?.tasks.some(item => ['queued', 'running', 'waiting'].includes(item.status));
    if (active) throw new Error('请先完成或暂停 Agent 任务、清空待执行队列并停止终端，再安装更新。');
    // The detached installer must stop this backend within 90 seconds. A crashed GUI
    // must not leave a healthy backend permanently unavailable to CLI/MCP clients.
    this.lease = { token, expiresAt: Date.now() + 120_000 };
  }

  cancel(token: string): void { if (this.lease?.token === token) this.lease = undefined; }
  private expire(): void { if (this.lease && this.lease.expiresAt <= Date.now()) this.lease = undefined; }
}
