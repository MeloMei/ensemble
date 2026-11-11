import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import type { AcpRuntimeDescriptor } from './acp-types';
import { SESSION_PERMISSION_TIERS } from '../../shared/session-permissions';

const execute = promisify(execFile);
const FLASH_MODEL_ID = 'flash';
const permissionPresets = {
  review: { sandbox: 'workspace-write', approval: 'ask' },
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'full-access': { sandbox: 'danger-full-access', approval: 'never' },
} as const;

function permissionGuard(input: { sandbox: string; approval: string; cwd: string; externalId?: string; readyPath: string }): string {
  return `import { realpathSync, writeFileSync } from 'node:fs';
const config = ${JSON.stringify(input)};

export default function ensemblePermission(ctx) {
  let ready = false;
  ctx.on('agent/created', ({ agent, source }) => {
    if (ready || (source !== 'startup' && source !== 'resume')) return;
    const session = agent.session;
    if (config.externalId ? session.id !== config.externalId : source !== 'startup') return;
    if (realpathSync(session.header.cwd) !== config.cwd) return;
    const presets = ctx.get('permissionPresets');
    const sandbox = ctx.get('sandboxPolicy');
    const preset = presets?.resolve(config.sandbox);
    if (preset?.sandbox !== config.sandbox || preset.approval !== config.approval || !sandbox) {
      throw new Error('Ensemble could not verify the DeepSeek permission preset.');
    }
    presets.set(session, config.sandbox);
    if (presets.current(session) !== config.sandbox || sandbox.resolve({ session }).mode !== config.sandbox) {
      throw new Error('DeepSeek did not apply the selected Ensemble permission preset.');
    }
    writeFileSync(config.readyPath, JSON.stringify({ sessionId: session.id, sandbox: config.sandbox, approval: config.approval }), { flag: 'wx', mode: 0o600 });
    ready = true;
  });
}
`;
}

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
    '- insert:',
    '    - id: ensemble-permission',
    '      name: ./permission.mjs',
    '',
  ].join('\n');
  return {
    id: 'deepseek-harness', name: 'DeepSeek Harness', version,
    detail: `${version} · ${command} · Flash · 每次模型请求最多 ${maxTokens} 输出 tokens`,
    detailI18n: { key: 'runtime:detection.deepSeek', values: { version, command, maxTokens } },
    models: [{ id: FLASH_MODEL_ID, name: 'DeepSeek Flash', free: false }],
    defaultModelId: FLASH_MODEL_ID,
    reasoningPreference: ['off', 'low'],
    permissionTiers: SESSION_PERMISSION_TIERS,
    permissionDecision: (_tool, session) => session.settings?.permission === 'read-only' ? 'deny' : 'ask',
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
    async launch(session) {
      const environment = await deepSeekChildEnvironment(process.env);
      const preset = permissionPresets[session.settings?.permission ?? 'review'];
      const cwd = await realpath(session.cwd);
      const root = join(options.dataPath, 'deepseek-harness');
      await mkdir(root, { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(join(root, 'runtime-'));
      const path = join(directory, 'runtime.patch.yml');
      const readyPath = join(directory, 'permission-ready.json');
      const cleanup = () => rm(directory, { recursive: true, force: true });
      try {
        await writeFile(path, overlay, { mode: 0o600, flag: 'wx' });
        await writeFile(join(directory, 'permission.mjs'), permissionGuard({ ...preset, cwd, externalId: session.externalId, readyPath }), { mode: 0o600, flag: 'wx' });
      }
      catch (error) { await cleanup(); throw error; }
      return {
        command,
        args: ['--profile', 'acp', '--patch', path],
        env: { ...environment, DSH_PERMISSION_MODE: preset.sandbox, DSH_TELEMETRY_DISABLED: '1' },
        async waitUntilReady(signal, nativeSessionId) {
          signal.throwIfAborted();
          const ready = await readFile(readyPath, 'utf8').catch(() => undefined);
          signal.throwIfAborted();
          if (ready !== JSON.stringify({ sessionId: nativeSessionId, ...preset })) {
            throw new Error('DeepSeek Harness 未确认所选会话权限，任务未发送。请检查 CLI 版本及 ACP 配置。');
          }
        },
        cleanup,
      };
    },
  };
}
