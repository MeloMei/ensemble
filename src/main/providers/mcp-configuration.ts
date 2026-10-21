import type { McpServerConfig } from '../../shared/types';
import { isIssuedWorkbenchMcpServer } from '../collaboration-server';
import { WORKBENCH_MCP_TOOL_NAMES } from '../mcp-tool-catalog';

export const WORKBENCH_MCP_TOOLS = WORKBENCH_MCP_TOOL_NAMES;

export function claudeMcpConfiguration(servers: McpServerConfig[]): { mcpServers: Record<string, unknown> } {
  return { mcpServers: Object.fromEntries(servers.map(server => [server.name, server.type === 'stdio'
    ? { type: 'stdio', command: server.command, args: server.args, ...(server.env ? { env: server.env } : {}) }
    : { type: server.type, url: server.url, ...(server.headers ? { headers: server.headers } : {}) }])) };
}

export function codexMcpConfiguration(servers: McpServerConfig[]): Record<string, unknown> {
  return Object.fromEntries(servers.map(server => {
    if (server.type === 'sse') throw new Error(`Codex 不支持 SSE MCP：${server.name}。请选择 stdio 或 HTTP。`);
    const configuration = server.type === 'stdio'
      ? { command: server.command, args: server.args, ...(server.env ? { env: server.env } : {}), enabled: true }
      : { url: server.url, ...(server.headers ? { http_headers: server.headers } : {}), enabled: true };
    return [server.name, { ...configuration, default_tools_approval_mode: 'prompt', ...(isIssuedWorkbenchMcpServer(server) ? {
      enabled_tools: [...WORKBENCH_MCP_TOOLS], tools: Object.fromEntries(WORKBENCH_MCP_TOOLS.map(tool => [tool, { approval_mode: 'approve' }])),
    } : {}) }];
  }));
}
