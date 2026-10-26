import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createNdjsonDecoder } from './ndjson';
import { signalProcessTree } from './process-tree';
import { abortError, asError } from './json-rpc';

export type PiRecord = Record<string, unknown>;

export class PiCommandError extends Error {
  constructor(readonly command: string, message: string) { super(message); this.name = 'PiCommandError'; }
}

export class PiRpcProcess {
  readonly closed: Promise<void>;
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { command: string; resolve(value: PiRecord): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private stderr = '';
  private failure?: Error;
  private exited = false;
  private stopping = false;
  private abort = new AbortController();
  private resolveClosed!: () => void;
  private exitDrainTimer?: ReturnType<typeof setTimeout>;

  constructor(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; onEvent?(event: PiRecord): void; onFailure?(error: Error): void }) {
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      detached: process.platform !== 'win32', windowsHide: true });
    const fail = (value: unknown) => {
      if (this.failure || this.stopping) return;
      const error = this.failure = asError(value);
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
      this.pending.clear();
      options.onFailure?.(error);
      void this.close();
    };
    const decoder = createNdjsonDecoder(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pi 返回无效 RPC 消息。');
      const event = value as PiRecord;
      if (typeof event.type !== 'string') throw new Error('Pi RPC 消息缺少 type。');
      if (event.type !== 'response') { options.onEvent?.(event); return; }
      const item = this.pending.get(String(event.id));
      if (!item) return;
      this.pending.delete(String(event.id)); clearTimeout(item.timer);
      if (event.command !== item.command) { item.reject(new Error('Pi RPC 响应命令不匹配。')); return; }
      if (event.success !== true) { item.reject(new PiCommandError(item.command, typeof event.error === 'string' ? event.error : `Pi 请求失败：${item.command}`)); return; }
      item.resolve(event.data && typeof event.data === 'object' ? event.data as PiRecord : {});
    }, 16 * 1024 * 1024);
    this.child.stdout.on('data', (chunk: Buffer) => { if (this.failure) return; try { decoder.feed(chunk); } catch (error) { fail(error); } });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-8_192); });
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) stream.on('error', fail);
    this.child.on('error', fail);
    this.child.on('exit', () => { this.exitDrainTimer = setTimeout(() => { fail(new Error('Pi 已退出，但输出连接仍未关闭。')); this.child.stdout.destroy(); this.child.stderr.destroy(); }, 1_000); });
    this.child.on('close', (code, signal) => {
      this.exited = true; clearTimeout(this.exitDrainTimer);
      if (!this.failure) { try { decoder.end(); } catch (error) { fail(error); } }
      if (!this.stopping) fail(new Error(`Pi 连接提前关闭（${code ?? signal ?? 'unknown'}）。${this.stderr}`));
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(this.failure ?? new Error('Pi 连接已关闭。')); }
      this.pending.clear(); this.abort.abort(); this.resolveClosed();
    });
    if (options.signal?.aborted) fail(abortError());
    else options.signal?.addEventListener('abort', () => fail(abortError()), { once: true, signal: this.abort.signal });
  }

  request(command: string, input: PiRecord = {}, timeoutMs = 30_000): Promise<PiRecord> {
    if (this.failure || this.exited || this.stopping) return Promise.reject(this.failure ?? new Error('Pi 连接已关闭。'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Pi 请求超时：${command}`)); }, timeoutMs);
      this.pending.set(id, { command, resolve, reject, timer });
      try { this.send({ ...input, type: command, id }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(asError(error)); }
    });
  }

  send(record: PiRecord): void {
    if (this.exited || this.child.stdin.destroyed || this.child.stdin.writableEnded) throw this.failure ?? new Error('Pi 连接已关闭。');
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  async close(): Promise<void> {
    if (this.stopping) { await this.closed; return; }
    this.stopping = true;
    try {
      if (!this.exited) {
        if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) {
          this.send({ type: 'clear_queue' }); this.send({ type: 'abort' }); this.child.stdin.end();
        }
        // Native MCP transports own detached children and need time to finish their shutdown.
        await this.wait(4_000);
        if (!this.exited) { signalProcessTree(this.child, 'SIGTERM'); await this.wait(4_000); }
        if (!this.exited) { signalProcessTree(this.child, 'SIGKILL'); await this.wait(1_000); }
      }
    } finally {
      signalProcessTree(this.child, 'SIGKILL');
      this.abort.abort();
    }
  }

  private async wait(timeout: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.closed, new Promise<void>(resolve => { timer = setTimeout(resolve, timeout); })]); }
    finally { clearTimeout(timer); }
  }
}
