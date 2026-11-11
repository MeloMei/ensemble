import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createGunzip } from 'node:zlib';
import { extract } from 'tar-stream';
import yauzl from 'yauzl';

const maxDownload = 256 * 1024 * 1024;
const maxExtracted = 512 * 1024 * 1024;
const maxEntries = 20_000;

export function httpsSource(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('ACP 来源必须使用 HTTPS。');
  return url;
}

export async function registryResponse(fetcher: typeof fetch, value: string, signal: AbortSignal, limit: number): Promise<Response> {
  let url = httpsSource(value);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetcher(url, { signal, redirect: 'manual', credentials: 'omit' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) break;
      url = httpsSource(new URL(location, url).href);
      continue;
    }
    if (response.ok && response.body && Number(response.headers.get('content-length') ?? 0) <= limit) return response;
    await response.body?.cancel();
    throw new Error('无法读取 ACP 来源，或文件超过大小限制。');
  }
  throw new Error('ACP 来源重定向次数过多。');
}

function limitBytes(max: number, chunkRead?: (bytes: Buffer) => void) {
  let total = 0;
  return new Transform({ transform(chunk: Buffer, _encoding, done) {
    total += chunk.length;
    if (total > max) { done(new Error('ACP 下载或解压内容超过大小限制。')); return; }
    chunkRead?.(chunk);
    done(null, chunk);
  } });
}

export async function registryJson(fetcher: typeof fetch, url: string, signal: AbortSignal): Promise<unknown> {
  const max = 1024 * 1024;
  const response = await registryResponse(fetcher, url, signal, max);
  const chunks: Buffer[] = [];
  await pipeline(Readable.fromWeb(response.body as NodeReadableStream), limitBytes(max, chunk => chunks.push(chunk)), new Transform({
    transform(_chunk, _encoding, done) { done(); },
  }), { signal });
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function archivePath(value: string): string | undefined {
  if (!value || value.length > 4096 || value.startsWith('/') || /[\\:\u0000-\u001f\u007f]/u.test(value)) return;
  const parts = value.split('/').filter(part => part && part !== '.');
  if (parts.some(part => part.length > 255 || part === '..' || /[. ]$/.test(part)
    || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part))) return;
  return parts.join('/');
}

export function archiveFormat(url: string): 'zip' | 'tar' | 'gzip' | 'raw' | undefined {
  const pathname = httpsSource(url).pathname.toLowerCase();
  if (pathname.endsWith('.zip')) return 'zip';
  if (/\.(tar\.gz|tgz)$/.test(pathname)) return 'gzip';
  if (pathname.endsWith('.tar')) return 'tar';
  if (/\.(bz2|tbz2?|xz|txz|zst|tzst|gz|7z|rar|dmg|pkg|deb|rpm|msi|appimage)$/.test(pathname)) return;
  return 'raw';
}

export async function containedExecutable(root: string, path: string): Promise<string> {
  const target = await realpath(path);
  const position = relative(await realpath(root), target);
  if (!position || position === '..' || position.startsWith(`..${sep}`) || isAbsolute(position)
    || !(await lstat(target)).isFile()) throw new Error('ACP 启动文件位于安装目录之外。');
  return target;
}

function archiveWriter(root: string, signal: AbortSignal) {
  let entries = 0;
  let bytes = 0;
  return async (name: string, directory: boolean, size: number, mode: number, read: () => Promise<Readable>) => {
    signal.throwIfAborted();
    const path = archivePath(name);
    if (path === undefined || (!path && !directory) || ++entries > maxEntries || !Number.isSafeInteger(size) || size < 0
      || (bytes += size) > maxExtracted) throw new Error('ACP 归档含不安全路径或超过解压限制。');
    const output = join(root, path);
    if (directory) {
      if (size) throw new Error('ACP 归档目录包含异常数据。');
      await mkdir(output, { recursive: true, mode: 0o700 });
      return;
    }
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await pipeline(await read(), limitBytes(size), createWriteStream(output, { flags: 'wx', mode: 0o600 | (mode & 0o100) }), { signal });
  };
}

async function unzip(input: string, root: string, signal: AbortSignal) {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(input, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, file) => error ? reject(error) : resolve(file)));
  const write = archiveWriter(root, signal);
  try {
    if (zip.entryCount > maxEntries) throw new Error('ACP 归档中的文件过多。');
    await new Promise<void>((resolve, reject) => {
      zip.once('end', resolve);
      zip.once('error', reject);
      zip.on('entry', entry => {
        const mode = entry.externalFileAttributes >>> 16;
        const type = mode & 0o170000;
        const directory = entry.fileName.endsWith('/');
        if ((entry.externalFileAttributes & 0x448) || ![0, directory ? 0o040000 : 0o100000].includes(type)) {
          reject(new Error('ACP 归档中含链接或特殊文件。')); return;
        }
        void write(entry.fileName, directory, entry.uncompressedSize, mode, () =>
          new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream))))
          .then(() => zip.readEntry(), reject);
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
}

async function untar(input: string, root: string, gzip: boolean, signal: AbortSignal) {
  const parser = extract();
  const write = archiveWriter(root, signal);
  parser.on('entry', (header, stream, next) => {
    if (header.type !== 'file' && header.type !== 'directory') { next(new Error('ACP 归档中含链接或特殊文件。')); return; }
    void write(header.name, header.type === 'directory', header.size ?? 0, header.mode ?? 0, async () => Readable.from(stream))
      .then(() => next(), next);
  });
  const stream = createReadStream(input);
  const limit = limitBytes(maxExtracted + 20 * 1024 * 1024);
  if (gzip) await pipeline(stream, createGunzip(), limit, parser, { signal });
  else await pipeline(stream, limit, parser, { signal });
}

async function rawExecutable(path: string) {
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(4);
    if ((await file.read(bytes)).bytesRead < 4) return false;
    return bytes.subarray(0, 2).toString() === 'MZ' || bytes.toString() === '\u007fELF'
      || ['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(bytes.toString('hex'));
  } finally { await file.close(); }
}

export async function prepareRegistryBinary(fetcher: typeof fetch, target: { archive: string; cmd: string; sha256?: string }, root: string, signal: AbortSignal) {
  const format = archiveFormat(target.archive);
  const path = archivePath(target.cmd);
  if (!format || !path || (process.platform === 'win32' && !path.toLowerCase().endsWith('.exe'))) throw new Error('此 ACP 二进制格式在当前平台不可用。');
  const download = join(dirname(root), `${basename(root)}.download`);
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  const response = await registryResponse(fetcher, target.archive, bounded, maxDownload);
  const hash = createHash('sha256');
  try {
    await pipeline(Readable.fromWeb(response.body as NodeReadableStream), limitBytes(maxDownload, chunk => { hash.update(chunk); }),
      createWriteStream(download, { flags: 'wx', mode: 0o600 }), { signal: bounded });
    if (target.sha256 && hash.digest('hex') !== target.sha256.toLowerCase()) throw new Error('ACP 下载的 SHA-256 校验失败。');
    const command = join(root, path);
    if (format === 'zip') await unzip(download, root, bounded);
    else if (format === 'tar' || format === 'gzip') await untar(download, root, format === 'gzip', bounded);
    else {
      if (!await rawExecutable(download)) throw new Error('无法识别 ACP 原始二进制格式。');
      await mkdir(dirname(command), { recursive: true, mode: 0o700 });
      await rename(download, command);
    }
    const executable = await containedExecutable(root, command);
    await chmod(executable, 0o700);
    return executable;
  } finally { await rm(download, { force: true }); }
}
