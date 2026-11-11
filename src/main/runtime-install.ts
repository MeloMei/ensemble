import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import type { RuntimeInstall } from '../shared/types';
import { signalProcessTree } from './providers/process-tree';

const recipes = [
  { providerId: 'codex', manager: 'npm', packageName: '@openai/codex', binary: 'codex' },
  { providerId: 'pi', manager: 'npm', packageName: '@earendil-works/pi-coding-agent', binary: 'pi' },
  { providerId: 'gemini', manager: 'npm', packageName: '@google/gemini-cli', binary: 'gemini' },
  { providerId: 'claude', manager: 'brew', packageName: 'claude-code', binary: 'claude' },
] as const;

type InstallResult = Pick<RuntimeInstall, 'phase' | 'problem'>;
interface ActiveInstall { providerId: string; controller: AbortController; done: Promise<void> }

async function executable(paths: string[]) {
  for (const path of new Set(paths)) {
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return path;
    } catch { /* Try the next installation path. */ }
  }
}

export function systemExecutable(name: string, fallback: string[] = []) {
  const paths = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute).map(directory => join(directory, name));
  return executable([...paths, ...fallback]);
}

export function runInstaller(command: string, args: string[], cwd: string, signal: AbortSignal, env?: NodeJS.ProcessEnv) {
  return new Promise<'ok' | 'install' | 'timeout'>(resolve => {
    if (signal.aborted) { resolve('install'); return; }
    const child = spawn(command, args, { cwd, env, stdio: 'ignore', shell: false, detached: true });
    let timedOut = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try { signalProcessTree(child, signal); }
      catch { try { child.kill(signal); } catch {} }
    };
    const stop = () => {
      if (force) return;
      kill('SIGTERM');
      force = setTimeout(() => kill('SIGKILL'), 2000);
    };
    const timeout = setTimeout(() => { timedOut = true; stop(); }, 5 * 60_000);
    const finish = (code: number | null) => {
      clearTimeout(timeout); clearTimeout(force);
      signal.removeEventListener('abort', stop);
      if (timedOut || signal.aborted) kill('SIGKILL');
      resolve(timedOut ? 'timeout' : code === 0 ? 'ok' : 'install');
    };
    signal.addEventListener('abort', stop, { once: true });
    child.once('error', () => finish(null));
    child.once('close', finish);
  });
}

export class RuntimeInstaller {
  private readonly results = new Map<string, InstallResult>();
  private active?: ActiveInstall;

  constructor(private readonly dataPath: string, private readonly detect: (providerId: string) => Promise<boolean>) {}

  private supported() {
    if (process.platform === 'darwin') return recipes;
    return process.platform === 'linux' ? recipes.filter(item => item.manager === 'npm') : [];
  }

  private prefix(providerId: string) { return join(this.dataPath, 'installed-runtimes', providerId); }

  async managedBinary(providerId: string) {
    const recipe = this.supported().find(item => item.providerId === providerId && item.manager === 'npm');
    return recipe ? executable([join(this.prefix(providerId), 'bin', recipe.binary)]) : undefined;
  }

  private async manager(name: 'npm' | 'brew') {
    if (name === 'brew') return systemExecutable('brew', ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']);
    return await systemExecutable('node') ? systemExecutable('npm') : undefined;
  }

  async list(): Promise<RuntimeInstall[]> {
    const supported = this.supported();
    if (!supported.length) return [];
    const [npm, brew] = await Promise.all([this.manager('npm'), process.platform === 'darwin' ? this.manager('brew') : undefined]);
    return supported.map(({ providerId, manager, packageName }) => ({ providerId, manager, packageName,
      prerequisiteMet: Boolean(manager === 'npm' ? npm : brew), ...(this.results.get(providerId) ?? { phase: 'idle' }) }));
  }

  async install(providerId: string) {
    const recipe = this.supported().find(item => item.providerId === providerId);
    if (!recipe) throw new Error('This runtime does not have an installer for this platform');
    if (this.active) throw new Error('Wait for the current runtime installation to finish');
    const controller = new AbortController();
    this.results.set(providerId, { phase: 'installing' });
    const done = this.run(recipe, controller.signal);
    this.active = { providerId, controller, done };
    try { await done; }
    finally { this.active = undefined; }
  }

  private async run(recipe: (typeof recipes)[number], signal: AbortSignal) {
    const { providerId, packageName, manager } = recipe;
    try {
      const command = await this.manager(manager);
      if (!command) { this.results.set(providerId, { phase: 'failed', problem: 'install' }); return; }
      const prefix = this.prefix(providerId);
      await mkdir(prefix, { recursive: true, mode: 0o700 });
      const args = manager === 'npm' ? ['install', '--global', '--prefix', prefix, '--registry=https://registry.npmjs.org/',
        '--ignore-scripts', '--no-audit', '--no-fund', packageName] : ['install', '--cask', packageName];
      const result = await runInstaller(command, args, prefix, signal);
      if (signal.aborted) { this.results.set(providerId, { phase: 'cancelled' }); return; }
      if (result !== 'ok') { this.results.set(providerId, { phase: 'failed', problem: result }); return; }
      this.results.set(providerId, { phase: 'detecting' });
      const available = await this.detect(providerId).catch(() => false);
      this.results.set(providerId, available ? { phase: 'complete' } : { phase: 'failed', problem: 'detect' });
    } catch {
      this.results.set(providerId, signal.aborted ? { phase: 'cancelled' } : { phase: 'failed', problem: 'install' });
    }
  }

  cancel(providerId: string) {
    if (this.active?.providerId !== providerId || this.results.get(providerId)?.phase !== 'installing') return;
    this.results.set(providerId, { phase: 'cancelling' });
    this.active.controller.abort();
  }

  async shutdown() {
    const active = this.active;
    if (!active) return;
    this.cancel(active.providerId);
    await active.done;
  }
}
