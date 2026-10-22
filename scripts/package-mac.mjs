import { packager } from '@electron/packager';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('此打包命令用于本机 macOS。');
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const { version, productName } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const runtimeEntries = [
  'dist', 'bin', 'node_modules', 'licenses', 'package.json',
  'LICENSE', 'LICENSE.zh-CN.md', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.zh-CN.md',
];
const nonRuntimeEntries = new RegExp(`^/(?!(${runtimeEntries.map(entry => entry.replaceAll('.', '\\.')).join('|')})(/|$))`);
const paths = await packager({
  dir: projectRoot, name: productName, platform: 'darwin', arch: process.arch,
  out: join(projectRoot, 'release', version), overwrite: true, asar: false, prune: true,
  appBundleId: 'local.agent-workbench.desktop',
  appCategoryType: 'public.app-category.developer-tools',
  ignore: [nonRuntimeEntries],
});
for (const path of paths) {
  const app = join(path, `${productName}.app`);
  await promisify(execFile)('codesign', ['--force', '--deep', '--sign', '-', app]);
  await promisify(execFile)('codesign', ['--verify', '--deep', '--strict', app]);
  process.stdout.write(`${path}\n`);
}
