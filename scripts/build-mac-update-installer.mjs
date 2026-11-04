import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const run = promisify(execFile);

export async function buildMacUpdateInstaller({ destination, arch = process.arch, appVersion = version }) {
  if (process.platform !== 'darwin') throw new Error('The update installer must be built on macOS.');
  const targetArchitecture = { arm64: 'arm64', x64: 'x86_64' }[arch];
  if (!targetArchitecture) throw new Error(`Unsupported installer architecture: ${arch}`);
  const contents = join(destination, 'Contents');
  const executableDirectory = join(contents, 'MacOS');
  const resourceDirectory = join(contents, 'Resources');
  await mkdir(executableDirectory, { recursive: true });
  await mkdir(resourceDirectory, { recursive: true });
  const sourceDirectory = join(projectRoot, 'native', 'update-installer');
  const plist = await readFile(join(sourceDirectory, 'Info.plist'), 'utf8');
  await writeFile(join(contents, 'Info.plist'), plist.replaceAll('__VERSION__', appVersion));
  await copyFile(join(projectRoot, 'bin', 'apply-app-update.sh'), join(resourceDirectory, 'apply-app-update.sh'));
  await run('xcrun', [
    '--sdk', 'macosx', 'swiftc', '-O', '-target', `${targetArchitecture}-apple-macos12.0`,
    '-framework', 'AppKit', join(sourceDirectory, 'main.swift'),
    '-o', join(executableDirectory, 'EnsembleInstaller'),
  ]);
  return destination;
}
