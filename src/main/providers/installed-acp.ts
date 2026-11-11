import { randomUUID } from 'node:crypto';
import { constants, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PROTOCOL_VERSION, type AgentCapabilities } from '@agentclientprotocol/sdk';
import { z } from 'zod';
import type { AcpRegistryInstallation } from '../../shared/types';
import { createAcpProvider, probeAcp, type AcpProvider } from './acp';
import type { AcpLaunchSpec, AcpRuntimeDescriptor } from './acp-types';

const configuration = z.object({
  name: z.string().trim().min(1).max(100),
  command: z.string().max(4096).refine(value => isAbsolute(value) && !value.includes('\0')),
  args: z.array(z.string().max(4096).refine(value => !value.includes('\0'))).max(64),
  environment: z.array(z.object({ key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), value: z.string().max(4096).refine(value => !value.includes('\0')) }).strict()).max(64),
}).strict().refine(input => new Set(input.environment.map(entry => process.platform === 'win32' ? entry.key.toUpperCase() : entry.key)).size === input.environment.length);
const recordSchema = z.object({
  id: z.string().uuid(), origin: z.enum(['custom', 'registry']), protocolVersion: z.literal(PROTOCOL_VERSION),
  input: configuration, agentCapabilities: z.custom<AgentCapabilities>(value => value !== null && typeof value === 'object' && !Array.isArray(value)),
  registry: z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,127}$/), version: z.string().regex(/^\d+\.\d+\.\d+$/),
    kind: z.enum(['binary', 'npx', 'uvx']), assetId: z.string().uuid(),
  }).strict().optional(),
}).strict().refine(record => (record.origin === 'registry') === Boolean(record.registry));
type InstalledAcp = z.infer<typeof recordSchema>;

export const registryProviderId = (id: string) => `acp-registry:${id}`;
const providerId = (record: InstalledAcp) => record.registry ? registryProviderId(record.registry.id) : `acp:${record.id}`;
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
    id: providerId(record), name: record.input.name, version: record.registry?.version ?? String(record.protocolVersion),
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
  private readonly installed = new Map<string, { record: InstalledAcp; adapter: AcpProvider }>();
  private readonly pending = new Map<string, { controller: AbortController; work: Promise<void> }>();
  private closing = false;

  constructor(private readonly directory: string) {}

  adapters(): AcpProvider[] { return [...this.installed.values()].map(item => item.adapter); }

  private async adapter(record: InstalledAcp): Promise<AcpProvider> {
    const adapter = await createAcpProvider(providerId(record), record.input.name, () => describe(record), 'acp');
    if (record.registry) {
      const { id, version, kind } = record.registry;
      adapter.info = { ...adapter.info, acpRegistry: { id, version, kind } };
    }
    return adapter;
  }

  private assets(id: string) { return join(this.directory, 'registry-assets', id); }

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
        this.installed.set(adapter.info.id, { record, adapter });
      } catch { /* Invalid private records must not expose raw configuration through diagnostics. */ }
    }
    const assetsRoot = this.assets('');
    const assets = await lstat(assetsRoot).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return undefined;
    });
    if (!assets) return;
    if (!assets.isDirectory()) throw new Error('ACP 安装目录不可用。');
    const referenced = new Set([...this.installed.values()].flatMap(entry => entry.record.registry ? [entry.record.registry.assetId] : []));
    for (const file of await readdir(assetsRoot, { withFileTypes: true })) {
      const id = file.name.replace(/\.download$/, '');
      if (!referenced.has(id) && z.string().uuid().safeParse(id).success) {
        await rm(join(assetsRoot, file.name), { recursive: true, force: true }).catch(() => {});
      }
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
    const work = this.probe(parsed.data, controller.signal).then(result => {
      controller.signal.throwIfAborted();
      this.commit(result.record, result.adapter);
    }).finally(() => this.pending.delete(requestId));
    this.pending.set(requestId, { controller, work });
    return work;
  }

  cancel(requestId: string): void { this.pending.get(requestId)?.controller.abort(); }

  private async probe(input: InstalledAcp['input'], signal: AbortSignal, registry?: InstalledAcp['registry'], existingId?: string) {
    await executable(input.command);
    const cwd = await mkdtemp(join(tmpdir(), 'ensemble-acp-probe-'));
    let advertised: AgentCapabilities;
    try { advertised = await probeAcp(launchSpec(input), cwd, signal); }
    finally { await rm(cwd, { recursive: true, force: true }); }
    const record: InstalledAcp = { id: existingId ?? randomUUID(), origin: registry ? 'registry' : 'custom',
      protocolVersion: PROTOCOL_VERSION, input, agentCapabilities: capabilityFlags(advertised), ...(registry ? { registry } : {}) };
    const adapter = await this.adapter(record);
    signal.throwIfAborted();
    if (!adapter.info.available) throw new Error(adapter.info.detail);
    return { record, adapter };
  }

  private commit(record: InstalledAcp, adapter: AcpProvider) {
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, join(this.directory, `${record.id}.json`));
    } catch {
      rmSync(temporary, { force: true });
      throw new Error('无法保存 ACP 配置。');
    }
    this.installed.set(adapter.info.id, { record, adapter });
  }

  async installRegistry(
    metadata: AcpRegistryInstallation,
    prepare: (directory: string) => Promise<InstalledAcp['input']>,
    signal: AbortSignal,
    beforeCommit: () => void,
    publish: () => void,
  ) {
    if (this.closing) throw new Error('应用正在退出。');
    const previous = this.installed.get(registryProviderId(metadata.id));
    const assetId = randomUUID();
    const directory = this.assets(assetId);
    await mkdir(this.assets(''), { recursive: true, mode: 0o700 });
    if (!(await lstat(this.assets(''))).isDirectory()) throw new Error('ACP 安装目录不可用。');
    await mkdir(directory, { mode: 0o700 });
    try {
      const input = configuration.parse(await prepare(directory));
      const { record, adapter } = await this.probe(input, signal, { ...metadata, assetId }, previous?.record.id);
      if (this.closing) throw new Error('应用正在退出。');
      signal.throwIfAborted();
      beforeCommit();
      this.commit(record, adapter);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    publish();
    return previous && this.retire(previous);
  }

  private retire(entry: { record: InstalledAcp; adapter: AcpProvider }) {
    const registry = entry.record.registry;
    return { adapter: entry.adapter, cleanup: async () => {
      if (registry) await rm(this.assets(registry.assetId), { recursive: true, force: true }).catch(() => {});
    } };
  }

  remove(id: string) {
    const entry = this.installed.get(id);
    if (!entry) throw new Error('找不到这个 ACP 接入。');
    unlinkSync(join(this.directory, `${entry.record.id}.json`));
    this.installed.delete(id);
    return this.retire(entry);
  }

  async close(): Promise<void> {
    this.closing = true;
    const pending = [...this.pending.values()];
    for (const item of pending) item.controller.abort();
    await Promise.allSettled(pending.map(item => item.work));
  }
}
