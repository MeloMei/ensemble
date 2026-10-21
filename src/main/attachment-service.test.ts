import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AttachmentService, ATTACHMENT_LIMITS } from './attachment-service';

test('attachment store owns bounded real bytes and refuses changed metadata, links and unsupported content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-attachment-'));
  const root = join(directory, 'owned');
  const store = new AttachmentService(root);
  try {
    const text = join(directory, 'note.txt');
    const image = join(directory, 'screen.png');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
    await writeFile(text, '附件真实文字'); await writeFile(image, png);
    const metadata = await store.importFiles([text, image]);
    await writeFile(text, 'source changed');
    const loaded = await store.load(metadata);
    assert.equal(loaded[0].text, '附件真实文字');
    assert.deepEqual(loaded[1].data, png); assert.equal(loaded[1].mimeType, 'image/png');
    await assert.rejects(store.load([{ ...metadata[0], ownedPath: text }]), /不属于/);
    await assert.rejects(store.load([{ ...metadata[0], mimeType: 'image/png' }]), /已变化/);
    await assert.rejects(store.load([metadata[0], metadata[0]]), /标识或名称无效/);
    const link = join(directory, 'link.txt'); await symlink(text, link);
    await assert.rejects(store.importFiles([link]));
    const unknown = join(directory, 'report.pdf'); await writeFile(unknown, 'not parsed as a document');
    const before = await readdir(root);
    await assert.rejects(store.importFiles([text, unknown]), /只支持/);
    assert.deepEqual(await readdir(root), before);
    const large = join(directory, 'large.txt'); await writeFile(large, Buffer.alloc(ATTACHMENT_LIMITS.textBytes + 1, 65));
    await assert.rejects(store.importFiles([large]), /1 MiB/);
    const malformed = join(directory, 'invalid.txt'); await writeFile(malformed, Buffer.from([255, 254]));
    await assert.rejects(store.importFiles([malformed]), /UTF-8/);
    const disguised = join(directory, 'fake.png'); await writeFile(disguised, 'text');
    await assert.rejects(store.importFiles([disguised]), /格式与内容/);
    await writeFile(metadata[0].ownedPath, 'tampered');
    await assert.rejects(store.load([metadata[0]]), /已变化/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
