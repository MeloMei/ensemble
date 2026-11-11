import { createContext } from 'react';

export const WORKSPACE_FILE_DRAG_TYPE = 'application/x-ensemble-workspace-file';

export interface FileReference {
  path: string;
  line?: number;
  endLine?: number;
  column?: number;
}

export interface WorkspaceFileRequest extends FileReference {
  workspaceId: string;
}

export const WorkspaceFileNavigation = createContext<{
  cwd: string;
  open: (reference: FileReference) => void;
  request?: WorkspaceFileRequest;
  consume: (request: WorkspaceFileRequest) => void;
} | null>(null);

const drivePath = /^[a-z]:[\\/]/i;
const urlScheme = /^[a-z][a-z\d+.-]*:/i;

export function workspaceFileReference(value: string, cwd: string, markdownLink = false): FileReference | undefined {
  if (markdownLink) {
    try { value = decodeURIComponent(value); }
    catch { return; }
  }
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return;
  value = value.trim().replace(/^file:\/\/(?:localhost)?(?=\/)/i, '');
  if (drivePath.test(cwd) && /^\/[a-z]:\//i.test(value)) value = value.slice(1);
  if (value.startsWith('//')) return;

  const hash = value.match(/#L([1-9]\d*)(?:-L?([1-9]\d*))?$/i);
  const location = hash ?? value.match(/:([1-9]\d*)(?:(?:-([1-9]\d*))|(?::([1-9]\d*)))?$/);
  const rawPath = location ? value.slice(0, location.index) : value;
  if (!rawPath || (urlScheme.test(rawPath) && !drivePath.test(rawPath))) return;
  if ((!markdownLink && !location) || !/[.\\/]/.test(rawPath)) return;
  if (rawPath.includes('#') || rawPath.includes('?')) return;

  const windows = drivePath.test(cwd);
  let path = windows ? rawPath.replace(/\\/g, '/') : rawPath;
  const root = (windows ? cwd.replace(/\\/g, '/') : cwd).replace(/\/+$/, '');
  if (path.startsWith('/') || drivePath.test(path)) {
    const prefix = `${root}/`;
    const hasRoot = windows ? path.toLowerCase().startsWith(prefix.toLowerCase()) : path.startsWith(prefix);
    if (!hasRoot) return;
    path = path.slice(prefix.length);
  }
  const parts = path.split('/');
  if (parts.includes('..')) return;
  path = parts.filter(part => part && part !== '.').join('/');
  if (!path || urlScheme.test(path)) return;

  if (!location) return { path };
  const line = Number(location[1]);
  const endLine = location[2] === undefined ? undefined : Number(location[2]);
  const column = location[3] === undefined ? undefined : Number(location[3]);
  if (!Number.isSafeInteger(line) || (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < line))
    || (column !== undefined && !Number.isSafeInteger(column))) return;
  return { path, line, endLine, column };
}
