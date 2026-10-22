import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import type { AcpRuntimeDescriptor } from './acp-types';

const execute = promisify(execFile);
const FLASH_MODEL_ID = 'flash';

export async function deepSeekChildEnvironment(
  environment: NodeJS.ProcessEnv,
  claudeSettingsPath = join(homedir(), '.claude', 'settings.json'),
): Promise<NodeJS.ProcessEnv> {
  const child = { ...environment };
  if (child.DEEPSEEK_API_KEY?.trim()) return child;
  try {
    const settings: unknown = JSON.parse(await readFile(claudeSettingsPath, 'utf8'));
    if (!settings || typeof settings !== 'object' || !('env' in settings)) return child;
    const configured = settings.env;
    if (!configured || typeof configured !== 'object') return child;
    const values = configured as Record<string, unknown>;
    const baseUrl = values.ANTHROPIC_BASE_URL;
    if (typeof baseUrl !== 'string' || baseUrl.replace(/\/+$/, '') !== 'https://api.deepseek.com/anthropic') return child;
    const token = [values.ANTHROPIC_AUTH_TOKEN, values.ANTHROPIC_API_KEY]
      .find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
    if (token) child.DEEPSEEK_API_KEY = token;
  } catch {
    // Harness can still resolve its own native credential store when this optional source is unavailable.
  }
  return child;
}

export async function resolveDeepSeekHarnessBinary(): Promise<string | null> {
  const name = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
  const candidates = [
    process.env.DSH_BINARY,
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, name)),
    ...['/Applications', join(homedir(), 'Applications')].map(directory =>
      join(directory, 'DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh')),
    join(homedir(), '.local', 'bin', name),
  ];
  for (const candidate of new Set(candidates)) {
    if (!candidate) continue;
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* Continue to another installed CLI location. */ }
  }
  return null;
}

export async function createDeepSeekHarnessDescriptor(options: {
  dataPath: string;
  maxOutputTokens?: number;
}): Promise<AcpRuntimeDescriptor> {
  const maxTokens = options.maxOutputTokens ?? 4096;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('DeepSeek 输出上限必须为正整数');
  const command = await resolveDeepSeekHarnessBinary();
  if (!command) throw new Error('没有找到 DeepSeek Harness CLI，请安装应用或设置 DSH_BINARY');
  const result = await execute(command, ['--version'], { timeout: 5_000, maxBuffer: 16_384 });
  const version = result.stdout.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
  if (!version) throw new Error('DeepSeek Harness CLI 未返回有效版本');
  const overlay = [
    '- id: acp',
    '  config:',
    '    provider: deepseek-official',
    '    model: deepseek-flash',
    '',
    '- id: llm-deepseek',
    '  config:',
    '    baseURL: https://api.deepseek.com/anthropic',
    `    maxTokens: ${maxTokens}`,
    '    reasoningEffort: off',
    '',
  ].join('\n');
  return {
    id: 'deepseek-harness', name: 'DeepSeek Harness', version,
    detail: `${version} · ${command} · Flash · 每次模型请求最多 ${maxTokens} 输出 tokens`,
    detailI18n: { key: 'runtime:detection.deepSeek', values: { version, command, maxTokens } },
    models: [{ id: FLASH_MODEL_ID, name: 'DeepSeek Flash', free: false, efforts: ['off', 'low', 'high', 'max'] }],
    defaultModelId: FLASH_MODEL_ID,
    reasoningPreference: ['off', 'low'],
    efforts: ['off', 'low', 'high', 'max'],
    selectModel(choices, modelId) {
      if (modelId !== FLASH_MODEL_ID) throw new Error('DeepSeek Harness 目前仅支持 Flash 模型');
      const offered = choices.flatMap(choice => {
        let route: unknown;
        try { route = JSON.parse(choice.value); } catch { return []; }
        if (!Array.isArray(route) || route.length !== 2 || route[0] !== 'deepseek-official') return [];
        const model = route[1];
        return model === 'deepseek-flash' || model === 'deepseek-v4-flash' ? [{ choice, model }] : [];
      });
      const flash = offered.find(entry => entry.model === 'deepseek-flash') ?? offered.find(entry => entry.model === 'deepseek-v4-flash');
      if (!flash) throw new Error('DeepSeek Harness 未提供可用的 Flash 模型选项');
      return flash.choice;
    },
    async launch() {
      const environment = await deepSeekChildEnvironment(process.env);
      const root = join(options.dataPath, 'deepseek-harness');
      await mkdir(root, { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(join(root, 'runtime-'));
      const path = join(directory, 'runtime.patch.yml');
      const cleanup = () => rm(directory, { recursive: true, force: true });
      try { await writeFile(path, overlay, { mode: 0o600, flag: 'wx' }); }
      catch (error) { await cleanup(); throw error; }
      return {
        command,
        args: ['--profile', 'acp', '--patch', path],
        env: { ...environment, DSH_PERMISSION_MODE: 'workspace-write', DSH_TELEMETRY_DISABLED: '1' },
        cleanup,
      };
    },
  };
}
