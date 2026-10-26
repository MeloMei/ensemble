import { packager } from '@electron/packager';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fileSha256, macReleaseAssets } from './mac-release-assets.mjs';

if (process.platform !== 'darwin') throw new Error('此打包命令用于本机 macOS。');
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const { version, productName } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const runtimeEntries = [
  'dist', 'bin', 'node_modules', 'licenses', 'package.json',
  'LICENSE', 'LICENSE.zh-CN.md', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.zh-CN.md',
];
const nonRuntimeEntries = new RegExp(`^/(?!(${runtimeEntries.map(entry => entry.replaceAll('.', '\\.')).join('|')})(/|$))`);
const run = promisify(execFile);
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ensemble-package-'));
const releaseDirectory = join(projectRoot, 'release', version);
const [archiveName, imageName] = macReleaseAssets(version, process.arch);
const archive = join(releaseDirectory, archiveName);
const temporaryArchive = `${archive}.${basename(temporaryDirectory)}.tmp`;
const temporaryImage = join(releaseDirectory, `.${basename(temporaryDirectory)}.dmg`);
const temporaryChecksums = join(releaseDirectory, `.${basename(temporaryDirectory)}.SHA256SUMS`);
try {
  const paths = await packager({
    dir: projectRoot, name: productName, platform: 'darwin', arch: process.arch,
    out: temporaryDirectory, overwrite: true, asar: false, prune: true,
    appBundleId: 'local.agent-workbench.desktop',
    appCategoryType: 'public.app-category.developer-tools',
    ignore: [nonRuntimeEntries],
  });
  if (paths.length !== 1) throw new Error('Expected exactly one macOS application.');
  await mkdir(releaseDirectory, { recursive: true });
  const app = join(paths[0], `${productName}.app`);
  await run('codesign', ['--force', '--deep', '--sign', '-', app]);
  await run('codesign', ['--verify', '--deep', '--strict', app]);
  await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, temporaryArchive]);
  const imageRoot = join(temporaryDirectory, 'image');
  await mkdir(imageRoot);
  await run('ditto', [app, join(imageRoot, `${productName}.app`)]);
  await symlink('/Applications', join(imageRoot, 'Applications'));
  await run('hdiutil', ['create', '-volname', productName, '-srcfolder', imageRoot, '-format', 'UDZO', '-fs', 'HFS+', temporaryImage]);
  await run('hdiutil', ['verify', temporaryImage]);
  const checksums = `${await fileSha256(temporaryArchive)}  ${archiveName}\n${await fileSha256(temporaryImage)}  ${imageName}\n`;
  await writeFile(temporaryChecksums, checksums);
  for (const [temporary, name] of [[temporaryArchive, archiveName], [temporaryImage, imageName], [temporaryChecksums, 'SHA256SUMS']]) {
    const destination = join(releaseDirectory, name);
    await rename(temporary, destination);
    process.stdout.write(`${destination}\n`);
  }
} finally {
  await Promise.all([
    rm(temporaryDirectory, { recursive: true, force: true }),
    rm(temporaryArchive, { force: true }),
    rm(temporaryImage, { force: true }),
    rm(temporaryChecksums, { force: true }),
  ]);
}
