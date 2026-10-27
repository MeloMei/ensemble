// Check/download/staging flow adapted from AgentRecall at e130f72a1a34a87e4065d9f85f7733bdf632f1b6.
// Copyright (c) 2026 AgentRecall contributors. MIT; see licenses/AgentRecall-MIT.txt.
// Ensemble validates and replaces a complete macOS bundle instead of an npm directory.
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import extractZip from 'extract-zip';
import * as yauzl from 'yauzl';
import semver from 'semver';
import { z } from 'zod';
import type { AppUpdateRelease, AppUpdateState } from '../shared/application-updates';
import { DATA_SCHEMA_VERSION } from '../shared/data-schema';

const REPOSITORY = 'MeloMei/ensemble';
const RELEASES = `https://github.com/${REPOSITORY}/releases`;
const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const RELEASE_FEED = `${RELEASES}/latest/download/ensemble-update.json`;
const MAX_ARCHIVE_BYTES = 1_073_741_824;
const MAX_EXPANDED_BYTES = 3_221_225_472;
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const MANUAL_CHECK_INTERVAL = 5 * MINUTE;
const run = promisify(execFile);
const uuid = z.string().uuid();
const stableVersion = z.string().regex(/^\d+\.\d+\.\d+$/).refine(value => semver.valid(value) === value);
const releaseSchema = z.object({
  version: stableVersion, title: z.string().max(1000), notes: z.string().max(200_000), publishedAt: z.string().datetime(),
  url: z.string().url(), downloadUrl: z.string().url(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive().max(MAX_ARCHIVE_BYTES),
});
const pendingSchema = z.object({ token: uuid, version: stableVersion });
const checkFailureSchema = z.object({ error: z.string(), errorCode: z.enum(['rate-limited', 'forbidden']).optional(), retryAt: z.string().datetime().optional() });
const cacheSchema = z.object({
  checkedAt: z.string().datetime().optional(), release: releaseSchema.optional(), stageRoot: z.string().optional(),
  checkAfter: z.string().datetime().optional(), checkFailure: checkFailureSchema.optional(), failedChecks: z.number().int().min(0).max(20).optional(),
});

class UpdateRequestError extends Error {
  constructor(message: string, readonly code?: 'rate-limited' | 'forbidden', readonly retryAt?: string) { super(message); }
}

function errorText(error: unknown): string { return error instanceof z.ZodError ? '发行版信息不完整或格式无效，请稍后重新检查。' : error instanceof Error ? error.message : String(error); }
function inside(root: string, path: string): boolean { const value = relative(root, path); return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !value.startsWith(sep)); }

async function saveJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

async function trustedFetch(url: string, options: RequestInit, fetcher: typeof fetch): Promise<Response> {
  let next = url;
  for (let redirect = 0; redirect <= 5; redirect++) {
    const target = new URL(next);
    if (target.protocol !== 'https:' || target.username || target.password
      || !['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname)) throw new Error('更新下载地址不受信任。');
    const response = await fetcher(next, { ...options, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('更新服务器没有提供下载地址。');
    next = new URL(location, target).toString();
  }
  throw new Error('更新下载重定向次数过多。');
}

async function responseText(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length; if (bytes > limit) throw new Error('更新服务器的响应超过大小限制。');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

async function responseError(response: Response): Promise<UpdateRequestError> {
  const text = await responseText(response, 10_000).catch(() => '');
  let message = '';
  try { const body: unknown = JSON.parse(text); if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') message = body.message; } catch {}
  const limited = response.status === 429 || response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0'
    || response.headers.has('retry-after') || /rate.?limit|abuse detection/i.test(message));
  if (limited) {
    const now = Date.now();
    const retry = response.headers.get('retry-after');
    const delay = retry && /^\d+$/.test(retry) ? now + Number(retry) * 1000 : retry ? Date.parse(retry) : NaN;
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
    const deadline = Math.max(...[delay, reset].filter(value => Number.isFinite(value) && value > now));
    return new UpdateRequestError('GitHub 暂时限制了当前网络的更新请求，请在冷却结束后重试，或手动下载新版。', 'rate-limited',
      Number.isFinite(deadline) && deadline <= 8.64e15 - 1000 ? new Date(deadline + 1000).toISOString() : undefined);
  }
  if (response.status === 403) return new UpdateRequestError('更新请求被服务器拒绝（403）。请检查网络访问，或打开下载页面手动更新。', 'forbidden');
  return new UpdateRequestError(`更新服务器返回 ${response.status}。`);
}

async function limitedText(response: Response, limit: number): Promise<string> {
  if (!response.ok) throw await responseError(response);
  return responseText(response, limit);
}

export async function latestApplicationRelease(arch: string, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<AppUpdateRelease> {
  const headers = { Accept: 'application/json', 'User-Agent': 'Ensemble-updater' };
  let response = await trustedFetch(RELEASE_FEED, { signal, headers }, fetcher);
  if (response.status === 404) {
    await response.body?.cancel();
    response = await trustedFetch(RELEASE_API, { signal, headers: { ...headers, Accept: 'application/vnd.github+json' } }, fetcher);
  }
  const value = z.object({
    tag_name: z.string(), name: z.string().nullable(), body: z.string().nullable(), html_url: z.string(),
    published_at: z.string().datetime(), draft: z.literal(false), prerelease: z.literal(false),
    assets: z.array(z.object({ name: z.string(), size: z.number().int().positive().max(MAX_ARCHIVE_BYTES), browser_download_url: z.string(), digest: z.string().nullable().optional() })).max(100),
  }).parse(JSON.parse(await limitedText(response, 1_000_000)));
  const version = stableVersion.parse(value.tag_name.replace(/^v/, ''));
  if (value.tag_name !== `v${version}` || value.html_url !== `${RELEASES}/tag/v${version}`) throw new Error('最新发行版的版本或地址不匹配。');
  if (!['arm64', 'x64'].includes(arch)) throw new Error('当前系统架构没有可用的更新包。');
  const name = `Ensemble-${version}-macOS-${arch}.zip`;
  const asset = value.assets.find(item => item.name === name);
  const downloadUrl = `${RELEASES}/download/v${version}/${name}`;
  if (!asset || asset.browser_download_url !== downloadUrl) throw new Error('最新发行版没有适合当前 Mac 的安装包。');
  let sha256 = asset.digest?.match(/^sha256:([a-f0-9]{64})$/)?.[1];
  if (!sha256) {
    const checksum = value.assets.find(item => item.name === 'SHA256SUMS');
    const checksumUrl = `${RELEASES}/download/v${version}/SHA256SUMS`;
    if (!checksum || checksum.browser_download_url !== checksumUrl) throw new Error('发行版缺少安装包校验值。');
    const sums = await limitedText(await trustedFetch(checksumUrl, { signal }, fetcher), 100_000);
    sha256 = sums.split(/\r?\n/).map(line => line.match(/^([a-f0-9]{64})\s+\*?(.+)$/)).find(match => match?.[2] === name)?.[1];
  }
  if (!sha256) throw new Error('发行版的安装包校验值无效。');
  return releaseSchema.parse({ version, title: value.name ?? `Ensemble ${version}`, notes: value.body ?? '', publishedAt: value.published_at, url: value.html_url, downloadUrl, sha256, size: asset.size });
}

async function validateArchive(path: string): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((resolveZip, reject) => yauzl.open(path, { lazyEntries: true, strictFileNames: true }, (error, file) => error || !file ? reject(error ?? new Error('安装包无法读取。')) : resolveZip(file)));
  let bytes = 0; let entries = 0;
  await new Promise<void>((resolveZip, reject) => {
    const fail = (error: unknown) => { zip.close(); reject(error); };
    zip.on('error', fail); zip.on('end', resolveZip);
    zip.on('entry', (entry: yauzl.Entry) => { void (async () => {
      if (++entries > 100_000 || (bytes += entry.uncompressedSize) > MAX_EXPANDED_BYTES) throw new Error('安装包解压后超过大小限制。');
      const name = entry.fileName;
      const root = name.startsWith('__MACOSX/') ? '__MACOSX' : 'Ensemble.app';
      if (!(name === `${root}/` || name.startsWith(`${root}/`)) || /[\x00-\x1f\x7f\\]/.test(name)
        || name.split('/').some(part => part === '..' || part === '.')) throw new Error('安装包包含越界路径。');
      const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (kind && ![0o040000, 0o100000, 0o120000].includes(kind)) throw new Error('安装包包含不支持的文件类型。');
      if (kind === 0o120000) {
        if (entry.uncompressedSize > 4096) throw new Error('安装包包含无效的符号链接。');
        const stream = await new Promise<import('node:stream').Readable>((resolveStream, rejectStream) => zip.openReadStream(entry, (error, value) => error || !value ? rejectStream(error) : resolveStream(value)));
        const target = await new Promise<string>((resolveTarget, rejectTarget) => {
          const chunks: Buffer[] = []; let bytes = 0;
          stream.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 4096) { stream.destroy(new Error('安装包包含无效的符号链接。')); return; }
            chunks.push(chunk);
          });
          stream.once('error', rejectTarget);
          stream.once('end', () => resolveTarget(Buffer.concat(chunks).toString('utf8')));
        });
        const destination = posix.normalize(posix.join(posix.dirname(name), target));
        if (target.startsWith('/') || /[\x00-\x1f\x7f\\]/.test(target) || !(destination === root || destination.startsWith(`${root}/`))) throw new Error('安装包包含越界符号链接。');
      }
      zip.readEntry();
    })().catch(fail); });
    zip.readEntry();
  });
}

export async function validateStagedApplication(app: string, version: string, arch: string): Promise<void> {
  const root = await realpath(app);
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (!inside(root, await realpath(path))) throw new Error('安装包中的文件指向应用目录之外。');
      if (entry.isDirectory()) await visit(path);
    }
  };
  await visit(root);
  const info = join(app, 'Contents', 'Info.plist');
  const bundleId = (await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', info])).stdout.trim();
  const bundleVersion = (await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', info])).stdout.trim();
  if (bundleId !== 'local.agent-workbench.desktop' || bundleVersion !== version) throw new Error('安装包的应用身份或版本不匹配。');
  const metadata = JSON.parse(await readFile(join(app, 'Contents', 'Resources', 'app', 'package.json'), 'utf8'));
  if (metadata.name !== 'ensemble' || metadata.version !== version) throw new Error('安装包内容与发行版不匹配。');
  if (metadata.ensemble?.dataSchemaVersion !== DATA_SCHEMA_VERSION) throw new Error('新版的数据格式需要迁移，不能直接自动安装。请查看发行说明后手动升级。');
  const executable = join(app, 'Contents', 'MacOS', 'Ensemble');
  const archs = (await run('/usr/bin/lipo', ['-archs', executable])).stdout.trim().split(/\s+/);
  if (!archs.includes(arch === 'x64' ? 'x86_64' : arch)) throw new Error('安装包不支持当前 Mac 的处理器。');
  try { await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeout: 60_000 }); }
  catch { throw new Error('安装包签名完整性校验失败，现有应用未改动。'); }
}

export interface ApplicationUpdatesOptions {
  currentVersion: string;
  appPath?: string;
  dataPath: string;
  arch: string;
  helperPath: string;
  getAutoCheck(): boolean;
  setAutoCheck(enabled: boolean): Promise<void>;
  publish(state: AppUpdateState): void;
  prepareInstall(token: string): Promise<number>;
  cancelInstall(token: string): Promise<void>;
  requestQuit(): void;
  fetch?: typeof fetch;
}

export class ApplicationUpdates {
  private state: AppUpdateState;
  private stageRoot?: string;
  private operation?: Promise<AppUpdateState>;
  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private checkFailure?: z.infer<typeof checkFailureSchema>;
  private failedChecks = 0;
  private disposed = false;
  private readonly cachePath: string;
  private readonly updatePath: string;

  constructor(private readonly options: ApplicationUpdatesOptions) {
    this.state = { currentVersion: options.currentVersion, supported: !!options.appPath && process.platform === 'darwin', autoCheck: options.getAutoCheck(), phase: 'idle' };
    this.updatePath = join(options.dataPath, 'updates');
    this.cachePath = join(this.updatePath, 'state.json');
  }

  get snapshot(): AppUpdateState { return structuredClone(this.state); }

  async load(): Promise<void> {
    await mkdir(this.updatePath, { recursive: true, mode: 0o700 });
    const raw = await readJson(this.cachePath).catch(() => undefined);
    const cache = cacheSchema.safeParse(raw);
    if (cache.success) {
      this.state = { ...this.state, checkedAt: cache.data.checkedAt, checkAfter: cache.data.checkAfter };
      this.checkFailure = cache.data.checkFailure;
      this.failedChecks = cache.data.failedChecks ?? 0;
      const release = cache.data.release;
      if (release && this.trustedRelease(release) && semver.gt(release.version, this.options.currentVersion)) {
        this.state = { ...this.state, checkedAt: cache.data.checkedAt, release, phase: 'available' };
        if (cache.data.stageRoot && this.ownedStage(cache.data.stageRoot)) {
          try {
            await validateStagedApplication(join(cache.data.stageRoot, 'unpacked', 'Ensemble.app'), release.version, this.options.arch);
            this.stageRoot = cache.data.stageRoot; this.state.phase = 'ready';
          } catch { await rm(cache.data.stageRoot, { recursive: true, force: true }); }
        }
      } else if (cache.data.checkedAt) this.state.phase = 'current';
      if (this.checkFailure) this.state = { ...this.state, ...this.checkFailure, phase: this.stageRoot ? 'ready' : 'error' };
    }
    const result = z.object({ status: z.enum(['installed', 'error', 'rollback-failed']), token: uuid, version: stableVersion }).safeParse(await readJson(join(this.updatePath, 'result.json')).catch(() => undefined));
    if (result.success && result.data.status !== 'installed' && !semver.gt(this.options.currentVersion, result.data.version)) {
      this.state.error = result.data.status === 'rollback-failed'
        ? '更新未完成，自动恢复也未完成。请保留安装目录中的恢复副本，查看更新日志后处理。'
        : '上次更新未完成，已恢复原来的应用。请重新检查后重试。';
      await this.options.cancelInstall(result.data.token);
    }
    this.changed();
  }

  schedule(): void {
    if (this.disposed || !this.state.supported || !this.options.getAutoCheck()) return;
    if (this.timer) clearTimeout(this.timer);
    const due = this.checkFailure ? 0 : this.state.checkedAt ? Date.parse(this.state.checkedAt) + DAY : 0;
    const delay = Math.max(5000, due - Date.now(), Date.parse(this.state.checkAfter ?? '') - Date.now() || 0);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.check(false);
    }, Math.min(delay, 2_147_483_647));
    this.timer.unref();
  }

  async setAutoCheck(enabled: boolean): Promise<AppUpdateState> {
    await this.options.setAutoCheck(enabled);
    this.state.autoCheck = enabled;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (enabled) this.schedule();
    return this.changed();
  }

  check(force = true): Promise<AppUpdateState> {
    return this.checkRelease(force).finally(() => this.schedule());
  }

  private checkRelease(force: boolean): Promise<AppUpdateState> {
    if (this.state.phase === 'installing') return Promise.resolve(this.snapshot);
    if (this.operation) return this.operation;
    if (!this.state.supported) return Promise.resolve(this.snapshot);
    if (this.state.checkAfter && Date.now() < Date.parse(this.state.checkAfter)) return Promise.resolve(this.snapshot);
    if (!force && !this.checkFailure && this.state.checkedAt && Date.now() - Date.parse(this.state.checkedAt) < DAY) return Promise.resolve(this.snapshot);
    return this.exclusive(async signal => {
      this.state = { ...this.state, phase: 'checking', error: undefined, errorCode: undefined, retryAt: undefined }; this.changed();
      let release: AppUpdateRelease;
      try {
        release = await latestApplicationRelease(this.options.arch, this.options.fetch, AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
      } catch (error) {
        if (signal.aborted) throw error;
        this.failedChecks = Math.min(this.failedChecks + 1, 20);
        const retryAt = error instanceof UpdateRequestError ? error.retryAt : undefined;
        const checkAfter = retryAt ?? new Date(Date.now() + Math.min(MINUTE * 2 ** (this.failedChecks - 1), 60 * MINUTE)).toISOString();
        this.checkFailure = { error: errorText(error), errorCode: error instanceof UpdateRequestError ? error.code : undefined,
          retryAt: error instanceof UpdateRequestError && error.code === 'rate-limited' ? checkAfter : undefined };
        this.state = { ...this.state, ...this.checkFailure, checkAfter };
        await this.save();
        throw error;
      }
      this.checkFailure = undefined; this.failedChecks = 0;
      if (this.stageRoot && this.state.release?.version !== release.version) await this.clearStage();
      this.state = { ...this.state, checkedAt: new Date().toISOString(), checkAfter: new Date(Date.now() + MANUAL_CHECK_INTERVAL).toISOString(),
        phase: semver.gt(release.version, this.options.currentVersion) ? this.stageRoot ? 'ready' : 'available' : 'current', release: semver.gt(release.version, this.options.currentVersion) ? release : undefined };
      await this.save();
      return this.changed();
    });
  }

  download(): Promise<AppUpdateState> {
    if (this.state.phase === 'installing') return Promise.resolve(this.snapshot);
    if (this.operation) return this.operation;
    return this.exclusive(async signal => {
      const release = this.state.release;
      if (!this.options.appPath || !release || !this.trustedRelease(release) || !semver.gt(release.version, this.options.currentVersion)) throw new Error('请先检查可用的新版本。');
      if (this.stageRoot) { this.state.phase = 'ready'; return this.changed(); }
      const live = await realpath(this.options.appPath);
      if (live !== this.options.appPath || (await lstat(live)).isSymbolicLink()) throw new Error('请从实际安装目录启动 Ensemble 后再更新。');
      try { await access(dirname(live), constants.W_OK); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EACCES') throw new Error('当前安装目录没有更新权限。请将 Ensemble 移到你有写入权限的 Applications 目录后重试。');
        throw error;
      }
      const stage = await mkdtemp(join(dirname(live), '.ensemble-update-'));
      try {
        await this.save(stage);
        this.state = { ...this.state, phase: 'downloading', downloadedBytes: 0, totalBytes: release.size, error: undefined }; this.changed();
        const archive = join(stage, 'update.zip');
        const response = await trustedFetch(release.downloadUrl, { signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]), headers: { 'User-Agent': 'Ensemble-updater' } }, this.options.fetch ?? fetch);
        if (!response.ok || !response.body) throw new Error(`安装包下载失败（${response.status}）。`);
        const declared = response.headers.get('content-length');
        if (declared && Number(declared) !== release.size) throw new Error('安装包大小与发行版不匹配。');
        const reader = response.body.getReader(); const file = await open(archive, 'wx', 0o600); const hash = createHash('sha256');
        let bytes = 0; let lastProgress = 0;
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            bytes += value.length;
            if (bytes > release.size || bytes > MAX_ARCHIVE_BYTES) throw new Error('安装包下载超过大小限制。');
            await file.writeFile(value); hash.update(value);
            if (Date.now() - lastProgress > 100) { this.state.downloadedBytes = bytes; this.changed(); lastProgress = Date.now(); }
          }
          await file.sync();
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); await file.close(); }
        if (bytes !== release.size || hash.digest('hex') !== release.sha256) throw new Error('安装包校验失败，现有应用未改动。');
        await validateArchive(archive);
        await extractZip(archive, { dir: join(stage, 'unpacked') });
        await validateStagedApplication(join(stage, 'unpacked', 'Ensemble.app'), release.version, this.options.arch);
        await rm(archive);
        this.stageRoot = stage;
        this.state = { ...this.state, phase: 'ready', downloadedBytes: bytes };
        await this.save();
        return this.changed();
      } catch (error) { await rm(stage, { recursive: true, force: true }); await this.save(); throw error; }
    });
  }

  install(): Promise<AppUpdateState> {
    if (this.state.phase === 'installing') return Promise.resolve(this.snapshot);
    if (this.operation) return this.operation;
    return this.exclusive(async signal => {
      const release = this.state.release; const stage = this.stageRoot; const app = this.options.appPath;
      if (!app || !stage || !release || !this.ownedStage(stage)) throw new Error('请先下载并校验新版本。');
      this.state = { ...this.state, phase: 'installing', error: undefined }; this.changed();
      await validateStagedApplication(join(stage, 'unpacked', 'Ensemble.app'), release.version, this.options.arch);
      signal.throwIfAborted();
      const token = randomUUID();
      const backendPid = await this.options.prepareInstall(token);
      try {
      signal.throwIfAborted();
        const helper = join(stage, 'apply-update.sh');
        await copyFile(this.options.helperPath, helper);
        await saveJson(join(this.updatePath, 'pending.json'), { token, version: release.version });
        const log = await open(join(this.updatePath, 'installer.log'), 'a', 0o600);
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn('/bin/sh', [helper, app, join(stage, 'unpacked', 'Ensemble.app'), join(stage, 'previous.app'), String(process.pid), String(backendPid), this.options.dataPath, token, release.version], {
            detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, WORKBENCH_DEV_URL: undefined, WORKBENCH_DATA_DIR: this.options.dataPath },
          });
          await new Promise<void>((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
          child.unref();
        } finally { await log.close(); }
        this.state = { ...this.state, phase: 'installing', error: undefined }; this.changed();
        this.options.requestQuit();
        return this.snapshot;
      } catch (error) {
        await this.options.cancelInstall(token);
        await rm(join(this.updatePath, 'pending.json'), { force: true });
        throw error;
      }
    });
  }

  async acknowledgeReady(): Promise<void> {
    const pending = pendingSchema.safeParse(await readJson(join(this.updatePath, 'pending.json')));
    if (!pending.success || pending.data.version !== this.options.currentVersion) return;
    await writeFile(join(this.updatePath, `ready-${pending.data.token}`), String(process.pid), { mode: 0o600 });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const result = await readJson(join(this.updatePath, 'result.json'));
      if (result && typeof result === 'object' && 'status' in result && result.status === 'installed'
        && 'version' in result && result.version === pending.data.version && 'token' in result && result.token === pending.data.token) {
        await this.options.cancelInstall(pending.data.token);
        return;
      }
      await new Promise(resolveCheck => setTimeout(resolveCheck, 100));
    }
    throw new Error('新版已经启动，但安装确认未完成。请稍后重新打开 Ensemble。');
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.controller?.abort();
    if (this.timer) clearTimeout(this.timer);
    await this.operation;
  }

  private trustedRelease(release: AppUpdateRelease): boolean {
    return release.url === `${RELEASES}/tag/v${release.version}` && release.downloadUrl === `${RELEASES}/download/v${release.version}/Ensemble-${release.version}-macOS-${this.options.arch}.zip`;
  }
  private ownedStage(path: string): boolean { return !!this.options.appPath && dirname(path) === dirname(this.options.appPath) && /^\.ensemble-update-[A-Za-z0-9]{6}$/.test(basename(path)); }
  private changed(): AppUpdateState { const state = this.snapshot; if (!this.disposed) this.options.publish(state); return state; }
  private async save(stageRoot = this.stageRoot): Promise<void> { await saveJson(this.cachePath, { checkedAt: this.state.checkedAt, release: this.state.release, stageRoot,
    checkAfter: this.state.checkAfter, checkFailure: this.checkFailure, failedChecks: this.failedChecks }); }
  private async clearStage(): Promise<void> { if (this.stageRoot && this.ownedStage(this.stageRoot)) await rm(this.stageRoot, { recursive: true, force: true }); this.stageRoot = undefined; }
  private exclusive(operation: (signal: AbortSignal) => Promise<AppUpdateState>): Promise<AppUpdateState> {
    this.controller = new AbortController();
    const task = operation(this.controller.signal).catch(error => {
      if (this.disposed) return this.snapshot;
      this.state = { ...this.state, phase: this.stageRoot ? 'ready' : 'error', error: errorText(error) }; return this.changed();
    }).finally(() => { if (this.operation === task) { this.operation = undefined; this.controller = undefined; } });
    this.operation = task;
    return task;
  }
}
