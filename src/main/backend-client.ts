import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { BackendConnectionState, BackendEndpoint, BackendReply, BackendStreamError, SnapshotFrame, TerminalOutputEvent } from '../shared/backend';
import { BACKEND_STREAM_VERSION } from '../shared/backend';
import type { Snapshot } from '../shared/types';
import { SnapshotGapError, SnapshotReplica } from '../shared/snapshot-stream';

class BackendProtocolError extends Error {}

export class BackendFrameTooLargeError extends Error {
  readonly code = 'FRAME_TOO_LARGE';
  constructor(readonly limitBytes: number) {
    super(`同步帧超过 ${limitBytes / (1024 * 1024)} MiB 限制。当前保留上次同步内容，请切换会话后重试。`);
  }
}

export class BackendConnectionTracker {
  private generation = 0;
  private state: BackendConnectionState = { status: 'connecting', synced: false };

  constructor(private readonly changed: (state: BackendConnectionState) => void) {}
  get current(): BackendConnectionState { return { ...this.state }; }
  private update(state: BackendConnectionState): void { this.state = state; this.changed(this.current); }
  begin(instanceId: string): number {
    this.generation++;
    this.update({ ...this.state, instanceId, revision: this.state.instanceId === instanceId ? this.state.revision : undefined,
      status: this.state.lastReceivedAt ? 'reconnecting' : 'connecting', synced: false });
    return this.generation;
  }
  accepts(generation: number): boolean { return generation === this.generation; }
  received(generation: number, frame: SnapshotFrame): boolean {
    if (!this.accepts(generation) || frame.instanceId !== this.state.instanceId) return false;
    this.update({ status: 'connected', synced: true, instanceId: frame.instanceId, revision: frame.revision, lastReceivedAt: new Date().toISOString() });
    return true;
  }
  disconnected(generation: number, error?: unknown): void {
    if (!this.accepts(generation)) return;
    this.generation++;
    this.update({ ...this.state, status: 'reconnecting', synced: false, ...(error instanceof Error ? { error: error.message } : {}) });
  }
  stop(): void { this.generation++; this.update({ ...this.state, status: 'stopped', synced: false }); }
}

export class BackendClient {
  private sessions: string[] = [];
  private subscriptionId?: string;
  private subscriptionController?: AbortController;
  private watchUpdates?: Promise<void>;
  private watchRequested = false;
  constructor(readonly endpoint: BackendEndpoint, readonly streamVersion?: number) {}

  assertSnapshotStreaming(): void {
    if (this.streamVersion !== BACKEND_STREAM_VERSION) throw new BackendProtocolError('后台版本与当前客户端不兼容，请结束旧后台后重新启动工作台。');
  }

  async request<T>(path: string, command?: string, args: unknown[] = []): Promise<T> {
    const response = await fetch(`${this.endpoint.url}${path}`, {
      method: command ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${this.endpoint.token}`, ...(command ? { 'Content-Type': 'application/json' } : {}) },
      ...(command ? { body: JSON.stringify({ command, args,
        undefinedArgs: args.flatMap((value, index) => value === undefined ? [index] : []),
      }) } : {}),
    });
    const body = await response.json() as BackendReply<T>;
    if (!response.ok || body.error) throw new Error(body.error ?? `后台返回 ${response.status}`);
    return body.result as T;
  }

  call<T = unknown>(command: string, ...args: unknown[]): Promise<T> { return this.request('/command', command, args); }

  watchSessions(ids: string[]): Promise<void> {
    if (ids.length > 8 || ids.some(id => typeof id !== 'string' || !id || id.length > 200)) return Promise.reject(new Error('会话订阅格式无效。'));
    this.sessions = [...new Set(ids)];
    this.watchRequested = true;
    return this.watchUpdates ??= Promise.resolve().then(() => this.updateWatch());
  }

  private async updateWatch(): Promise<void> {
    let applied: string | undefined;
    try {
      while (this.watchRequested) {
        this.watchRequested = false;
        const subscriptionId = this.subscriptionId;
        if (!subscriptionId) continue;
        const controller = this.subscriptionController;
        const body = JSON.stringify({ subscriptionId, sessionIds: this.sessions });
        if (body === applied) continue;
        try {
          const response = await fetch(`${this.endpoint.url}/watch`, { method: 'POST', headers: {
            Authorization: `Bearer ${this.endpoint.token}`, 'Content-Type': 'application/json',
          }, body, signal: AbortSignal.timeout(5000) });
          if (!response.ok) throw new Error('后台会话订阅已失效。');
          applied = body;
        } catch (error) {
          if (this.subscriptionId !== subscriptionId || this.subscriptionController !== controller) continue;
          controller?.abort(error);
          throw error;
        }
      }
    } finally { this.watchUpdates = undefined; }
  }

  snapshot(): Promise<Snapshot> {
    const query = new URLSearchParams(this.sessions.map(id => ['session', id]));
    return this.request(`/snapshot?${query}`);
  }

  async subscribe(listener: (snapshot: Snapshot, frame: SnapshotFrame) => void, signal: AbortSignal): Promise<void> {
    this.subscriptionController?.abort(new Error('后台状态订阅已替换。'));
    const controller = new AbortController();
    this.subscriptionController = controller;
    this.subscriptionId = undefined;
    const streamSignal = AbortSignal.any([signal, controller.signal]);
    const query = new URLSearchParams(this.sessions.map(id => ['session', id]));
    const initial = JSON.stringify(this.sessions);
    const replica = new SnapshotReplica();
    let subscriptionId: string | undefined;
    let first = true;
    try {
      await this.consume(`/events?${query}`, 'snapshot', async value => {
        const frame = value as SnapshotFrame;
        if (frame.instanceId !== this.endpoint.instanceId) throw new SnapshotGapError();
        const snapshot = replica.apply(frame);
        if (streamSignal.aborted) return;
        if (frame.type === 'reset') {
          subscriptionId = frame.subscriptionId; this.subscriptionId = subscriptionId;
        }
        if (snapshot) listener(snapshot, frame);
        if (first && frame.type === 'reset' && initial !== JSON.stringify(this.sessions) && this.subscriptionId === subscriptionId) {
          first = false;
          await this.watchSessions(this.sessions);
        }
        first = false;
      }, streamSignal);
    } finally {
      if (this.subscriptionController === controller) {
        this.subscriptionController = undefined;
        this.subscriptionId = undefined;
      }
    }
  }

  subscribeTerminal(id: string, listener: (event: TerminalOutputEvent) => void, signal: AbortSignal): Promise<void> {
    let end: number | undefined;
    return this.consume(`/terminal-events?id=${encodeURIComponent(id)}`, 'terminal', value => {
      const event = value as TerminalOutputEvent & { instanceId: string };
      if (event.instanceId !== this.endpoint.instanceId || event.terminalId !== id) throw new Error('后台终端订阅已失效。');
      if (event.type === 'tail') end = event.outputOffset + event.output.length;
      else {
        if (end === undefined || event.offset > end) throw new Error('后台终端输出游标已失效。');
        end = Math.max(end, event.offset + event.data.length);
      }
      listener(event);
    }, signal);
  }

  private async consume(path: string, eventName: string, listener: (value: unknown) => void | Promise<void>, signal: AbortSignal): Promise<void> {
    const idle = new AbortController();
    let idleTimer = setTimeout(() => idle.abort(new Error('后台事件流超过 45 秒没有响应。')), 45000);
    idleTimer.unref();
    let response: Response;
    try { response = await fetch(`${this.endpoint.url}${path}`, { headers: { Authorization: `Bearer ${this.endpoint.token}` }, signal: AbortSignal.any([signal, idle.signal]) }); }
    catch (error) { clearTimeout(idleTimer); throw error; }
    if (!response.ok || !response.body) { clearTimeout(idleTimer); throw new Error('无法订阅后台状态。'); }
    const decoder = new TextDecoder(); let pending = '';
    const reader = response.body.getReader();
    try { while (true) {
      const { value: bytes, done } = await reader.read();
      if (done || signal.aborted) break;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(new Error('后台事件流超过 45 秒没有响应。')), 45000);
      idleTimer.unref();
      pending += decoder.decode(bytes, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const event = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        if (signal.aborted) return;
        const lines = event.split('\n');
        const type = lines.find(line => line.startsWith('event: '))?.slice(7);
        const data = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
        if (type === 'stream-error' && data) {
          const error = JSON.parse(data) as Partial<BackendStreamError> | null;
          if (error?.code === 'FRAME_TOO_LARGE' && typeof error.limitBytes === 'number' && Number.isSafeInteger(error.limitBytes) && error.limitBytes > 0) throw new BackendFrameTooLargeError(error.limitBytes);
          throw new Error('后台状态流已结束。');
        }
        if (type === eventName && data) await listener(JSON.parse(data));
      }
      if (pending.length > 8 * 1024 * 1024) throw new Error('后台状态超过限制。');
    } } finally { clearTimeout(idleTimer); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

export async function connectBackend(dataPath: string, launch?: { command: string; entryPath: string }): Promise<BackendClient> {
  const endpointPath = join(dataPath, 'backend.json');
  const read = async (): Promise<BackendClient | undefined> => {
    try {
      const endpoint = JSON.parse(await readFile(endpointPath, 'utf8')) as BackendEndpoint;
      if (endpoint.stoppedAt) return undefined;
      if (endpoint.version !== 1 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint.url) || !/^[a-f0-9]{64}$/.test(endpoint.token)) throw new Error('后台连接记录无效。');
      const response = await fetch(`${endpoint.url}/health`, { headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(1000) });
      const health = await response.json() as { instanceId: string; ready: boolean; streamVersion?: number };
      if (!response.ok || !health.ready || health.instanceId !== endpoint.instanceId) return undefined;
      return new BackendClient(endpoint, health.streamVersion);
    } catch { return undefined; }
  };
  const existing = await read(); if (existing) return existing;
  if (!launch) throw new Error('后台未运行，请先启动工作台。');
  await mkdir(dataPath, { recursive: true, mode: 0o700 });
  const log = await open(join(dataPath, 'backend.log'), 'a', 0o600);
  const child = spawn(launch.command, [launch.entryPath, '--data-dir', dataPath], {
    detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WORKBENCH_DATA_DIR: dataPath },
  });
  let launchError: Error | undefined;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.once('error', error => { launchError = error; });
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  child.unref(); await log.close();
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    const client = await read(); if (client) return client;
    if (exit && exit.code !== 75) throw new Error(`后台启动失败（${exit.signal ?? exit.code}），请查看 backend.log。`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('后台启动未完成，请查看数据目录中的 backend.log。');
}
