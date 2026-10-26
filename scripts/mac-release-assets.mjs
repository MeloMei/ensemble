import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function macReleaseAssets(version, architecture) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Release version must be a stable semantic version.');
  if (!['arm64', 'x64'].includes(architecture)) throw new Error('Unsupported macOS release architecture.');
  const stem = `Ensemble-${version}-macOS-${architecture}`;
  return [`${stem}.zip`, `${stem}.dmg`];
}

export async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

export async function releaseChecksums(directory, names) {
  return (await Promise.all(names.map(async name => `${await fileSha256(join(directory, name))}  ${name}\n`))).join('');
}

export async function verifyReleaseAssets(directory, version, architecture) {
  const names = macReleaseAssets(version, architecture);
  const expected = await releaseChecksums(directory, names);
  if (await readFile(join(directory, 'SHA256SUMS'), 'utf8') !== expected) {
    throw new Error('Release checksums do not match the ZIP and DMG.');
  }
  return [...names, 'SHA256SUMS'];
}
