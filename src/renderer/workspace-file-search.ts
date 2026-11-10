import { useEffect, useMemo, useState } from 'react';

function useWorkspaceSearch<Result>(search: ((workspaceId: string, query: string) => Promise<Result>) | undefined,
  workspaceId: string | undefined, query: string | null) {
  const request = useMemo(() => typeof search === 'function' && workspaceId && query !== null
    ? { search, workspaceId, query } : null, [search, workspaceId, query]);
  const [settled, setSettled] = useState<{ request: NonNullable<typeof request>; result?: Result; error?: string }>();
  useEffect(() => {
    if (!request) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void request.search(request.workspaceId, request.query).then(result => {
        if (active) setSettled({ request, result });
      }, error => {
        if (active) setSettled({ request, error: error instanceof Error ? error.message : String(error) });
      });
    }, 120);
    return () => { active = false; window.clearTimeout(timer); };
  }, [request]);
  const current = settled?.request === request ? settled : undefined;
  return { result: current?.result, loading: Boolean(request && !current), error: current?.error ?? '' };
}

export function useWorkspaceFileMatches(workspaceId: string | undefined, query: string | null) {
  const { result, loading, error } = useWorkspaceSearch(window.workbench.findWorkspaceFiles, workspaceId, query);
  return { matches: result ?? [], loading, error };
}

export function useWorkspaceTextMatches(workspaceId: string | undefined, query: string | null) {
  return useWorkspaceSearch(window.workbench.searchWorkspaceText, workspaceId, query);
}
