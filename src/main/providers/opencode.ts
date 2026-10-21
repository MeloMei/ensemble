import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { AcpRuntimeDescriptor } from './acp-types';
import type { McpServerConfig } from '../../shared/types';
import { isIssuedWorkbenchMcpServer } from '../collaboration-server';
import { issuedOpenCodeToolActions, openCodeAgentConfiguration } from './opencode-policy';
import { openCodeReadinessPlugin } from './opencode-readiness';

const execute = promisify(execFile);
const CATALOG_URL = 'https://models.opencode.ai/api.json';
const PUBLIC_ENDPOINT = 'https://opencode.ai/inference/openai/v1';
const DEFAULT_MODEL = 'opencode/big-pickle';
const zeroPriceSchema = z.object({
  input: z.literal(0),
  output: z.literal(0),
  cache_read: z.literal(0).optional(),
  cache_write: z.literal(0).optional(),
  tiers: z.array(z.unknown()).optional(),
  tier: z.object({ type: z.literal('context'), size: z.number().int().positive() }).strict().optional(),
}).strict();
const modelSchema = z.object({
  id: z.string().min(1).max(200).regex(/^[a-z0-9][a-z0-9._-]*$/),
  name: z.string().min(1).max(200),
  status: z.enum(['active', 'alpha', 'beta', 'deprecated']).optional(),
  cost: z.unknown(),
  tool_call: z.boolean(),
  modalities: z.object({ input: z.array(z.string()), output: z.array(z.string()) }),
}).passthrough();
const catalogSchema = z.object({
  opencode: z.object({ id: z.literal('opencode'), models: z.record(z.unknown()) }),
});

function isZeroPrice(value: unknown): boolean {
  const price = zeroPriceSchema.safeParse(value);
  return price.success && (price.data.tiers ?? []).every(isZeroPrice);
}

async function resolveBinary(): Promise<{ command: string; version: string }> {
  const name = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const candidates = [
    process.env.OPENCODE_BINARY,
    ...['/Applications', join(homedir(), 'Applications')].map(directory =>
      join(directory, 'OpenCode.app/Contents/Resources/opencode-cli')),
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, name)),
    join(homedir(), '.opencode', 'bin', name),
    join(homedir(), '.local', 'bin', name),
  ];
  const failures: string[] = [];
  for (const command of new Set(candidates)) {
    if (!command) continue;
    try {
      await access(command, constants.X_OK);
      if (!(await stat(command)).isFile()) continue;
    } catch { continue; }
    try {
      const result = await execute(command, ['--version'], { timeout: 5_000, maxBuffer: 16_384 });
      const version = /^opencode\s+v?(2\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/i.exec(result.stdout.trim())?.[1];
      if (version) return { command, version };
      failures.push(`${command}：需要 OpenCode V2`);
    } catch { failures.push(`${command}：版本探测失败`); }
  }
  throw new Error(failures.length ? failures.join('；') : '没有找到 OpenCode V2，请安装 OpenCode 或设置 OPENCODE_BINARY。');
}

async function readFreeCatalog(): Promise<Record<string, z.infer<typeof modelSchema>>> {
  const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!response.ok) throw new Error(`OpenCode 免费模型目录读取失败：HTTP ${response.status}`);
  const catalog = catalogSchema.parse(await response.json());
  const models: Record<string, z.infer<typeof modelSchema>> = {};
  for (const [key, value] of Object.entries(catalog.opencode.models)) {
    const result = modelSchema.safeParse(value);
    if (!result.success) continue;
    const model = result.data;
    if (model.id !== key || model.status === 'deprecated' || !isZeroPrice(model.cost)) continue;
    if (!model.tool_call || !model.modalities.input.includes('text') || !model.modalities.output.includes('text')) continue;
    models[model.id] = model;
  }
  if (!models['big-pickle']) throw new Error('OpenCode 官方目录未确认 Big Pickle 免费，已停止接入，不会切换到收费模型。');
  return models;
}

export function prepareOpenCodeMcp(servers: McpServerConfig[]) {
  const platform = servers.filter(isIssuedWorkbenchMcpServer);
  const mcpServers = servers.filter(server => !platform.includes(server));
  const nativeServers = Object.fromEntries(platform.map(server => {
    if (server.type !== 'stdio') throw new Error('平台 MCP 需要 stdio 连接。');
    return [server.name, { type: 'local', command: [server.command, ...server.args], environment: server.env, codemode: false }];
  }));
  return { mcpServers, nativeServers };
}

function runtimeEnvironment(profile: string, catalogPath: string, nativeServers: Record<string, unknown>, agentConfiguration: Record<string, unknown>, plugins: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowed = new Set(['PATH', 'SHELL', 'LANG', 'TERM', 'COLORTERM', 'TMPDIR', 'USER', 'LOGNAME',
    'SSH_AUTH_SOCK', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']);
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key) || key.startsWith('LC_')) env[key] = value;
  }
  env.PATH ??= '/usr/bin:/bin:/usr/sbin:/sbin';
  return {
    ...env,
    XDG_CONFIG_HOME: join(profile, 'config'),
    XDG_DATA_HOME: join(profile, 'data'),
    XDG_CACHE_HOME: join(profile, 'cache'),
    XDG_STATE_HOME: join(profile, 'state'),
    OPENCODE_CONFIG_DIR: join(profile, 'config', 'opencode'),
    OPENCODE_TEST_HOME: join(profile, 'home'),
    OPENCODE_CONFIG_PROJECT_DISABLE: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_EMBEDDED_WEB_UI: 'true',
    OPENCODE_MODELS_PATH: catalogPath,
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model: DEFAULT_MODEL,
      update: 'disable',
      share: 'disabled',
      warming: false,
      policies: [
        { action: 'provider.use', resource: '*', effect: 'deny' },
        { action: 'provider.use', resource: 'opencode', effect: 'allow' },
      ],
      providers: { opencode: { env: [], settings: { apiKey: 'public', baseURL: PUBLIC_ENDPOINT } } },
      ...(Object.keys(nativeServers).length ? { mcp: { servers: nativeServers } } : {}),
      ...agentConfiguration,
      ...(plugins.length ? { plugins } : {}),
    }),
  };
}

export async function createOpenCodeDescriptor({ dataPath }: { dataPath: string }): Promise<AcpRuntimeDescriptor> {
  const [binary, catalogModels] = await Promise.all([resolveBinary(), readFreeCatalog()]);
  const profile = join(dataPath, 'runtimes', 'opencode-free-v2');
  const catalogPath = join(profile, 'models.json');
  await Promise.all(['config/opencode', 'data', 'cache', 'state', 'home'].map(directory =>
    mkdir(join(profile, directory), { recursive: true })));
  const temporary = join(profile, `models-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ opencode: {
      id: 'opencode', name: 'OpenCode', env: [], npm: '@ai-sdk/openai-compatible',
      api: PUBLIC_ENDPOINT, models: catalogModels,
    } }), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, catalogPath);
  } finally { await rm(temporary, { force: true }); }
  const models = Object.values(catalogModels).map(model => ({ id: `opencode/${model.id}`, name: model.name, free: true }))
    .sort((left, right) => left.id === DEFAULT_MODEL ? -1 : right.id === DEFAULT_MODEL ? 1 : left.name.localeCompare(right.name));
  const allowedModels = new Set(models.map(model => model.id));
  function requireFreeModel(modelId: string): void {
    if (!allowedModels.has(modelId)) throw new Error(`OpenCode 模型 ${modelId} 未确认免费，已停止运行。`);
  }
  return {
    id: 'opencode', name: 'OpenCode', version: binary.version,
    detail: `OpenCode ${binary.version} · ${binary.command} · 仅免费模型，独立数据目录`,
    defaultModelId: DEFAULT_MODEL,
    sessionModes: { review: 'build', 'read-only': 'plan' },
    models,
    async launch(session, servers = []) {
      requireFreeModel(session.modelId ?? DEFAULT_MODEL);
      const { mcpServers, nativeServers } = prepareOpenCodeMcp(servers);
      const toolIds = issuedOpenCodeToolActions(servers);
      const pluginDirectory = toolIds.length ? join(profile, `mcp-ready-${randomUUID()}`) : undefined;
      try {
        if (pluginDirectory) {
          await mkdir(pluginDirectory, { mode: 0o700 });
          await writeFile(join(pluginDirectory, 'package.json'), JSON.stringify({ name: 'workbench-mcp-ready', type: 'module', exports: { '.': './index.js' } }), { mode: 0o600 });
          await writeFile(join(pluginDirectory, 'index.js'), openCodeReadinessPlugin(toolIds), { mode: 0o600 });
        }
        return { command: binary.command, args: ['acp'], env: runtimeEnvironment(profile, catalogPath, nativeServers, openCodeAgentConfiguration(session, servers), pluginDirectory ? [pluginDirectory] : []), mcpServers,
          ...(pluginDirectory ? { cleanup: () => rm(pluginDirectory, { recursive: true, force: true }) } : {}) };
      } catch (error) {
        if (pluginDirectory) await rm(pluginDirectory, { recursive: true, force: true });
        throw error;
      }
    },
    selectModel(choices, modelId) {
      requireFreeModel(modelId);
      const choice = choices.find(item => item.value === modelId);
      if (!choice) throw new Error(`当前 OpenCode ACP 未提供 ${modelId}，已停止运行，不会切换模型。`);
      return choice;
    },
  };
}
