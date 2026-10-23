import { packager } from '@electron/packager';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
import { mkdtemp, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

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
const archive = join(releaseDirectory, `${productName}-${version}-macOS-${process.arch}.zip`);
const temporaryArchive = `${archive}.${basename(temporaryDirectory)}.tmp`;
try {
  const paths = await packager({
    dir: projectRoot, name: productName, platform: 'darwin', arch: process.arch,
    out: temporaryDirectory, overwrite: true, asar: false, prune: true,
    appBundleId: 'local.agent-workbench.desktop',
    appCategoryType: 'public.app-category.developer-tools',
    ignore: [nonRuntimeEntries],
  });
  await mkdir(releaseDirectory, { recursive: true });
  for (const path of paths) {
    const app = join(path, `${productName}.app`);
    await run('codesign', ['--force', '--deep', '--sign', '-', app]);
    await run('codesign', ['--verify', '--deep', '--strict', app]);
    await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, temporaryArchive]);
    await rename(temporaryArchive, archive);
    process.stdout.write(`${archive}\n`);
  }
} finally {
  await Promise.all([
    rm(temporaryDirectory, { recursive: true, force: true }),
    rm(temporaryArchive, { force: true }),
  ]);
}
