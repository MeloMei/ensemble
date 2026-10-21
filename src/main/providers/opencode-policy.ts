import type { McpServerConfig, Session } from '../../shared/types';
import { isIssuedWorkbenchMcpServer } from '../collaboration-server';
import { WORKBENCH_MCP_TOOLS } from './mcp-configuration';

export const OPENCODE_READ_ONLY_TOOLS = ['read', 'glob', 'grep', 'skill', 'question'] as const;
type Permission = { action: string; resource: string; effect: 'allow' | 'ask' | 'deny' };

export function issuedOpenCodeToolActions(servers: McpServerConfig[]): string[] {
  return servers.filter(isIssuedWorkbenchMcpServer).flatMap(server => WORKBENCH_MCP_TOOLS.map(tool => `${server.name}_${tool}`));
}

export function openCodeReadOnlyPermissions(servers: McpServerConfig[]): Permission[] {
  return [
    { action: '*', resource: '*', effect: 'deny' },
    ...OPENCODE_READ_ONLY_TOOLS.map(action => ({ action, resource: '*', effect: 'allow' as const })),
    { action: 'read', resource: '*.env', effect: 'ask' },
    { action: 'read', resource: '*.env.*', effect: 'ask' },
    { action: 'read', resource: '*.env.example', effect: 'allow' },
    ...issuedOpenCodeToolActions(servers).map(action => ({ action, resource: '*', effect: 'allow' as const })),
  ];
}

export function openCodeAgentConfiguration(session: Session, servers: McpServerConfig[]) {
  if (session.settings?.permission !== 'read-only') return {};
  return { agents: { plan: { permissions: openCodeReadOnlyPermissions(servers) } } };
}
