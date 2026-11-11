import type { WorkspaceFilePath } from './types';

export type WorkspaceFileMutation =
  | { action: 'create'; directory: string; kind: 'file' | 'directory'; name: string }
  | { action: 'rename'; path: string; kind: 'file' | 'directory'; name: string }
  | { action: 'delete'; path: string; kind: 'file' | 'directory' };

export function pathContainsFile(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

export function matchesWorkspaceFile(target: WorkspaceFilePath, file: WorkspaceFilePath, sameWorkspace: boolean): boolean {
  return (sameWorkspace && pathContainsFile(target.path, file.path))
    || (!!target.realPath && !!file.realPath && pathContainsFile(target.realPath, file.realPath));
}

export function workspaceFileParent(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}
