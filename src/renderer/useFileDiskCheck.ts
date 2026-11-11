import { useLayoutEffect } from 'react';
import type { FileContent } from '../shared/types';
import type { FileDraftStore } from './file-drafts';

const checkInterval = 3000;
let checkingDisk = false;

// The desktop disables background throttling, so visibility alone does not exclude minimized windows.
const documentIsActive = () => document.visibilityState === 'visible' && document.hasFocus();

export function useFileDiskCheck(store: FileDraftStore, workspaceId: string, path: string | undefined, busy: () => boolean): void {
  useLayoutEffect(() => {
    if (path === undefined) return;
    let disposed = false;
    let visible = documentIsActive();
    let generation = 0;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (delay = checkInterval) => {
      clearTimeout(timer);
      if (visible) timer = setTimeout(() => void check(), delay);
    };
    const check = async () => {
      const token = generation;
      const expected = store.get(workspaceId, path)?.original;
      if (expected && documentIsActive() && !busy() && !checkingDisk && !store.isSaving(workspaceId, path)) {
        let observation: FileContent | 'missing' | 'unreadable';
        checkingDisk = true;
        try { observation = await window.workbench.readFile(workspaceId, path) ?? 'missing'; }
        catch { observation = 'unreadable'; }
        finally { checkingDisk = false; }
        if (!disposed && token === generation && documentIsActive() && !busy()) store.observeDisk(workspaceId, expected, observation);
      }
      if (!disposed && token === generation) schedule();
    };
    const visibilityChanged = () => {
      const next = documentIsActive();
      if (next === visible) return;
      visible = next;
      generation++;
      schedule(0);
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener('focus', visibilityChanged);
    window.addEventListener('blur', visibilityChanged);
    schedule();
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibilityChanged);
      window.removeEventListener('focus', visibilityChanged);
      window.removeEventListener('blur', visibilityChanged);
    };
  }, [store, workspaceId, path, busy]);
}
