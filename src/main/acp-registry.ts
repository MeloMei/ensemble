import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { valid, gt } from 'semver';
import { z } from 'zod';
import type { AcpRegistryEntry, CustomAcpInput } from '../shared/types';
import { archiveFormat, archivePath, containedExecutable, httpsSource, prepareRegistryBinary, registryJson } from './acp-registry-archives';
import { registryProviderId, type InstalledAcpRuntimes } from './providers/installed-acp';
import { runInstaller, systemExecutable } from './runtime-install';

const officialIndex = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
const registryId = z.string().regex(/^[a-z][a-z0-9-]{0,127}$/);
const args = z.array(z.string().max(4096).refine(value => !value.includes('\0'))).max(64).default([]);
const env = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(4096).refine(value => !value.includes('\0')))
  .refine(value => Object.keys(value).length <= 64).default({});
const binarySchema = z.object({
  archive: z.string().max(4096), cmd: z.string().max(4096), sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(), args, env,
});
const packageSchema = z.object({ package: z.string().max(256), args, env });
const entrySchema = z.object({
  id: registryId, name: z.string().trim().min(1).max(100), version: z.string().max(40).regex(/^\d+\.\d+\.\d+$/).refine(value => valid(value) !== null),
  description: z.string().max(2000), repository: z.string().max(4096).optional(), website: z.string().max(4096).optional(),
  distribution: z.object({ binary: z.record(binarySchema).optional(), npx: packageSchema.optional(), uvx: packageSchema.optional() }),
});
type Entry = z.infer<typeof entrySchema>;
type Package = z.infer<typeof packageSchema>;
type Binary = z.infer<typeof binarySchema>;
type Managers = { npm?: string; node?: string; uv?: string; python?: string };
type Choice =
  | { kind: 'binary'; target: Binary }
  | { kind: 'npx'; target: Package; name: string; version: string; npm?: string; node?: string }
  | { kind: 'uvx'; target: Package; name: string; uv?: string; python?: string };

function currentPlatform() {
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : undefined;
  if (!arch) return;
  if (process.platform === 'win32') return `windows-${arch}`;
  if (process.platform === 'darwin') return `darwin-${arch}`;
  if (process.platform === 'linux') {
    const glibc = (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime;
    return `linux-${arch}${glibc ? '' : '-musl'}`;
  }
}

function npmPin(value: string) {
  const pin = value.match(/^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@([^@]+)$/);
  return pin && valid(pin[2]) === pin[2] ? { name: pin[1], version: pin[2] } : undefined;
}

function pythonPin(value: string) {
  return value.match(/^([A-Za-z0-9][A-Za-z0-9_.-]*)==\d+(?:\.\d+){1,3}(?:(?:a|b|rc)\d+|\.post\d+)?$/)?.[1].replace(/[_.]+/g, '-').toLowerCase();
}

function safeSource(value?: string) {
  try { return value ? httpsSource(value).href : undefined; }
  catch { return undefined; }
}

function resolveChoice(entry: Entry, platform: string | undefined, managers: Managers): { choice?: Choice; unavailable?: AcpRegistryEntry['unavailable'] } {
  const { binary, npx, uvx } = entry.distribution;
  const target = platform ? binary?.[platform] : undefined;
  const path = target && archivePath(target.cmd);
  if (target && path && safeSource(target.archive) && archiveFormat(target.archive)
    && (!platform?.startsWith('windows-') || path.toLowerCase().endsWith('.exe'))) return { choice: { kind: 'binary', target } };
  const packagesSupported = platform?.startsWith('darwin-') || platform?.startsWith('linux-');
  if (!packagesSupported) return { unavailable: target ? 'format' : 'platform' };
  const npm = npx && npmPin(npx.package);
  const python = uvx && pythonPin(uvx.package);
  if (npx && npm && managers.npm && managers.node) return { choice: { kind: 'npx', target: npx, ...npm, npm: managers.npm, node: managers.node } };
  if (uvx && python && managers.uv && managers.python) return { choice: { kind: 'uvx', target: uvx, name: python, uv: managers.uv, python: managers.python } };
  if (npx && npm) return { choice: { kind: 'npx', target: npx, ...npm }, unavailable: 'npm' };
  if (uvx && python) return { choice: { kind: 'uvx', target: uvx, name: python }, unavailable: 'uv' };
  return { unavailable: target || npx || uvx ? 'format' : 'platform' };
}

async function localManagers(): Promise<Managers> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return {};
  const [npm, node, uv, python] = await Promise.all(['npm', 'node', 'uv', 'python3'].map(command => systemExecutable(command)));
  return { npm, node, uv, python };
}

function packageEnvironment(root: string): NodeJS.ProcessEnv {
  const keys = ['PATH', 'LANG', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot'];
  return { ...Object.fromEntries(keys.flatMap(key => process.env[key] ? [[key, process.env[key]]] : [])),
    HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: join(root, '.cache'), GIT_ALLOW_PROTOCOL: 'https',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, '.empty-config') };
}

async function limitPackage(root: string, signal: AbortSignal) {
  const pending = [root];
  let count = 0;
  let bytes = 0;
  while (pending.length) {
    signal.throwIfAborted();
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (++count > 100_000) throw new Error('ACP 软件包文件过多。');
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        bytes += (await lstat(path)).size;
        if (bytes > 512 * 1024 * 1024) throw new Error('ACP 软件包超过安装大小限制。');
      } else if (!entry.isSymbolicLink()) throw new Error('ACP 软件包中含特殊文件。');
    }
  }
}

async function npmCommand(choice: Extract<Choice, { kind: 'npx' }>, root: string, signal: AbortSignal) {
  if (!choice.npm || !choice.node) throw new Error('需要安装 Node.js 和 npm。');
  const empty = join(root, '.empty-config');
  const userConfig = join(root, '.empty-user-config');
  await writeFile(empty, '', { mode: 0o600, flag: 'wx' });
  await writeFile(userConfig, '', { mode: 0o600, flag: 'wx' });
  const result = await runInstaller(choice.npm, [
    'install', '--prefix', root, '--registry=https://registry.npmjs.org/', '--ignore-scripts', '--no-audit', '--no-fund',
    '--no-save', '--package-lock=false', '--fetch-retries=0', '--fetch-timeout=30000',
    '--userconfig', userConfig, '--globalconfig', empty, '--cache', join(root, '.cache'), '--', choice.target.package,
  ], root, signal, packageEnvironment(root));
  signal.throwIfAborted();
  if (result !== 'ok') throw new Error(result === 'timeout' ? 'npm 安装超时。' : 'npm 无法安装此 ACP 软件包。');
  await limitPackage(root, signal);
  await rm(join(root, '.cache'), { recursive: true, force: true });
  const directory = join(root, 'node_modules', choice.name);
  const manifest = await containedExecutable(root, join(directory, 'package.json'));
  if ((await lstat(manifest)).size > 1024 * 1024) throw new Error('ACP 软件包清单过大。');
  const pkg = JSON.parse(await readFile(manifest, 'utf8')) as { name?: unknown; version?: unknown; bin?: unknown };
  if (pkg.name !== choice.name || pkg.version !== choice.version) throw new Error('ACP 软件包版本与目录不符。');
  const bins = typeof pkg.bin === 'string' ? { [basename(choice.name)]: pkg.bin }
    : z.record(z.string()).parse(pkg.bin);
  const bin = Object.hasOwn(bins, basename(choice.name)) ? bins[basename(choice.name)]
    : Object.keys(bins).length === 1 ? Object.values(bins)[0] : undefined;
  const path = bin && archivePath(bin);
  if (!path) throw new Error('无法确定 ACP 软件包的启动入口。');
  const entry = await containedExecutable(directory, join(directory, path));
  return { command: choice.node, args: [entry, ...choice.target.args] };
}

async function uvCommand(choice: Extract<Choice, { kind: 'uvx' }>, root: string, signal: AbortSignal) {
  if (!choice.uv || !choice.python) throw new Error('需要安装 uv 和 Python 3。');
  const bin = join(root, 'bin');
  await mkdir(bin, { mode: 0o700 });
  const result = await runInstaller(choice.uv, [
    'tool', 'install', '--no-config', '--no-build', '--no-python-downloads', '--no-cache',
    '--default-index', 'https://pypi.org/simple', '--python', choice.python, '--', choice.target.package,
  ], root, signal, { ...packageEnvironment(root), UV_TOOL_DIR: join(root, 'tools'), UV_TOOL_BIN_DIR: bin, UV_HTTP_TIMEOUT: '30' });
  signal.throwIfAborted();
  if (result !== 'ok') throw new Error(result === 'timeout' ? 'uv 安装超时。' : 'uv 无法安装此 ACP 软件包。');
  await limitPackage(root, signal);
  const commands = (await readdir(bin, { withFileTypes: true })).filter(entry => entry.isFile() || entry.isSymbolicLink()).map(entry => entry.name);
  const entry = commands.includes(choice.name) ? choice.name : commands.length === 1 ? commands[0] : undefined;
  if (!entry) throw new Error('无法确定 ACP 软件包的启动入口。');
  return { command: await containedExecutable(root, join(bin, entry)), args: choice.target.args };
}

export class AcpRegistry {
  private entries = new Map<string, Entry>();
  private refreshing?: Promise<AcpRegistryEntry[]>;
  private active?: { id: string; controller: AbortController; work: Promise<void> };
  private readonly stop = new AbortController();

  constructor(
    private readonly installed: InstalledAcpRuntimes,
    private readonly hooks: {
      assertIdle(id: string): void;
      publish(): void;
      dispose(adapter: ReturnType<InstalledAcpRuntimes['adapters']>[number]): Promise<void>;
    },
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  refresh(): Promise<AcpRegistryEntry[]> {
    return this.refreshing ??= this.load().finally(() => { this.refreshing = undefined; });
  }

  private async load(): Promise<AcpRegistryEntry[]> {
    const signal = AbortSignal.any([this.stop.signal, AbortSignal.timeout(15_000)]);
    const raw = await registryJson(this.fetcher, officialIndex, signal);
    const index = z.object({ version: z.string().regex(/^1\.\d+\.\d+$/), agents: z.array(z.unknown()).max(512) }).parse(raw);
    const entries = new Map<string, Entry>();
    for (const row of index.agents) {
      const result = entrySchema.safeParse(row);
      if (result.success && !entries.has(result.data.id)) entries.set(result.data.id, result.data);
    }
    if (index.agents.length && !entries.size) throw new Error('ACP 目录中没有可识别的条目。');
    const managers = await localManagers();
    const platform = currentPlatform();
    this.entries = entries;
    return [...entries.values()].map(entry => {
      const { choice, unavailable } = resolveChoice(entry, platform, managers);
      const distribution = choice && (choice.kind === 'binary'
        ? { kind: choice.kind, source: httpsSource(choice.target.archive).hostname, checksum: Boolean(choice.target.sha256) }
        : { kind: choice.kind, source: choice.target.package });
      return { id: entry.id, name: entry.name, version: entry.version, description: entry.description,
        source: safeSource(entry.repository) ?? safeSource(entry.website), platforms: Object.keys(entry.distribution.binary ?? {}),
        distribution, unavailable };
    });
  }

  install(id: string, version: string): Promise<void> {
    if (this.stop.signal.aborted || this.active) throw new Error('请等待当前 ACP 安装结束。');
    const entry = this.entries.get(id);
    if (!entry || entry.version !== version) throw new Error('ACP 目录已变化，请刷新后重试。');
    const provider = registryProviderId(id);
    const previous = this.installed.adapters().find(adapter => adapter.info.id === provider)?.info.acpRegistry;
    if (previous && !gt(version, previous.version)) throw new Error('目录中没有较新的 ACP 版本。');
    this.hooks.assertIdle(provider);
    const controller = new AbortController();
    const work = this.prepare(entry, controller.signal).finally(() => { this.active = undefined; });
    this.active = { id, controller, work };
    return work;
  }

  private async prepare(entry: Entry, signal: AbortSignal): Promise<void> {
    const { choice, unavailable } = resolveChoice(entry, currentPlatform(), await localManagers());
    if (!choice || unavailable) throw new Error('此 ACP 软件包在当前平台或依赖环境中不可用。');
    const retired = await this.installed.installRegistry({ id: entry.id, version: entry.version, kind: choice.kind }, async root => {
      const launch = choice.kind === 'binary'
        ? { command: await prepareRegistryBinary(this.fetcher, choice.target, root, signal), args: choice.target.args }
        : choice.kind === 'npx' ? await npmCommand(choice, root, signal) : await uvCommand(choice, root, signal);
      return { ...launch, name: entry.name, environment: Object.entries(choice.target.env).map(([key, value]) => ({ key, value })) } satisfies CustomAcpInput;
    }, signal, () => this.hooks.assertIdle(registryProviderId(entry.id)), this.hooks.publish);
    if (retired) {
      await this.hooks.dispose(retired.adapter);
      await retired.cleanup();
    }
  }

  assertNotInstalling(provider: string) {
    if (this.active && registryProviderId(this.active.id) === provider) throw new Error('请等这个 ACP 运行时安装结束。');
  }

  async close(): Promise<void> {
    this.stop.abort();
    this.active?.controller.abort();
    await Promise.allSettled([this.active?.work, this.refreshing]);
  }
}
