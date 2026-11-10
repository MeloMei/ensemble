import { useEffect, useState } from 'react';
import type { WorkspaceFileMatch } from '../shared/types';

export function useWorkspaceFileMatches(workspaceId: string | undefined, query: string | null) {
  const [result, setResult] = useState<{ workspaceId: string; query: string; matches: WorkspaceFileMatch[]; error: string }>();
  const canSearch = typeof window.workbench.findWorkspaceFiles === 'function';
  useEffect(() => {
    if (!canSearch || !workspaceId || query === null) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void window.workbench.findWorkspaceFiles(workspaceId, query).then(matches => {
        if (active) setResult({ workspaceId, query, matches, error: '' });
      }, error => {
        if (active) setResult({ workspaceId, query, matches: [], error: error instanceof Error ? error.message : String(error) });
      });
    }, 120);
    return () => { active = false; window.clearTimeout(timer); };
  }, [canSearch, query, workspaceId]);
  const current = result?.workspaceId === workspaceId && result?.query === query ? result : undefined;
  return { matches: current?.matches ?? [], loading: Boolean(canSearch && workspaceId && query !== null && !current), error: current?.error ?? '' };
}
