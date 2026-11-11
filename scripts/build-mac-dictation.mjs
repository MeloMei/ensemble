import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const sourceDirectory = fileURLToPath(new URL('../native/dictation/', import.meta.url));
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const run = promisify(execFile);

export const macDictationUsageDescriptions = {
  NSMicrophoneUsageDescription: 'Ensemble uses the microphone when you dictate into a draft.',
  NSSpeechRecognitionUsageDescription: 'Ensemble uses on-device speech recognition to transcribe dictation into a draft.',
};

export async function buildMacDictation({ destination, arch = process.arch, appVersion = version }) {
  if (process.platform !== 'darwin') throw new Error('The dictation helper must be built on macOS.');
  const targetArchitecture = { arm64: 'arm64', x64: 'x86_64' }[arch];
  if (!targetArchitecture) throw new Error(`Unsupported dictation architecture: ${arch}`);
  const contents = join(destination, 'Contents');
  const executableDirectory = join(contents, 'MacOS');
  await mkdir(executableDirectory, { recursive: true });
  let plist = (await readFile(join(sourceDirectory, 'Info.plist'), 'utf8')).replaceAll('__VERSION__', appVersion);
  for (const [key, description] of Object.entries(macDictationUsageDescriptions)) {
    plist = plist.replace(`__${key}__`, description);
  }
  await writeFile(join(contents, 'Info.plist'), plist);
  await run('xcrun', [
    '--sdk', 'macosx', 'swiftc', '-O', '-target', `${targetArchitecture}-apple-macos12.0`,
    '-framework', 'AVFoundation', '-framework', 'Speech', join(sourceDirectory, 'main.swift'),
    '-o', join(executableDirectory, 'EnsembleDictation'),
  ]);
  return destination;
}
