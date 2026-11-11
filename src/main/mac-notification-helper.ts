import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { SessionAttentionOpen } from '../shared/types';
import { notificationLink } from './notification-link';

export interface BackgroundNotice { id: string; title: string; body: string; silent: boolean; dataPath: string; target: SessionAttentionOpen }
export interface BackgroundNotificationDriver {
  deliver(notice: BackgroundNotice, signal: AbortSignal): Promise<void>;
}

const response = z.object({
  authorization: z.enum(['authorized', 'denied', 'not-determined', 'unsupported']),
}).strict();

type Request = { operation: 'status' | 'authorize' } | { operation: 'deliver'; notice: Omit<BackgroundNotice, 'target'> & { link: string } };

export class MacNotificationHelper implements BackgroundNotificationDriver {
  constructor(private readonly executable: string) {}

  status(signal?: AbortSignal) { return this.run({ operation: 'status' }, signal); }
  authorize(signal?: AbortSignal) { return this.run({ operation: 'authorize' }, signal); }
  async deliver({ target, ...notice }: BackgroundNotice, signal: AbortSignal): Promise<void> {
    await this.run({ operation: 'deliver', notice: { ...notice, link: notificationLink(target) } }, signal);
  }

  private run(request: Request, signal?: AbortSignal): Promise<z.infer<typeof response>['authorization']> {
    return new Promise((resolveReply, reject) => {
      signal?.throwIfAborted();
      const input = JSON.stringify(request);
      if (Buffer.byteLength(input) > 8192) throw new Error('Ensemble Notifications input exceeds its limit.');
      const child = spawn(this.executable, ['--stdio'], { stdio: ['pipe', 'pipe', 'ignore'], shell: false, signal, killSignal: 'SIGKILL' });
      const buffers: Buffer[] = [];
      let bytes = 0;
      let failure = false;
      const stop = () => { failure = true; child.kill('SIGKILL'); };
      const timer = setTimeout(stop, request.operation === 'authorize' ? 120_000 : 5000);
      timer.unref();
      child.on('error', () => { failure = true; });
      child.stdin.on('error', stop);
      child.stdout.on('error', stop);
      child.stdout.on('data', (chunk: Buffer) => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > 4096) stop();
        else buffers.push(chunk);
      });
      child.once('close', code => {
        clearTimeout(timer);
        if (failure || code !== 0) { reject(new Error('Ensemble Notifications could not complete the request.')); return; }
        try { resolveReply(response.parse(JSON.parse(Buffer.concat(buffers).toString('utf8'))).authorization); }
        catch { reject(new Error('Ensemble Notifications returned an invalid reply.')); }
      });
      child.stdin.end(input);
    });
  }
}

export function bundledMacNotificationHelper(mainDirectory: string): MacNotificationHelper | undefined {
  if (process.platform !== 'darwin') return;
  const contents = resolve(mainDirectory, '../../../..');
  if (basename(contents) !== 'Contents' || !dirname(contents).endsWith('.app')
    || mainDirectory !== join(contents, 'Resources', 'app', 'dist', 'main')) return;
  const executable = join(contents, 'Helpers', 'Ensemble Notifications.app', 'Contents', 'MacOS', 'EnsembleNotifications');
  if (existsSync(executable)) return new MacNotificationHelper(executable);
}
