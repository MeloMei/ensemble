import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const source = fileURLToPath(new URL('../native/notifications/', import.meta.url));
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const run = promisify(execFile);

export async function buildMacNotifications({ destination, arch = process.arch, appVersion = version }) {
  const target = { arm64: 'arm64', x64: 'x86_64' }[arch];
  if (process.platform !== 'darwin' || !target) throw new Error('Ensemble Notifications requires macOS arm64 or x64.');
  const contents = join(destination, 'Contents');
  const executable = join(contents, 'MacOS', 'EnsembleNotifications');
  await mkdir(join(contents, 'MacOS'), { recursive: true });
  const plist = await readFile(join(source, 'Info.plist'), 'utf8');
  await writeFile(join(contents, 'Info.plist'), plist.replaceAll('__VERSION__', appVersion));
  await run('xcrun', ['--sdk', 'macosx', 'swiftc', '-O', '-parse-as-library', '-target', `${target}-apple-macos12.0`,
    '-framework', 'UserNotifications', '-framework', 'AppKit', join(source, 'main.swift'), '-o', executable]);
  await run('/usr/bin/codesign', ['--force', '--sign', '-', destination]);
  await run('/usr/bin/codesign', ['--verify', '--strict', destination]);
  return destination;
}
