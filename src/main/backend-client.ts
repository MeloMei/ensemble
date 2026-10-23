import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { BackendEndpoint, BackendReply } from '../shared/backend';
import type { Snapshot } from '../shared/types';

export class BackendClient {
  constructor(readonly endpoint: BackendEndpoint) {}

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

  async subscribe(listener: (snapshot: Snapshot) => void, signal: AbortSignal): Promise<void> {
    const response = await fetch(`${this.endpoint.url}/events`, { headers: { Authorization: `Bearer ${this.endpoint.token}` }, signal });
    if (!response.ok || !response.body) throw new Error('无法订阅后台状态。');
    const decoder = new TextDecoder(); let pending = '';
    const reader = response.body.getReader();
    try { while (true) {
      const { value: bytes, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(bytes, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const event = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        const data = event.split('\n').find(line => line.startsWith('data: '));
        if (data) listener(JSON.parse(data.slice(6)) as Snapshot);
      }
      if (pending.length > 64 * 1024 * 1024) throw new Error('后台状态超过限制。');
    } } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
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
      const health = await response.json() as { instanceId: string; ready: boolean };
      if (!response.ok || !health.ready || health.instanceId !== endpoint.instanceId) return undefined;
      return new BackendClient(endpoint);
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
