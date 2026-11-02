import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';

export function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false, windowsHide: true, stdio: 'ignore',
    });
    killer.on('error', () => child.kill());
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

export function watchOutputDrain(child: ChildProcessWithoutNullStreams, onTimeout: () => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  child.once('exit', () => {
    timer = setTimeout(() => {
      try { onTimeout(); }
      finally { child.stdout.destroy(); child.stderr.destroy(); }
    }, 1_000);
  });
  child.once('close', () => clearTimeout(timer));
}
