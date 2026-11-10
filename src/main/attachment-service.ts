import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import type { PromptAttachment } from '../shared/types';
import type { LoadedPromptAttachment } from './providers/types';
import { sanitizeAttachmentName } from './vendor/orca/attachment-name';
import { ATTACHMENT_LIMITS } from '../shared/prompt-attachments';

const TEXT_EXTENSIONS = new Set(['', '.txt', '.md', '.mdx', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.xml', '.html', '.htm', '.css', '.scss', '.less', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.rs', '.go', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.sh', '.bash', '.zsh', '.sql', '.csv', '.log', '.ini', '.conf', '.env', '.gitignore', '.dockerignore']);
const IMAGE_EXTENSIONS = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'], ['.webp', 'image/webp']]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const attachmentMetadataSchema = z.object({
  id: z.string().min(1).max(200), name: z.string().min(1).max(300), kind: z.enum(['image', 'text']),
  mimeType: z.string().min(1).max(100), size: z.number().int().min(0).max(20_000_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), ownedPath: z.string().min(1).max(4096),
}).strict();

function hash(data: Buffer): string { return createHash('sha256').update(data).digest('hex'); }
function imageMime(data: Buffer): string | undefined {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && data.subarray(12, 16).toString() === 'IHDR') return 'image/png';
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (data.length >= 10 && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString())) return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return undefined;
}

async function readRegularFile(file: string, limit: number): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('附件必须是普通文件。');
    if (info.size > limit) throw new Error(`附件超过 ${limit / 1024 / 1024} MiB 限制。`);
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > limit) throw new Error('附件在读取时超过大小限制。');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

function classify(name: string, data: Buffer): Pick<LoadedPromptAttachment, 'kind' | 'mimeType' | 'text'> {
  const extension = path.extname(name).toLowerCase();
  const mimeType = imageMime(data);
  if (IMAGE_EXTENSIONS.has(extension) || mimeType) {
    if (!mimeType || (IMAGE_EXTENSIONS.has(extension) && IMAGE_EXTENSIONS.get(extension) !== mimeType)) throw new Error('图片格式与内容不一致。');
    if (data.length > ATTACHMENT_LIMITS.imageBytes) throw new Error(`图片超过 ${ATTACHMENT_LIMITS.imageBytes / 1024 / 1024} MiB 限制。`);
    return { kind: 'image', mimeType };
  }
  if (!TEXT_EXTENSIONS.has(extension)) throw new Error('当前附件只支持 PNG、JPEG、GIF、WebP 图片和 UTF-8 文本/代码文件。');
  if (data.length > ATTACHMENT_LIMITS.textBytes) throw new Error(`文本附件超过 ${ATTACHMENT_LIMITS.textBytes / 1024 / 1024} MiB 限制。`);
  if (data.some(byte => byte === 0 || (byte < 32 && ![9, 10, 12, 13].includes(byte)))) throw new Error('二进制文件不能作为文本附件。');
  try { return { kind: 'text', mimeType: 'text/plain', text: new TextDecoder('utf-8', { fatal: true }).decode(data) }; }
  catch { throw new Error('文本附件必须是有效的 UTF-8 文件。'); }
}

export class AttachmentService {
  private root: string;
  constructor(rootDir: string) { this.root = path.resolve(rootDir); }

  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('附件存储目录不能是符号链接。');
    this.root = await realpath(this.root);
  }

  private async writeOwned(name: string, data: Buffer, format: Pick<PromptAttachment, 'kind' | 'mimeType'>): Promise<PromptAttachment> {
    const id = randomUUID();
    const directory = path.join(this.root, id);
    await mkdir(directory, { mode: 0o700 });
    const ownedPath = path.join(directory, name);
    try { await writeFile(ownedPath, data, { mode: 0o600, flag: 'wx' }); }
    catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    return { id, name, kind: format.kind, mimeType: format.mimeType, size: data.length, sha256: hash(data), ownedPath };
  }

  async importImage(fileName: string, bytes: Uint8Array): Promise<PromptAttachment> {
    if (!bytes.length || bytes.length > ATTACHMENT_LIMITS.imageBytes) throw new Error('图片大小超出附件限制。');
    const name = sanitizeAttachmentName(path.basename(fileName));
    const data = Buffer.from(bytes);
    const format = classify(name, data);
    if (format.kind !== 'image') throw new Error('剪贴板中没有支持的图片。');
    await this.initialize();
    return this.writeOwned(name, data, format);
  }

  async importFiles(files: string[]): Promise<PromptAttachment[]> {
    if (!files.length || files.length > ATTACHMENT_LIMITS.count) throw new Error(`每次请选择 1 到 ${ATTACHMENT_LIMITS.count} 个附件。`);
    await this.initialize();
    const imported: PromptAttachment[] = [];
    let total = 0;
    try {
      for (const file of files) {
        if (!path.isAbsolute(file)) throw new Error('附件路径必须是绝对路径。');
        const data = await readRegularFile(file, ATTACHMENT_LIMITS.imageBytes);
        const name = sanitizeAttachmentName(path.basename(file));
        const format = classify(name, data);
        total += data.length;
        if (total > ATTACHMENT_LIMITS.totalBytes) throw new Error(`附件总大小超过 ${ATTACHMENT_LIMITS.totalBytes / 1024 / 1024} MiB 限制。`);
        imported.push(await this.writeOwned(name, data, format));
      }
      return imported;
    } catch (error) {
      await Promise.all(imported.map(item => rm(path.dirname(item.ownedPath), { recursive: true, force: true })));
      throw error;
    }
  }

  async load(metadata: PromptAttachment[] = []): Promise<LoadedPromptAttachment[]> {
    if (metadata.length > ATTACHMENT_LIMITS.count) throw new Error(`每轮最多 ${ATTACHMENT_LIMITS.count} 个附件。`);
    if (!metadata.length) return [];
    await this.initialize();
    const result: LoadedPromptAttachment[] = [];
    const seen = new Set<string>();
    let total = 0;
    for (const attachment of metadata) {
      if (!UUID.test(attachment.id) || seen.has(attachment.id) || attachment.name !== sanitizeAttachmentName(attachment.name)) throw new Error('附件标识或名称无效。');
      seen.add(attachment.id);
      const expected = path.join(this.root, attachment.id, attachment.name);
      if (attachment.ownedPath !== expected || await realpath(expected) !== expected) throw new Error('附件不属于当前工作台存储。');
      const data = await readRegularFile(expected, ATTACHMENT_LIMITS.imageBytes);
      const actual = classify(attachment.name, data);
      total += data.length;
      if (total > ATTACHMENT_LIMITS.totalBytes) throw new Error(`附件总大小超过 ${ATTACHMENT_LIMITS.totalBytes / 1024 / 1024} MiB 限制。`);
      if (attachment.size !== data.length || attachment.sha256 !== hash(data) || attachment.kind !== actual.kind || attachment.mimeType !== actual.mimeType) throw new Error('附件内容已变化，请重新选择。');
      result.push({ ...attachment, ...actual, data });
    }
    return result;
  }
}
