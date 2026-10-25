import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import * as pty from '@lydell/node-pty';
import type { TerminalInfo } from '../shared/types';
import type { TerminalOutputEvent } from '../shared/backend';
import { TerminalOutputBuffer, TerminalOutputCoalescer } from './terminal-output';

interface ManagedTerminal {
  info: TerminalInfo;
  process: pty.IPty;
  disposables: pty.IDisposable[];
  forceTimer?: ReturnType<typeof setTimeout>;
  exited: Promise<void>;
  resolveExit(): void;
  output: TerminalOutputCoalescer;
  history: TerminalOutputBuffer;
}

function signalTerminal(terminal: ManagedTerminal, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') { terminal.process.kill(); return; }
  try { process.kill(-terminal.process.pid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    if (terminal.info.status === 'running') terminal.process.kill(signal);
  }
}

export class TerminalManager {
  private readonly terminals = new Map<string, ManagedTerminal>();
  private changeTimer?: ReturnType<typeof setTimeout>;
  private shuttingDown = false;

  constructor(private readonly onChange: () => void, private readonly onOutput: (event: TerminalOutputEvent) => void = () => {}) {}

  private changed(): void {
    if (this.shuttingDown || this.changeTimer) return;
    this.changeTimer = setTimeout(() => { this.changeTimer = undefined; this.onChange(); }, 32);
  }

  create(workspaceId: string, cwd: string): TerminalInfo {
    if (this.shuttingDown) throw new Error('Terminals are shutting down');
    const directory = realpathSync(cwd);
    if (!statSync(directory).isDirectory()) throw new Error('Terminal directory is not a directory');
    const shell = process.env.SHELL || (process.platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : '/bin/zsh');
    const child = pty.spawn(shell, process.platform === 'win32' ? [] : ['-l'], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: directory,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    const info: TerminalInfo = { id: randomUUID(), workspaceId, title: path.basename(shell), status: 'running', exitCode: null, output: '', outputOffset: 0 };
    let resolveExit: () => void = () => {};
    const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
    const history = new TerminalOutputBuffer();
    const output = new TerminalOutputCoalescer(info.id, this.onOutput, data => history.append(data));
    const terminal: ManagedTerminal = { info, process: child, disposables: [], exited, resolveExit, output, history };
    this.terminals.set(info.id, terminal);
    terminal.disposables.push(child.onData((data) => {
      terminal.output.append(data);
    }));
    terminal.disposables.push(child.onExit(({ exitCode, signal }) => {
      clearTimeout(terminal.forceTimer);
      terminal.info.status = 'exited';
      terminal.info.exitCode = signal ? 128 + signal : exitCode;
      terminal.output.dispose();
      try { signalTerminal(terminal, 'SIGKILL'); } catch {}
      for (const disposable of terminal.disposables) disposable.dispose();
      terminal.disposables = [];
      terminal.resolveExit();
      this.changed();
    }));
    this.changed();
    return { ...info };
  }

  snapshot(): TerminalInfo[] { return [...this.terminals.values()].map(({ info, history }) => ({ ...info, ...history.snapshot() })); }
  metadata(): TerminalInfo[] { return [...this.terminals.values()].map(({ info }) => ({ ...info, output: '', outputOffset: 0 })); }
  get(id: string): TerminalInfo {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error('Terminal does not exist');
    return { ...terminal.info, ...terminal.history.snapshot() };
  }

  private running(id: string): ManagedTerminal {
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.info.status !== 'running') throw new Error('Terminal is not running');
    return terminal;
  }

  write(id: string, data: string): void {
    if (typeof data !== 'string' || Buffer.byteLength(data) > 64 * 1024) throw new Error('Terminal input exceeds 64 KiB');
    this.running(id).process.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 1000) {
      throw new Error('Invalid terminal dimensions');
    }
    this.running(id).process.resize(cols, rows);
  }

  stop(id: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.info.status !== 'running' || terminal.forceTimer) return;
    signalTerminal(terminal, 'SIGTERM');
    terminal.forceTimer = setTimeout(() => {
      terminal.forceTimer = undefined;
      if (terminal.info.status === 'running') {
        try { signalTerminal(terminal, 'SIGKILL'); } catch { this.changed(); }
      }
    }, 500);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    clearTimeout(this.changeTimer);
    this.changeTimer = undefined;
    const pending = [...this.terminals.values()].filter((terminal) => terminal.info.status === 'running');
    for (const terminal of pending) this.stop(terminal.info.id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(pending.map((terminal) => terminal.exited)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Terminal processes did not exit during shutdown')), 2000);
      })]);
    } finally {
      clearTimeout(timer);
      for (const terminal of this.terminals.values()) terminal.output.dispose();
    }
  }
}
