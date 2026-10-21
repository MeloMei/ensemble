import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { CollaborationCaller, McpServerConfig } from '../shared/types';

type Call = (caller: CollaborationCaller, tool: string, input: unknown) => Promise<unknown>;
const issuedConfigurations = new WeakMap<object, string>();

export function isIssuedWorkbenchMcpServer(config: McpServerConfig): boolean {
  return config.name === 'workbench' && config.type === 'stdio'
    && config.env?.ELECTRON_RUN_AS_NODE === '1'
    && /^http:\/\/127\.0\.0\.1:\d+\/call$/.test(config.env?.WORKBENCH_TOOL_ENDPOINT ?? '')
    && /^[a-f0-9]{64}$/.test(config.env?.WORKBENCH_TOOL_CAPABILITY ?? '')
    && issuedConfigurations.get(config) === JSON.stringify(config);
}

export class CollaborationServer {
  private server?: Server;
  private address = '';
  private identities = new Map<string, CollaborationCaller>();
  private configurations = new Set<McpServerConfig>();

  constructor(private call: Call, private command: string, private bridgePath: string) {}

  async start(): Promise<void> {
    this.server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      const token = request.headers.authorization?.replace(/^Bearer /, '');
      const caller = token && this.identities.get(token);
      if (!caller || request.method !== 'POST' || request.url !== '/call' || request.headers.origin) {
        response.writeHead(403).end(JSON.stringify({ error: 'Invalid capability' })); return;
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
        const result = await this.call(caller, input.tool, input.input);
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
    this.identities.set(token, caller);
    const config: McpServerConfig = { name: 'workbench', type: 'stdio', command: this.command, args: [this.bridgePath],
      env: { ELECTRON_RUN_AS_NODE: '1', WORKBENCH_TOOL_ENDPOINT: this.address, WORKBENCH_TOOL_CAPABILITY: token } };
    this.configurations.add(config);
    issuedConfigurations.set(config, JSON.stringify(config));
    return {
      config,
      cleanup: async () => { this.identities.delete(token); this.configurations.delete(config); issuedConfigurations.delete(config); },
    };
  }

  async close(): Promise<void> {
    this.identities.clear();
    for (const config of this.configurations) issuedConfigurations.delete(config);
    this.configurations.clear();
    this.address = '';
    this.server?.closeAllConnections();
    if (this.server) await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve()));
    this.server = undefined;
  }
}
