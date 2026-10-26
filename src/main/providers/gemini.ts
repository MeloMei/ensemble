import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { McpServerConfig } from '../../shared/types';
import { isIssuedWorkbenchMcpServer, waitForWorkbenchMcpReady } from '../collaboration-server';
import { WORKBENCH_MCP_TOOLS } from './mcp-configuration';
import type { AcpRuntimeDescriptor } from './acp-types';

const execute = promisify(execFile);

export async function resolveGeminiBinary(): Promise<string | undefined> {
  const name = process.platform === 'win32' ? 'gemini.cmd' : 'gemini';
  const nvmRoot = join(homedir(), '.nvm', 'versions', 'node');
  const versions = await readdir(nvmRoot).catch(() => [] as string[]);
  const candidates = [process.env.GEMINI_BINARY,
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, name)),
    join(homedir(), '.local', 'bin', name), join('/opt/homebrew/bin', name), join('/usr/local/bin', name),
    ...versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(version => join(nvmRoot, version, 'bin', name))];
  for (const candidate of new Set(candidates)) {
    if (!candidate) continue;
    try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return candidate; }
    catch { /* Try another installed entry. */ }
  }
  return undefined;
}

function systemPoliciesDirectory(): string {
  const directory = process.platform === 'darwin' ? '/Library/Application Support/GeminiCli'
    : process.platform === 'win32' ? 'C:\\ProgramData\\gemini-cli' : '/etc/gemini-cli';
  return join(directory, 'policies');
}

async function requireSupplementalPolicy(directory: string): Promise<void> {
  let entries: string[];
  try { entries = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (entries.some(entry => entry.endsWith('.toml'))) throw new Error('Gemini 已配置系统策略，会忽略临时工具守卫；无法验证 Ensemble 权限，任务未启动。');
}

export function geminiToolPolicy(servers: McpServerConfig[]): string {
  const rule = (toolName: string | string[], decision: string, priority: number) => [
    '[[rule]]', `toolName = ${JSON.stringify(toolName)}`,
    `decision = ${JSON.stringify(decision)}`, `priority = ${priority}`, '',
  ].join('\n');
  const issued = servers.some(isIssuedWorkbenchMcpServer);
  return [rule('*', 'ask_user', 998), ...(issued ? [rule(WORKBENCH_MCP_TOOLS.map(tool => geminiMcpToolName('workbench', tool)), 'allow', 999)] : [])].join('\n');
}

export function geminiMcpToolName(serverName: string, toolName: string): string {
  const name = `${serverName}_${toolName}`;
  const prefixed = (name.startsWith('mcp_') ? name : `mcp_${name}`).replace(/[^a-zA-Z0-9_\-.:]/g, '_');
  return prefixed.length > 63 ? `${prefixed.slice(0, 30)}...${prefixed.slice(-30)}` : prefixed;
}

function requireUnambiguousMcpNames(servers: McpServerConfig[]): void {
  const privileged = WORKBENCH_MCP_TOOLS.map(tool => geminiMcpToolName('workbench', tool));
  for (const server of servers) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(server.name)) throw new Error(`Gemini MCP 服务名称无效：${server.name}`);
    if (isIssuedWorkbenchMcpServer(server)) continue;
    const prefix = geminiMcpToolName(server.name, '');
    if (privileged.some(name => name.startsWith(prefix))) throw new Error(`Gemini MCP 服务名称与协作工具冲突：${server.name}`);
  }
}

export async function createGeminiDescriptor(options: {
  dataPath: string;
  binary?: string;
  systemPoliciesPath?: string;
}): Promise<AcpRuntimeDescriptor> {
  const command = options.binary ?? await resolveGeminiBinary();
  if (!command) throw new Error('没有找到 Gemini CLI。请安装官方 Gemini CLI 后刷新，或设置 GEMINI_BINARY。');
  const env = { ...process.env, PATH: `${dirname(command)}${delimiter}${process.env.PATH ?? ''}` };
  const [versionResult, help] = await Promise.all([
    execute(command, ['--version'], { timeout: 10_000, maxBuffer: 16_384, env }),
    execute(command, ['--help'], { timeout: 10_000, maxBuffer: 128_000, env }),
  ]);
  const version = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.exec(versionResult.stdout.trim())?.[0];
  if (!version) throw new Error('Gemini CLI 未返回有效版本号。');
  if (!['--acp', '--admin-policy', '--approval-mode', '--allowed-mcp-server-names', '--skip-trust'].every(flag => help.stdout.includes(flag))) throw new Error('当前 Gemini CLI 缺少 ACP 或临时策略接口，请更新官方 CLI。');
  const policies = options.systemPoliciesPath ?? systemPoliciesDirectory();
  return {
    id: 'gemini', name: 'Gemini CLI', version, detail: `${version} · ${command}`,
    models: undefined, defaultModelId: undefined,
    tracksDelivery: true,
    usageScope: 'turn',
    sessionModes: { review: 'default', 'read-only': 'plan' },
    permissionDecision(tool, session) {
      if (tool.kind === 'read' || tool.kind === 'search') return 'allow';
      return session.settings?.permission === 'read-only' ? 'deny' : 'ask';
    },
    selectModel(choices, modelId) {
      const choice = choices.find(item => item.value === modelId);
      if (!choice) throw new Error('Gemini 原生目录未提供所选模型，任务未发送。');
      return choice;
    },
    async launch(session, servers = []) {
      await requireSupplementalPolicy(policies);
      requireUnambiguousMcpNames(servers);
      const directory = await mkdtemp(join(tmpdir(), 'ensemble-gemini-'));
      const policyPath = join(directory, 'tools.toml');
      const cleanup = () => rm(directory, { recursive: true, force: true });
      try { await writeFile(policyPath, geminiToolPolicy(servers), { flag: 'wx', mode: 0o600 }); }
      catch (error) { await cleanup(); throw error; }
      return { command, args: ['--acp', '--admin-policy', policyPath, '--approval-mode', session.settings?.permission === 'read-only' ? 'plan' : 'default', '--extensions', 'none',
        '--skip-trust', '--allowed-mcp-server-names', servers.map(server => server.name).join(',') || `ensemble-none-${randomUUID()}`],
        env: { ...env, ELECTRON_RUN_AS_NODE: '1', GEMINI_TELEMETRY_ENABLED: 'false' }, mcpServers: servers,
        async waitUntilReady(signal) { await Promise.all(servers.filter(isIssuedWorkbenchMcpServer).map(server => waitForWorkbenchMcpReady(server, signal))); }, cleanup };
    },
  };
}
