import { isAbsolute, relative, sep } from 'node:path';

export function workspacePathContains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
