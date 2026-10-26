import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { CollaborationCaller, McpServerConfig } from '../shared/types';

type Call = (caller: CollaborationCaller, tool: string, input: unknown) => Promise<unknown>;
interface IssuedCapability {
  caller: CollaborationCaller;
  config: McpServerConfig;
  signature: string;
  ready: boolean;
  waiters: Set<(error?: Error) => void>;
}
const issuedConfigurations = new WeakMap<object, IssuedCapability>();

export function isIssuedWorkbenchMcpServer(config: McpServerConfig): boolean {
  return config.name === 'workbench' && config.type === 'stdio'
    && config.env?.ELECTRON_RUN_AS_NODE === '1'
    && /^http:\/\/127\.0\.0\.1:\d+\/call$/.test(config.env?.WORKBENCH_TOOL_ENDPOINT ?? '')
    && config.env?.WORKBENCH_TOOL_READY_ENDPOINT === config.env?.WORKBENCH_TOOL_ENDPOINT?.replace(/\/call$/, '/ready')
    && /^[a-f0-9]{64}$/.test(config.env?.WORKBENCH_TOOL_CAPABILITY ?? '')
    && issuedConfigurations.get(config)?.signature === JSON.stringify(config);
}

export async function waitForWorkbenchMcpReady(config: McpServerConfig, signal: AbortSignal, timeoutMs = 30_000): Promise<void> {
  if (!isIssuedWorkbenchMcpServer(config)) throw new Error('缺少有效的本轮 Ensemble MCP 初始化身份。');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error('MCP 初始化等待时限无效。');
  const cancelled = () => Object.assign(new Error('Ensemble MCP 初始化等待已取消。'), { name: 'AbortError' });
  if (signal.aborted) throw cancelled();
  const capability = issuedConfigurations.get(config)!;
  if (!capability.ready) await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      capability.waiters.delete(finish);
      if (error) reject(error); else resolve();
    };
    const onAbort = () => finish(cancelled());
    const timer = setTimeout(() => finish(new Error('Ensemble MCP 初始化握手未在时限内完成，任务未发送。')), timeoutMs);
    capability.waiters.add(finish);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  if (!isIssuedWorkbenchMcpServer(config)) throw new Error('本轮 Ensemble MCP 身份已撤销。');
  if (signal.aborted) throw cancelled();
}

export class CollaborationServer {
  private server?: Server;
  private address = '';
  private identities = new Map<string, IssuedCapability>();

  constructor(private call: Call, private command: string, private bridgePath: string) {}

  async start(): Promise<void> {
    this.server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      const token = request.headers.authorization?.replace(/^Bearer /, '');
      const capability = token && this.identities.get(token);
      if (!capability || request.method !== 'POST' || !['/call', '/ready'].includes(request.url ?? '') || request.headers.origin) {
        response.writeHead(403).end(JSON.stringify({ error: 'Invalid capability' })); return;
      }
      if (request.url === '/ready') {
        request.resume();
        capability.ready = true;
        for (const finish of [...capability.waiters]) finish();
        response.end(JSON.stringify({ ready: true }));
        return;
      }
      try {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 256_000) throw new Error('Tool input exceeds limit');
          chunks.push(chunk);
        }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tool?: unknown; input?: unknown };
        if (typeof input.tool !== 'string') throw new Error('Missing tool name');
        const result = await this.call(capability.caller, input.tool, input.input);
        response.end(JSON.stringify({ result }));
      } catch (error) {
        response.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : 'Tool call failed' }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Invalid collaboration listener');
    this.address = `http://127.0.0.1:${address.port}/call`;
  }

  issue(caller: CollaborationCaller): { config: McpServerConfig; cleanup: () => Promise<void> } {
    if (!this.address) throw new Error('Collaboration service is not ready');
    const token = randomBytes(32).toString('hex');
    const config: McpServerConfig = { name: 'workbench', type: 'stdio', command: this.command, args: [this.bridgePath],
      env: { ELECTRON_RUN_AS_NODE: '1', WORKBENCH_TOOL_ENDPOINT: this.address, WORKBENCH_TOOL_READY_ENDPOINT: this.address.replace(/\/call$/, '/ready'), WORKBENCH_TOOL_CAPABILITY: token } };
    const capability: IssuedCapability = { caller, config, signature: JSON.stringify(config), ready: false, waiters: new Set() };
    this.identities.set(token, capability);
    issuedConfigurations.set(config, capability);
    return {
      config,
      cleanup: async () => { this.revoke(token); },
    };
  }

  async close(): Promise<void> {
    for (const token of [...this.identities.keys()]) this.revoke(token);
    this.address = '';
    this.server?.closeAllConnections();
    if (this.server) await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve()));
    this.server = undefined;
  }

  private revoke(token: string): void {
    const capability = this.identities.get(token);
    if (!capability) return;
    this.identities.delete(token);
    issuedConfigurations.delete(capability.config);
    for (const finish of [...capability.waiters]) finish(new Error('本轮 Ensemble MCP 身份已撤销。'));
  }
}
