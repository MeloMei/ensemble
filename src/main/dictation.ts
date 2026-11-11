import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { dictationHelperErrors, type DictationError, type DictationEvent, type DictationUnavailable } from '../shared/dictation';

const OUTPUT_LIMIT = 64 * 1024;
const SESSION_TIMEOUT = 120_000;
const STOP_TIMEOUT = 8_000;
const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }).strict(),
  z.object({ type: z.literal('final'), text: z.string().trim().min(1) }).strict(),
  z.object({ type: z.literal('error'), reason: z.enum(dictationHelperErrors) }).strict(),
]);

type Helper = ChildProcessByStdio<Writable, Readable, null>;
type HelperMessage = z.infer<typeof messageSchema>;
interface Recording {
  id: string;
  child: Helper;
  publish: (event: DictationEvent) => void;
  phase: 'starting' | 'recording' | 'stopping' | 'awaitingInsert' | 'releasing';
  closed: boolean;
  terminal?: Extract<HelperMessage, { type: 'final' | 'error' }>;
  timer?: ReturnType<typeof setTimeout>;
}

export function dictationHelperPath(executable: string): string {
  return join(dirname(executable), '..', 'Helpers', 'Ensemble Dictation.app', 'Contents', 'MacOS', 'EnsembleDictation');
}

export class Dictation {
  private current?: Recording;

  constructor(private readonly helper: string | undefined) {}

  unavailable(): DictationUnavailable | undefined {
    if (process.platform !== 'darwin') return 'platform';
    if (!this.helper) return 'helperMissing';
    try { accessSync(this.helper, constants.X_OK); }
    catch { return 'helperMissing'; }
  }

  start(id: string, locale: string, publish: Recording['publish']): DictationError | undefined {
    const unavailable = this.unavailable();
    if (unavailable) return unavailable;
    if (this.current) return 'busy';
    let language: string;
    try { language = new Intl.Locale(locale).maximize().baseName; }
    catch { return 'language'; }

    let child: Helper;
    try { child = spawn(this.helper!, [language], { stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { return 'failed'; }
    const recording: Recording = { id, child, publish, phase: 'starting', closed: false };
    this.current = recording;
    this.arm(recording, SESSION_TIMEOUT);

    let bytes = 0;
    let pending = Buffer.alloc(0);
    child.stdout.on('data', (chunk: Buffer) => {
      if (recording.phase === 'releasing') return;
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) {
        this.fail(recording, 'failed');
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      let newline: number;
      while ((newline = pending.indexOf(0x0a)) >= 0) {
        const line = pending.toString('utf8', 0, newline);
        pending = pending.subarray(newline + 1);
        if (!this.receive(recording, line)) {
          this.fail(recording, 'failed');
          return;
        }
      }
    });
    child.stdin.on('error', () => {
      // A helper that finalized naturally may close stdin before its result arrives on stdout.
    });
    child.on('error', () => this.fail(recording, 'failed'));
    child.once('close', code => {
      recording.closed = true;
      if (recording.phase === 'releasing') {
        if (this.current === recording) this.current = undefined;
        return;
      }
      if (code !== 0 || pending.length || !recording.terminal) { this.fail(recording, 'failed'); return; }
      const result = recording.terminal;
      if (result.type === 'error') this.fail(recording, result.reason);
      else if (recording.phase === 'stopping') this.insert(recording, result.text);
      else {
        recording.phase = 'awaitingInsert';
        this.arm(recording, SESSION_TIMEOUT);
        publish({ id, type: 'awaitingInsert' });
      }
    });
  }

  stop(id: string): void {
    const recording = this.current;
    if (!recording || recording.id !== id) return;
    if (recording.phase === 'awaitingInsert' && recording.terminal?.type === 'final') {
      this.insert(recording, recording.terminal.text);
    } else if (recording.phase === 'recording') {
      recording.phase = 'stopping';
      this.arm(recording, STOP_TIMEOUT);
      if (!recording.terminal) recording.child.stdin.write('stop\n');
    }
  }

  cancel(id?: string): void {
    const recording = this.current;
    if (!recording || recording.phase === 'releasing' || (id !== undefined && id !== recording.id)) return;
    this.release(recording);
    recording.publish({ id: recording.id, type: 'cancelled' });
  }

  private receive(recording: Recording, line: string): boolean {
    if (recording.terminal) return false;
    let data: unknown;
    try { data = JSON.parse(line); }
    catch { return false; }
    const message = messageSchema.safeParse(data);
    if (!message.success) return false;
    if (message.data.type === 'ready') {
      if (recording.phase !== 'starting') return false;
      recording.phase = 'recording';
      this.arm(recording, SESSION_TIMEOUT);
      recording.publish({ id: recording.id, type: 'recording' });
    } else {
      if (message.data.type === 'final' && recording.phase === 'starting') return false;
      recording.terminal = message.data;
    }
    return true;
  }

  private arm(recording: Recording, milliseconds: number): void {
    clearTimeout(recording.timer);
    recording.timer = setTimeout(() => this.fail(recording, 'timeout'), milliseconds);
    recording.timer.unref();
  }

  private insert(recording: Recording, text: string): void {
    this.release(recording);
    recording.publish({ id: recording.id, type: 'final', text });
  }

  private fail(recording: Recording, reason: DictationError): void {
    if (recording.phase === 'releasing') return;
    this.release(recording);
    recording.publish({ id: recording.id, type: 'error', reason });
  }

  private release(recording: Recording): void {
    if (recording.phase === 'releasing') return;
    recording.phase = 'releasing';
    recording.terminal = undefined;
    clearTimeout(recording.timer);
    if (recording.closed) this.current = undefined;
    else {
      recording.child.kill('SIGKILL');
      recording.child.stdin.destroy();
    }
  }
}
