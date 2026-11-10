import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PromptAttachment } from '../shared/types';

const run = promisify(execFile);
export const WINDOW_CAPTURE_SHORTCUT = 'Control+Alt+Space';

export async function captureWindow(importFile: (path: string) => Promise<PromptAttachment[]>, signal: AbortSignal): Promise<PromptAttachment | undefined> {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-window-'));
  const file = join(directory, 'Window Capture.jpg');
  try {
    await run('/usr/sbin/screencapture', ['-i', '-w', '-x', '-t', 'jpg', file], { timeout: 120_000, signal });
    try { await stat(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!signal.aborted) return (await importFile(file))[0];
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
