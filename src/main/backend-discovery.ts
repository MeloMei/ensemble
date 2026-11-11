import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const daemonMarkerName = 'backend-daemon';

export async function managedBackend(dataPath: string): Promise<string | undefined> {
  try { return (await readFile(join(dataPath, daemonMarkerName), 'utf8')).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
