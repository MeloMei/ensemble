import { getSystemErrorName } from 'node:util';
import type { KoffiFunc } from 'koffi';

type RenameCall = (source: string, target: string) => Promise<number>;
let renameCall: Promise<RenameCall> | undefined;

async function loadRename(): Promise<RenameCall> {
  const { default: koffi } = await import('koffi');
  const errno = <Args extends unknown[]>(call: KoffiFunc<(...args: Args) => number>, ...args: Args) => new Promise<number>((resolve, reject) => {
    call.async(...args, (error, result) => error ? reject(error) : resolve(result === 0 ? 0 : koffi.errno()));
  });

  if (process.platform === 'darwin') {
    const rename = koffi.load('/usr/lib/libSystem.B.dylib').func('int renamex_np(const char *source, const char *target, unsigned int flags)');
    const RENAME_EXCL = 0x00000004;
    return (source, target) => errno(rename, source, target, RENAME_EXCL);
  }
  if (process.platform === 'linux') {
    const rename = koffi.load(null).func('int renameat2(int sourceDir, const char *source, int targetDir, const char *target, unsigned int flags)');
    const AT_FDCWD = -100;
    const RENAME_NOREPLACE = 1;
    return (source, target) => errno(rename, AT_FDCWD, source, AT_FDCWD, target, RENAME_NOREPLACE);
  }
  throw new Error('Exclusive rename is unavailable on this platform');
}

export async function renameExclusive(source: string, target: string): Promise<void> {
  const rename = await (renameCall ??= loadRename());
  const errno = await rename(source, target);
  if (!errno) return;
  const code = getSystemErrorName(-errno);
  throw Object.assign(new Error(code === 'EEXIST' ? 'An item with that name already exists' : `Could not rename the item (${code})`), { code });
}
