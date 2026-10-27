import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gte, valid } from 'semver';
import type { ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { McpServerConfig, Session } from '../../shared/types';
import { isIssuedWorkbenchMcpServer, waitForWorkbenchMcpReady } from '../collaboration-server';
import { claudeMcpConfiguration, WORKBENCH_MCP_TOOLS } from './mcp-configuration';
import type { AcpRuntimeDescriptor } from './acp-types';

const execute = promisify(execFile);
const MINIMUM_VERSION = '1.1.79';
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'AskUserQuestion', 'TodoWrite'];
const REVIEW_TOOLS = [...READ_TOOLS, 'Bash', 'PowerShell', 'BashInput', 'BashOutput', 'Write', 'Edit', 'NotebookEdit', 'WebSearch', 'WebFetch'];
const READABLE = new Set(READ_TOOLS);

export async function resolveQoderBinary(): Promise<string | undefined> {
  const names = process.platform === 'win32' ? ['qoder.exe', 'qoder.cmd', 'qodercli.cmd'] : ['qoder', 'qodercli'];
  const nvmRoot = join(homedir(), '.nvm', 'versions', 'node');
  const versions = await readdir(nvmRoot).catch(() => [] as string[]);
  const directories = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), join(homedir(), '.local', 'bin'),
    join(homedir(), '.qoder', 'bin'), '/opt/homebrew/bin', '/usr/local/bin',
    ...versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(version => join(nvmRoot, version, 'bin'))];
  for (const candidate of new Set([process.env.QODER_BINARY, ...directories.flatMap(directory => names.map(name => join(directory, name)))])) {
    if (!candidate) continue;
    try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return candidate; }
    catch { /* Try another installed entry. */ }
  }
  return undefined;
}

function nativeToolName(tool: ToolCallUpdate): string | undefined {
  const qoder = tool._meta?.qoder;
  if (!qoder || typeof qoder !== 'object' || Array.isArray(qoder)) return;
  const name = (qoder as Record<string, unknown>).toolName;
  return typeof name === 'string' ? name : undefined;
}

export function qoderPermissionDecision(tool: ToolCallUpdate, session: Session, servers: McpServerConfig[]): 'allow' | 'deny' | 'ask' {
  const name = nativeToolName(tool);
  if (!name) return 'deny';
  if (name.startsWith('mcp__')) {
    if (servers.some(isIssuedWorkbenchMcpServer) && WORKBENCH_MCP_TOOLS.some(tool => name === `mcp__workbench__${tool}`)) return 'allow';
    return session.settings?.permission === 'read-only' ? 'deny' : 'ask';
  }
  if (READABLE.has(name)) return 'allow';
  if (session.settings?.permission === 'read-only') return 'deny';
  return REVIEW_TOOLS.includes(name) ? 'ask' : 'deny';
}

function requireUnambiguousMcpNames(servers: McpServerConfig[]): void {
  const names = new Set<string>();
  for (const server of servers) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(server.name)) throw new Error(`Qoder MCP 服务名称无效：${server.name}`);
    const name = server.name.replace(/_+/g, '_').replace(/^_|_$/g, '').toLowerCase();
    if (!name || names.has(name)) throw new Error(`Qoder MCP 服务名称重复：${server.name}`);
    if (name === 'workbench' && !isIssuedWorkbenchMcpServer(server)) throw new Error('Qoder MCP 服务冒用了本轮 Ensemble 协作名称。');
    names.add(name);
  }
}

export async function createQoderDescriptor(options: { binary?: string } = {}): Promise<AcpRuntimeDescriptor> {
  const command = options.binary ?? await resolveQoderBinary();
  if (!command) throw new Error('没有找到 Qoder CLI。请安装官方 CLI 后刷新，或设置 QODER_BINARY。');
  const env = { ...process.env, PATH: `${dirname(command)}${delimiter}${process.env.PATH ?? ''}` };
  const [versionResult, help] = await Promise.all([
    execute(command, ['--version'], { timeout: 10_000, maxBuffer: 16_384, env }),
    execute(command, ['--help'], { timeout: 10_000, maxBuffer: 128_000, env }),
  ]);
  const version = valid(versionResult.stdout.trim());
  if (!version || !gte(version, MINIMUM_VERSION)) throw new Error(`需要 Qoder CLI ${MINIMUM_VERSION} 或更新版本。`);
  if (!['--permission-mode', '--settings', '--setting-sources', '--strict-mcp-config', '--mcp-config', '--allowed-mcp-server-names', '--tools'].every(flag => help.stdout.includes(flag))) {
    throw new Error('当前 Qoder CLI 缺少受控 ACP 接入所需的配置接口，请更新官方 CLI。');
  }
  return {
    id: 'qoder', name: 'Qoder CLI', version, detail: `${version} · ${command}`,
    tracksDelivery: true, usageScope: 'turn', sessionModes: { review: 'default', 'read-only': 'default' },
    permissionDecision: qoderPermissionDecision,
    selectModel(choices, modelId) {
      const selected = choices.find(choice => choice.value === modelId);
      if (!selected) throw new Error('Qoder 原生目录未提供所选模型，任务未发送。');
      return selected;
    },
    async launch(session, servers = []) {
      requireUnambiguousMcpNames(servers);
      const directory = await mkdtemp(join(tmpdir(), 'ensemble-qoder-'));
      const settingsPath = join(directory, 'settings.json');
      const mcpPath = join(directory, 'mcp.json');
      const cleanup = () => rm(directory, { recursive: true, force: true });
      try {
        await Promise.all([
          writeFile(settingsPath, JSON.stringify({ general: { enableAutoUpdate: false }, plugins: { autoUpdate: false },
            disableAllHooks: true, skills: { enabled: false, loadFromAgentsDirectory: false },
            security: { disableYoloMode: true }, mcp: { lazyLoad: false }, permissions: { ask: ['*'] } }), { mode: 0o600, flag: 'wx' }),
          writeFile(mcpPath, JSON.stringify(claudeMcpConfiguration(servers)), { mode: 0o600, flag: 'wx' }),
        ]);
      } catch (error) { await cleanup(); throw error; }
      const tools = session.settings?.permission === 'read-only' ? READ_TOOLS : REVIEW_TOOLS;
      return { command, args: ['--acp', '--permission-mode', 'default', '--setting-sources=user', '--settings', settingsPath,
        '--strict-mcp-config', '--mcp-config', mcpPath, '--allowed-mcp-server-names', servers.map(server => server.name).join(',') || `ensemble-none-${randomUUID()}`,
        '--tools', tools.join(',')],
        env: { ...env, ELECTRON_RUN_AS_NODE: '1', QODER_MCP_LAZY: '0' }, mcpServers: servers,
        async waitUntilReady(signal) { await Promise.all(servers.filter(isIssuedWorkbenchMcpServer).map(server => waitForWorkbenchMcpReady(server, signal))); }, cleanup };
    },
  };
}
