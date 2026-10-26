import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { dirname, join } from 'node:path';
import { createWorkbenchMcpServer } from './mcp-server';
import { connectBackend } from './backend-client';

async function main(): Promise<void> {
  const endpoint = process.env.WORKBENCH_TOOL_ENDPOINT;
  const capability = process.env.WORKBENCH_TOOL_CAPABILITY;
  const readyEndpoint = process.env.WORKBENCH_TOOL_READY_ENDPOINT;
  const identityToken = process.env.WORKBENCH_IDENTITY_TOKEN;
  delete process.env.WORKBENCH_TOOL_CAPABILITY;
  delete process.env.WORKBENCH_TOOL_READY_ENDPOINT;
  delete process.env.WORKBENCH_IDENTITY_TOKEN;
  let remote: Client | undefined;
  let invoke: (tool: string, input: Record<string, unknown>) => Promise<unknown>;
  let reportReady: (() => Promise<void>) | undefined;

  if (endpoint && capability) {
    if (!/^http:\/\/127\.0\.0\.1:\d+\/call$/.test(endpoint)) throw new Error('协作回合地址无效。');
    if (readyEndpoint) {
      if (readyEndpoint !== endpoint.replace(/\/call$/, '/ready')) throw new Error('协作 MCP 初始化地址无效。');
      reportReady = async () => {
        const response = await fetch(readyEndpoint, { method: 'POST', headers: { Authorization: `Bearer ${capability}` }, signal: AbortSignal.timeout(5_000) });
        if (!response.ok) throw new Error('协作 MCP 初始化身份已失效。');
        await response.body?.cancel();
      };
    }
    invoke = async (tool, input) => {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${capability}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, input }), signal: AbortSignal.timeout(35000),
      });
      const body = await response.json() as { result?: unknown; error?: string };
      if (!response.ok || body.error) throw new Error(body.error ?? '协作回合已经结束。');
      return body.result;
    };
  } else {
    if (!identityToken) throw new Error('缺少协作连接身份。请先签发并配置 MCP 连接。');
    const argument = process.argv.indexOf('--data-dir');
    const dataPath = argument >= 0 ? process.argv[argument + 1] : process.env.WORKBENCH_DATA_DIR;
    if (!dataPath) throw new Error('缺少工作台数据目录。');
    const backend = await connectBackend(dataPath, { command: process.execPath, entryPath: join(dirname(process.argv[1]), 'backend-entry.js') });
    remote = new Client({ name: 'workbench-stdio-bridge', version: '0.5.0' });
    await remote.connect(new StreamableHTTPClientTransport(new URL(`${backend.endpoint.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${identityToken}` } },
    }));
    invoke = async (tool, input) => {
      const result = await remote!.callTool({ name: tool, arguments: input });
      const content = result.content as { type: string; text?: string }[];
      const text = content.filter(item => item.type === 'text').map(item => item.text ?? '').join('\n');
      if (result.isError) throw new Error(text || '协作调用失败。');
      return text ? JSON.parse(text) : null;
    };
  }

  const server = createWorkbenchMcpServer(invoke);
  const stop = (exitCode = 0) => { void Promise.allSettled([server.close(), remote?.close()]).then(() => process.exit(exitCode)); };
  if (reportReady) {
    let reporting: Promise<void> | undefined;
    server.server.oninitialized = () => {
      reporting ??= reportReady!().catch(error => { process.stderr.write(`${String(error)}\n`); stop(1); });
    };
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.stdin.on('end', stop);
  await server.connect(new StdioServerTransport());
}

void main().catch(error => { process.stderr.write(`${String(error)}\n`); process.exit(1); });
