import { packager } from '@electron/packager';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

if (process.platform !== 'darwin') throw new Error('此打包命令用于本机 macOS。');
const { version, productName } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const paths = await packager({
  dir: '.', name: productName, platform: 'darwin', arch: process.arch,
  out: join('release', version), overwrite: true, asar: false, prune: true,
  appBundleId: 'local.agent-workbench.desktop',
  appCategoryType: 'public.app-category.developer-tools',
  ignore: [/^\/src(?:\/|$)/, /^\/scripts(?:\/|$)/, /^\/docs(?:\/|$)/, /^\/tsconfig\.json$/, /^\/vite\.config\.ts$/, /^\/research(?:\/|$)/],
});
for (const path of paths) {
  const app = join(path, `${productName}.app`);
  await promisify(execFile)('codesign', ['--force', '--deep', '--sign', '-', app]);
  await promisify(execFile)('codesign', ['--verify', '--deep', '--strict', app]);
  process.stdout.write(`${path}\n`);
}
