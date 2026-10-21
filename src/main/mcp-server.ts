import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WORKBENCH_MCP_TOOLS } from './mcp-tool-catalog';
import { PRODUCT_NAME, PRODUCT_VERSION } from '../shared/app-identity';

export function createWorkbenchMcpServer(call: (tool: string, input: Record<string, unknown>) => Promise<unknown>): McpServer {
  const server = new McpServer({ name: 'workbench', title: PRODUCT_NAME, version: PRODUCT_VERSION }, {
    instructions: 'Use the user-configured participants, roles and permissions. Read get_context before submitting work. A received task ID is an acknowledgement, not a completed result. Save run IDs and event cursors; report only recorded results.',
  });
  for (const tool of WORKBENCH_MCP_TOOLS) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, async input => {
      try {
        const result = await call(tool.name, input);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result ?? null) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : '协作调用失败。' }] };
      }
    });
  }
  return server;
}
