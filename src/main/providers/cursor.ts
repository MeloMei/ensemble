import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { McpServerConfig, Session } from '../../shared/types';
import { isIssuedWorkbenchMcpServer, waitForWorkbenchMcpReady } from '../collaboration-server';
import type { AcpRuntimeDescriptor } from './acp-types';
import { cursorInteractions } from './cursor-interactions';
import { createCursorGuard } from './cursor-guard';
import { WORKBENCH_MCP_TOOLS } from './mcp-configuration';

const execute = promisify(execFile);
const VERSION = /^(\d{4}\.\d{2}\.\d{2})-[a-f\d]+$/i;
const MINIMUM_VERSION = '2026.10.22';
const READABLE_KINDS = new Set(['read', 'search', 'fetch']);

export async function resolveCursorBinary(binaryOverride = process.env.CURSOR_BINARY): Promise<{ command: string; version: string }> {
  const local = join(homedir(), '.local');
  const versionsRoot = join(local, 'share', 'cursor-agent', 'versions');
  const versions = await readdir(versionsRoot).catch(() => [] as string[]);
  const candidates = [binaryOverride,
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).flatMap(directory => ['agent', 'cursor-agent'].map(name => join(directory, name))),
    join(local, 'bin', 'agent'), join(local, 'bin', 'cursor-agent'),
    ...versions.sort().reverse().map(version => join(versionsRoot, version, 'cursor-agent'))];
  const failures: string[] = [];
  for (const command of new Set(candidates)) {
    if (!command) continue;
    try { await access(command, constants.X_OK); if (!(await stat(command)).isFile()) continue; } catch { continue; }
    try {
      const version = (await execute(command, ['--version'], { timeout: 5_000, maxBuffer: 16_384 })).stdout.trim();
      const match = VERSION.exec(version);
      if (match && match[1] >= MINIMUM_VERSION) return { command, version };
      failures.push(`${command}：需要 Cursor Agent ${MINIMUM_VERSION} 或更新版本`);
    } catch { failures.push(`${command}：版本探测失败`); }
    if (command === binaryOverride) break;
  }
  throw new Error(failures.length ? failures.join('；') : '没有找到 Cursor Agent，请安装官方 CLI 或设置 CURSOR_BINARY。');
}

export function cursorPermissionDecision(tool: ToolCallUpdate, session: Session, servers: McpServerConfig[]): 'allow' | 'deny' | 'ask' {
  const input = tool.rawInput && typeof tool.rawInput === 'object' && !Array.isArray(tool.rawInput) ? tool.rawInput as Record<string, unknown> : {};
  const provider = input.providerIdentifier ?? input.server ?? input.serverName;
  const isMcp = typeof provider === 'string' || typeof tool.name === 'string' && (tool.name.startsWith('mcp__') || tool.name.startsWith('MCP:'));
  if (isMcp) {
    if (provider === 'workbench' && typeof input.toolName === 'string' && WORKBENCH_MCP_TOOLS.includes(input.toolName)
      && servers.some(isIssuedWorkbenchMcpServer)) return 'allow';
    return session.settings?.permission === 'read-only' ? 'deny' : 'ask';
  }
  if (['askQuestion', 'createPlan', 'updateTodos'].includes(String(input._toolName))) return 'allow';
  if (session.settings?.permission === 'read-only' && (typeof input.downloadPath === 'string' || typeof input.targetModeId === 'string')) return 'deny';
  if (tool.kind && READABLE_KINDS.has(tool.kind)) return 'allow';
  if (session.settings?.permission === 'read-only') return 'deny';
  return ['edit', 'delete', 'execute', 'switch_mode'].includes(tool.kind ?? '') || input._toolName === 'task' || tool.name === 'Task' ? 'ask' : 'deny';
}

export async function createCursorDescriptor(options: { dataPath: string; binary?: string }): Promise<AcpRuntimeDescriptor> {
  const binary = await resolveCursorBinary(options.binary);
  const guards = new Map<string, Awaited<ReturnType<typeof createCursorGuard>>>();
  return {
    id: 'cursor', name: 'Cursor Agent', version: binary.version,
    detail: `Cursor Agent ${binary.version} · ${binary.command}`,
    tracksDelivery: true, reportsUsage: false,
    sessionModes: { review: 'agent', 'read-only': 'ask' },
    async launch(session, servers = [], context) {
      if (!context) throw new Error('Cursor 工具审批通道未提供，任务未启动。');
      if (session.id !== context.session.id) throw new Error('Cursor 工具审批通道不属于当前会话。');
      const guard = await createCursorGuard(options.dataPath, context.session, servers, context, cursorPermissionDecision);
      guards.set(session.id, guard);
      return { command: binary.command, args: ['--disable-project-configs', '--plugin-dir', guard.pluginDirectory, 'acp'],
        env: { ...process.env, CURSOR_CONFIG_DIR: guard.configDirectory, PATH: `${dirname(binary.command)}${delimiter}${process.env.PATH ?? ''}` }, mcpServers: servers,
        async waitUntilReady(signal) { await Promise.all(servers.filter(isIssuedWorkbenchMcpServer).map(server => waitForWorkbenchMcpReady(server, signal))); },
        async cleanup() { if (guards.get(session.id) === guard) guards.delete(session.id); await guard.cleanup(); } };
    },
    selectModel(choices, modelId) {
      const selected = choices.find(choice => choice.value === modelId);
      if (!selected) throw new Error('Cursor 原生目录未提供所选模型。');
      return selected;
    },
    permissionDecision: (tool, session, servers) => guards.get(session.id)?.permissionDecision(tool) ?? cursorPermissionDecision(tool, session, servers),
    ...cursorInteractions(),
  };
}
