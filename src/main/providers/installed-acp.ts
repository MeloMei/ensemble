import { randomUUID } from 'node:crypto';
import { constants, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PROTOCOL_VERSION, type AgentCapabilities } from '@agentclientprotocol/sdk';
import { z } from 'zod';
import { createAcpProvider, probeAcp, type AcpProvider } from './acp';
import type { AcpLaunchSpec, AcpRuntimeDescriptor } from './acp-types';

const configuration = z.object({
  name: z.string().trim().min(1).max(100),
  command: z.string().max(4096).refine(value => isAbsolute(value) && !value.includes('\0')),
  args: z.array(z.string().max(4096).refine(value => !value.includes('\0'))).max(64),
  environment: z.array(z.object({ key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), value: z.string().max(4096).refine(value => !value.includes('\0')) }).strict()).max(64),
}).strict().refine(input => new Set(input.environment.map(entry => process.platform === 'win32' ? entry.key.toUpperCase() : entry.key)).size === input.environment.length);
const recordSchema = z.object({
  id: z.string().uuid(), origin: z.literal('custom'), protocolVersion: z.literal(PROTOCOL_VERSION),
  input: configuration, agentCapabilities: z.custom<AgentCapabilities>(value => value !== null && typeof value === 'object' && !Array.isArray(value)),
}).strict();
type InstalledAcp = z.infer<typeof recordSchema>;

const providerId = (id: string) => `acp:${id}`;
const inheritedKeys = ['PATH', 'HOME', 'USERPROFILE', 'USER', 'LOGNAME', 'LANG', 'TERM', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'PATHEXT'];

function launchSpec(input: InstalledAcp['input']): AcpLaunchSpec {
  const envKey = (key: string) => process.platform === 'win32' ? key.toUpperCase() : key;
  const inherited = Object.fromEntries(inheritedKeys.flatMap(key => process.env[key] === undefined ? [] : [[envKey(key), process.env[key]]]));
  const env = { ...inherited, ...Object.fromEntries(input.environment.map(({ key, value }) => [envKey(key), value])) };
  return { command: input.command, args: input.args, env };
}

async function executable(command: string): Promise<void> {
  try {
    if (!(await stat(command)).isFile()) throw new Error();
    await access(command, constants.X_OK);
  } catch { throw new Error('请选择可执行文件的绝对路径，并确认当前用户拥有执行权限。'); }
}

function capabilityFlags(value: AgentCapabilities): AgentCapabilities {
  return JSON.parse(JSON.stringify(value, (key, field) => key === '_meta' ? undefined : field)) as AgentCapabilities;
}

async function describe(record: InstalledAcp): Promise<AcpRuntimeDescriptor> {
  await executable(record.input.command);
  const values = [...new Set(record.input.environment.flatMap(({ value }) => value ? [value, JSON.stringify(value).slice(1, -1)] : []))].sort((a, b) => b.length - a.length);
  const pattern = values.length ? new RegExp(values.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : undefined;
  return {
    id: providerId(record.id), name: record.input.name, version: String(record.protocolVersion),
    detail: '已通过 ACP 握手', detailI18n: { key: 'shell:provider.acpVerified' }, agentCapabilities: record.agentCapabilities,
    useAgentModelDefault: true, allowFormElicitation: false, permissionTiers: ['review'], tracksDelivery: true, reportsUsage: false,
    redact: text => pattern ? text.replace(pattern, '[redacted]') : text,
    launch: async () => launchSpec(record.input),
    selectModel(choices, modelId) {
      const model = choices.find(choice => choice.value === modelId);
      if (!model) throw new Error('ACP 运行时没有提供所选模型。');
      return model;
    },
  };
}

export class InstalledAcpRuntimes {
  private readonly providers = new Map<string, AcpProvider>();
  private readonly pending = new Map<string, { controller: AbortController; work: Promise<void> }>();
  private closing = false;

  constructor(private readonly directory: string) {}

  adapters(): AcpProvider[] { return [...this.providers.values()]; }

  private adapter(record: InstalledAcp): Promise<AcpProvider> {
    return createAcpProvider(providerId(record.id), record.input.name, () => describe(record), 'acp');
  }

  async load(): Promise<void> {
    await mkdir(this.directory, { mode: 0o700, recursive: true });
    if (!(await lstat(this.directory)).isDirectory()) throw new Error('ACP 配置目录不可用。');
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const path = join(this.directory, entry.name);
        const info = await lstat(path);
        if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077)) || info.size > 2 * 1024 * 1024) continue;
        const record = recordSchema.parse(JSON.parse(await readFile(path, 'utf8')));
        if (entry.name !== `${record.id}.json`) continue;
        const adapter = await this.adapter(record);
        this.providers.set(adapter.info.id, adapter);
      } catch { /* Invalid private records must not expose raw configuration through diagnostics. */ }
    }
  }

  async refresh(): Promise<void> {
    await Promise.all(this.adapters().map(adapter => adapter.refreshInfo()));
  }

  add(requestId: string, raw: unknown): Promise<void> {
    if (this.closing || this.pending.size) throw new Error('已有 ACP 配置正在校验。');
    const parsed = configuration.safeParse(raw);
    if (!parsed.success) throw new Error('请检查名称、绝对路径、参数和环境变量。环境变量名不能重复。');
    const controller = new AbortController();
    const work = this.install(parsed.data, controller.signal).finally(() => this.pending.delete(requestId));
    this.pending.set(requestId, { controller, work });
    return work;
  }

  cancel(requestId: string): void { this.pending.get(requestId)?.controller.abort(); }

  private async install(input: InstalledAcp['input'], signal: AbortSignal): Promise<void> {
    await executable(input.command);
    const cwd = await mkdtemp(join(tmpdir(), 'ensemble-acp-probe-'));
    let advertised: AgentCapabilities;
    try { advertised = await probeAcp(launchSpec(input), cwd, signal); }
    finally { await rm(cwd, { recursive: true, force: true }); }
    const record: InstalledAcp = { id: randomUUID(), origin: 'custom', protocolVersion: PROTOCOL_VERSION, input, agentCapabilities: capabilityFlags(advertised) };
    const adapter = await this.adapter(record);
    signal.throwIfAborted();
    if (!adapter.info.available) throw new Error(adapter.info.detail);
    const temporary = join(this.directory, `.${record.id}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, join(this.directory, `${record.id}.json`));
    } catch {
      rmSync(temporary, { force: true });
      throw new Error('无法保存 ACP 配置。');
    }
    this.providers.set(adapter.info.id, adapter);
  }

  remove(id: string): AcpProvider {
    const adapter = this.providers.get(id);
    if (!adapter) throw new Error('找不到这个自定义 ACP 接入。');
    unlinkSync(join(this.directory, `${id.slice('acp:'.length)}.json`));
    this.providers.delete(id);
    return adapter;
  }

  async close(): Promise<void> {
    this.closing = true;
    const pending = [...this.pending.values()];
    for (const item of pending) item.controller.abort();
    await Promise.allSettled(pending.map(item => item.work));
  }
}
