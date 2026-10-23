import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createNdjsonDecoder } from './ndjson';
import { signalProcessTree } from './process-tree';
import { randomUUID } from 'node:crypto';
import { diagnosticScope } from '../diagnostics';

export type RpcId = string | number;
export interface RpcNotification { method: string; params?: unknown }
export interface RpcRequest extends RpcNotification { id: RpcId }
export interface RpcExit { code: number | null; signal: NodeJS.Signals | null; error?: Error; stderr: string }

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  dispose(): void;
}

export class RpcError extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: unknown) {
    super(message);
    this.name = 'RpcError';
  }
}

export function abortError(): Error {
  const error = new Error('任务已取消');
  error.name = 'AbortError';
  return error;
}

export interface JsonRpcOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onNotification?(message: RpcNotification): void;
  onRequest?(message: RpcRequest): Promise<unknown>;
  onRequestError?(error: Error, message: RpcRequest): void;
}

export class JsonRpcProcess {
  private readonly diagnosticOwner = diagnosticScope();
  private readonly diagnosticRuntimeId = randomUUID();
  readonly closed: Promise<RpcExit>;
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly inbound = new Set<RpcId>();
  private nextId = 1;
  private stderr = '';
  private terminalError?: Error;
  private exit?: RpcExit;
  private closing?: Promise<void>;
  private exitDrainTimer?: ReturnType<typeof setTimeout>;
  private resolveClosed!: (exit: RpcExit) => void;

  constructor(private readonly options: JsonRpcOptions) {
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.process = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const decoder = createNdjsonDecoder(message => this.receive(message), 16 * 1024 * 1024);
    this.process.stderr.setEncoding('utf8');
    this.process.stdout.on('data', (chunk: Buffer) => {
      if (this.terminalError) return;
      try { decoder.feed(chunk); } catch (error) { this.diagnosticFailure('decode.failed'); this.fail(asError(error)); }
    });
    this.process.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-16_384); });
    this.process.stdout.on('error', error => this.fail(error));
    this.process.stderr.on('error', error => this.fail(error));
    this.process.stdin.on('error', error => this.fail(error));
    this.process.on('error', error => this.fail(error));
    this.process.on('exit', () => {
      this.exitDrainTimer = setTimeout(() => this.fail(new Error('Agent 进程已退出，但子进程仍占用输出连接')), 1_000);
    });
    this.process.on('close', (code, signal) => {
      clearTimeout(this.exitDrainTimer);
      if (!this.terminalError) {
        try { decoder.end(); } catch (error) { this.terminalError = asError(error); }
      }
      this.exit = { code, signal, error: this.terminalError, stderr: this.stderr };
      this.rejectPending(this.terminalError ?? new Error(`Agent 连接已关闭（退出码 ${code ?? signal ?? 'unknown'}）`));
      this.resolveClosed(this.exit);
    });
  }

  request<T = unknown>(method: string, params?: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(abortError());
    if (this.terminalError || this.exit || this.closing) return Promise.reject(this.terminalError ?? new Error('Agent 连接已关闭'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const finish = (error: Error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.dispose();
        reject(error);
      };
      const timer = setTimeout(() => { this.diagnosticFailure('request.timeout', String(id), method); finish(new Error(`Agent 请求超时：${method}`)); }, options.timeoutMs ?? 30_000);
      const onAbort = () => finish(abortError());
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        dispose: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
        },
      });
      try { this.write({ id, method, ...(params === undefined ? {} : { params }) }); }
      catch (error) { finish(asError(error)); }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  close(): Promise<void> {
    if (!this.closing) this.closing = this.stop();
    return this.closing;
  }

  private async stop(): Promise<void> {
    try {
      if (!this.exit) {
        this.process.stdin.end();
        if (!await this.waitForExit(1_500)) {
          signalProcessTree(this.process, 'SIGTERM');
          if (!await this.waitForExit(1_500)) {
            signalProcessTree(this.process, 'SIGKILL');
            if (!await this.waitForExit(1_500)) throw new Error('Agent 进程未能关闭');
          }
        }
      }
    } finally {
      signalProcessTree(this.process, 'SIGKILL');
      this.rejectPending(this.terminalError ?? new Error('Agent 连接已关闭'));
    }
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.closed.then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  private write(message: unknown): void {
    if (this.exit || this.terminalError || this.process.stdin.destroyed || this.process.stdin.writableEnded) {
      throw this.terminalError ?? new Error('Agent 连接已关闭');
    }
    const current = diagnosticScope();
    const owner = current?.context.sessionId === this.diagnosticOwner?.context.sessionId ? current : this.diagnosticOwner;
    owner?.journal.native(owner.context, 'send', this.diagnosticRuntimeId, message);
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(value: unknown): void {
    if (this.diagnosticOwner) this.diagnosticOwner.journal.native({ ...this.diagnosticOwner.context, attemptId: undefined, turnId: undefined }, 'receive', this.diagnosticRuntimeId, value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Agent 返回了无效的 JSON-RPC 消息');
    const message = value as Record<string, unknown>;
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        if (typeof message.id !== 'string' && typeof message.id !== 'number') throw new Error('Agent 请求缺少有效 id');
        const request: RpcRequest = { id: message.id, method: message.method, params: message.params };
        if (this.inbound.has(request.id)) throw new Error(`Agent 重复发送请求 id：${request.id}`);
        this.inbound.add(request.id);
        void this.handleRequest(request);
      } else this.options.onNotification?.({ method: message.method, params: message.params });
      return;
    }
    const id = message.id;
    if (typeof id !== 'string' && typeof id !== 'number') throw new Error('Agent 响应缺少有效 id');
    const pending = this.pending.get(id);
    // An interrupted request can still produce a late response.
    if (!pending) return;
    this.pending.delete(id);
    pending.dispose();
    if (message.error && typeof message.error === 'object') {
      const error = message.error as Record<string, unknown>;
      pending.reject(new RpcError(typeof error.code === 'number' ? error.code : -32603,
        typeof error.message === 'string' ? error.message : 'Agent 请求失败', error.data));
    } else if ('result' in message) pending.resolve(message.result);
    else pending.reject(new Error('Agent 响应缺少 result 或 error'));
  }

  private async handleRequest(message: RpcRequest): Promise<void> {
    try {
      if (!this.options.onRequest) throw new RpcError(-32601, `客户端未实现：${message.method}`);
      const result = await this.options.onRequest(message);
      this.write({ id: message.id, result: result ?? null });
    } catch (value) {
      const error = asError(value);
      try {
        this.write({ id: message.id, error: {
          code: error instanceof RpcError ? error.code : -32603,
          message: error.message,
          ...(error instanceof RpcError && error.data !== undefined ? { data: error.data } : {}),
        } });
      } catch { /* The child may have exited while the user was deciding. */ }
      this.options.onRequestError?.(error, message);
    } finally { this.inbound.delete(message.id); }
  }

  private fail(error: Error): void {
    if (this.terminalError || this.exit) return;
    this.diagnosticFailure('rpc.failed');
    this.terminalError = error;
    this.rejectPending(error);
    try { signalProcessTree(this.process, 'SIGTERM'); } catch { this.process.kill('SIGTERM'); }
    void this.close().catch(() => {});
  }

  private diagnosticFailure(kind: string, requestId?: string, method?: string): void {
    const owner = this.diagnosticOwner;
    if (!owner) return;
    owner.journal.record({ providerId: owner.context.providerId, sessionId: owner.context.sessionId,
      layer: 'provider', kind, runtimeId: this.diagnosticRuntimeId, requestId, method });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { pending.dispose(); pending.reject(error); }
    this.pending.clear();
  }
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
