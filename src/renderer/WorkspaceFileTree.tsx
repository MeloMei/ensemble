import { useCallback, useEffect, useId, useMemo, useState, useRef, type CSSProperties } from 'react';
import { ChevronRight, FileCode2, Folder, FolderOpen, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { FileEntry } from '../shared/types';
import './WorkspaceFileTree.css';

interface DirectoryBranch {
  entries?: FileEntry[];
  loading?: boolean;
  error?: string;
}

const expandedByWorkspace = new Map<string, ReadonlySet<string>>();
const directoryReadConcurrency = 4;

function findLoadedMatches(root: FileEntry[], branches: ReadonlyMap<string, DirectoryBranch>, query: string) {
  const visible = new Set<string>();
  const ancestors = new Set<string>();
  const lists = [root];
  while (lists.length) {
    for (const entry of lists.pop()!) {
      const children = entry.kind === 'directory' ? branches.get(entry.path)?.entries : undefined;
      if (children?.length) lists.push(children);
      if (!entry.path.toLocaleLowerCase().includes(query)) continue;
      visible.add(entry.path);
      for (let slash = entry.path.lastIndexOf('/'); slash >= 0; slash = entry.path.lastIndexOf('/', slash - 1)) {
        const parent = entry.path.slice(0, slash);
        ancestors.add(parent);
        visible.add(parent);
        if (slash === 0) break;
      }
    }
  }
  return { visible, ancestors };
}

export function WorkspaceFileTree({ workspaceId, workspaceKey, entries, revision, hidden, selectedPath, onOpen }: {
  workspaceId: string;
  workspaceKey: string;
  entries: FileEntry[];
  revision: number;
  hidden: boolean;
  selectedPath?: string;
  onOpen: (path: string) => void;
}) {
  const { t } = useTranslation('workspace');
  const searchScopeId = useId();
  const [expanded, setExpanded] = useState(() => expandedByWorkspace.get(workspaceKey) ?? new Set<string>());
  const [branches, setBranches] = useState<ReadonlyMap<string, DirectoryBranch>>(() => new Map());
  const requests = useRef(new Map<string, { revision: number; result: Promise<FileEntry[]> }>());
  const [filter, setFilter] = useState('');
  const [searchOverrides, setSearchOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const query = filter.trim().toLocaleLowerCase();
  const matches = useMemo(() => query ? findLoadedMatches(entries, branches, query) : undefined, [entries, branches, query]);

  const readDirectory = useCallback((path: string, revision: number, retry = false) => {
    const pending = requests.current.get(path);
    if (!retry && pending?.revision === revision) return pending.result;
    const setBranch = (branch: DirectoryBranch) => setBranches(current => new Map(current).set(path, branch));
    const settle = (branch: DirectoryBranch) => {
      if (requests.current.get(path)?.result === result) setBranch(branch);
      return branch.entries ?? [];
    };
    const result: Promise<FileEntry[]> = Promise.resolve()
      .then(() => window.workbench.listFiles(workspaceId, path))
      .then(listing => settle(listing === null ? { error: '' } : { entries: listing }),
        error => settle({ error: error instanceof Error ? error.message : String(error) }));
    requests.current.set(path, { revision, result });
    setBranches(current => new Map(current).set(path, { entries: current.get(path)?.entries, loading: true }));
    return result;
  }, [workspaceId]);

  useEffect(() => {
    if (hidden || !revision) return;
    let active = true;
    const queue: string[] = [];
    const enqueueExpanded = (children: FileEntry[]) => {
      for (const entry of children) {
        if (entry.kind === 'directory' && expanded.has(entry.path)) queue.push(entry.path);
      }
    };
    enqueueExpanded(entries);
    void (async () => {
      for (let offset = 0; active && offset < queue.length;) {
        const paths = queue.slice(offset, offset + directoryReadConcurrency);
        offset += paths.length;
        const children = await Promise.all(paths.map(path => readDirectory(path, revision)));
        if (active) children.forEach(enqueueExpanded);
      }
    })();
    return () => { active = false; };
  }, [entries, expanded, hidden, readDirectory, revision]);

  function toggle(path: string, open: boolean) {
    if (matches) {
      setSearchOverrides(current => new Map(current).set(path, !open));
      if (!open) void readDirectory(path, revision);
      return;
    }
    const next = new Set(expanded);
    if (open) next.delete(path); else next.add(path);
    expandedByWorkspace.set(workspaceKey, next);
    setExpanded(next);
  }

  function renderRows(children: FileEntry[], depth = 0) {
    return children.filter(entry => !matches || matches.visible.has(entry.path)).map(entry => {
      if (entry.kind === 'file') return <button key={entry.path} type="button"
        className={`tree-row file${selectedPath === entry.path ? ' selected' : ''}`} title={entry.path}
        aria-current={selectedPath === entry.path ? true : undefined} style={{ '--tree-depth': Math.min(depth, 10) } as CSSProperties}
        onClick={() => onOpen(entry.path)}>
        <FileCode2 size={14} aria-hidden="true" /><span className="tree-name">{entry.name}</span>
      </button>;

      const open = matches ? searchOverrides.get(entry.path) ?? matches.ancestors.has(entry.path) : expanded.has(entry.path);
      const branch = branches.get(entry.path);
      const FolderIcon = open ? FolderOpen : Folder;
      return <div key={entry.path} className="workspace-tree-folder" style={{ '--tree-depth': Math.min(depth, 10) } as CSSProperties}>
        <button type="button" className="tree-row directory" title={entry.path} aria-expanded={open}
          data-sticky-level={depth < 4 ? depth : undefined} onClick={() => toggle(entry.path, open)}>
          <ChevronRight className="workspace-tree-chevron" size={12} aria-hidden="true" />
          <FolderIcon size={14} aria-hidden="true" /><span className="tree-name">{entry.name}</span>
        </button>
        <div className="workspace-tree-children" data-open={open} aria-hidden={!open} inert={!open}>
          <div className="workspace-tree-children-inner">
            {branch?.entries?.length ? renderRows(branch.entries, depth + 1)
              : branch?.loading || (!branch && open) ? <p className="workspace-tree-note" role="status">{t('files.loadingDirectory')}</p>
              : branch?.error !== undefined ? <div className="workspace-tree-note" role="status">
                <span>{branch.error || t('files.directoryUnavailable')}</span>
                <button type="button" className="review-text-button" onClick={() => void readDirectory(entry.path, revision, true)}>{t('files.retryDirectory')}</button>
              </div>
              : branch?.entries ? <p className="workspace-tree-note">{t('files.emptyDirectory')}</p> : null}
          </div>
        </div>
      </div>;
    });
  }

  return <section className="workspace-file-tree review-tree" hidden={hidden} aria-label={t('files.files')}>
    <label className="workspace-tree-filter">
      <Search size={13} aria-hidden="true" />
      <input type="search" aria-label={t('files.filterLoaded')} placeholder={t('files.filterLoaded')} value={filter}
        aria-describedby={query ? searchScopeId : undefined}
        onChange={event => { setFilter(event.target.value); setSearchOverrides(new Map()); }} />
    </label>
    {query && <p id={searchScopeId} className="workspace-tree-scope">{t('files.filterScope')}</p>}
    <div className="file-tree workspace-tree-scroll">
      {renderRows(entries)}
      {matches && !matches.visible.size ? <p className="pane-note" role="status">{t('files.noLoadedMatches')}</p>
        : !entries.length && revision > 0 ? <p className="pane-note">{t('files.emptyDirectory')}</p> : null}
    </div>
  </section>;
}
