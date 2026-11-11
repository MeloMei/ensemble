import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDate } from '../shared/i18n';
import type { GitHistoryCommit } from '../shared/types';
import { Modal } from './ui';
import './GitHistory.css';

const pageSize = 50;
const maxCommits = 500;
const laneSize = 10;
const maxLanes = 8;

function commitGraph(commits: GitHistoryCommit[]) {
  const visible = new Set(commits.map(commit => commit.sha));
  let active: string[] = [];
  return commits.map(commit => {
    const connectsFromAbove = active.includes(commit.sha);
    if (!connectsFromAbove) active.push(commit.sha);
    const before = active;
    const dot = before.indexOf(commit.sha);
    const parents = commit.parents.filter(parent => visible.has(parent));
    active = before.filter(sha => sha !== commit.sha);
    active.splice(dot, 0, ...parents.filter(parent => !active.includes(parent)));
    const top = before.flatMap((sha, from) => {
      if (sha === commit.sha) return connectsFromAbove ? [{ from, to: dot }] : [];
      const to = active.indexOf(sha);
      return to < 0 ? [] : [{ from, to }];
    });
    const branches = parents.map(parent => ({ from: dot, to: active.indexOf(parent) }));
    return { dot, top, branches, width: Math.min(maxLanes, Math.max(before.length, active.length)) * laneSize };
  });
}

function CommitLane({ row }: { row: ReturnType<typeof commitGraph>[number] }) {
  const x = (lane: number) => Math.min(maxLanes - 1, lane) * laneSize + 5;
  return <svg className="git-history-lanes" width={row.width} viewBox={`0 0 ${row.width} 32`} preserveAspectRatio="none" aria-hidden="true">
    {row.top.map(({ from, to }) => <path key={`top:${from}`} d={`M${x(from)} 0 C${x(from)} 16 ${x(to)} 16 ${x(to)} ${from === row.dot ? 16 : 32}`} />)}
    {row.branches.map(({ from, to }) => <path key={`parent:${to}`} d={`M${x(from)} 16 Q${x(to)} 21 ${x(to)} 32`} />)}
    <circle cx={x(row.dot)} cy={16} r={3} />
  </svg>;
}

function useRead<T>(read: () => Promise<T>, enabled = true) {
  const [result, setResult] = useState<{ read: typeof read; value?: T; error?: string }>();
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void read().then(value => { if (current) setResult({ read, value }); },
      error => { if (current) setResult({ read, error: error instanceof Error ? error.message : String(error) }); });
    return () => { current = false; };
  }, [read, enabled]);
  const matching = enabled && result?.read === read ? result : undefined;
  return { value: matching?.value, error: matching?.error, loading: enabled && !matching };
}

export function GitHistory({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation('workspace');
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="review-text-button" onClick={() => setOpen(true)}>{t('files.gitHistory')}</button>
    {open && <HistoryDialog workspaceId={workspaceId} onClose={() => setOpen(false)} />}
  </>;
}

function HistoryDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const { t } = useTranslation('workspace');
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [allBranches, setAllBranches] = useState(false);
  const [limit, setLimit] = useState(pageSize);
  const [selected, setSelected] = useState<{ sha: string; path?: string }>();
  const history = useRead(useCallback(() => window.workbench.gitHistory(workspaceId, query, allBranches, limit), [workspaceId, query, allBranches, limit]));
  const sha = selected?.sha ?? '';
  const files = useRead(useCallback(() => window.workbench.gitCommitFiles(workspaceId, sha), [workspaceId, sha]), Boolean(sha));
  const path = selected?.path ?? '';
  const diff = useRead(useCallback(() => window.workbench.gitCommitDiff(workspaceId, sha, path), [workspaceId, sha, path]), Boolean(sha && path));
  const graph = useMemo(() => commitGraph(history.value?.commits ?? []), [history.value]);
  const error = history.error || files.error || diff.error;
  const loading = history.loading || files.loading || diff.loading;

  return <Modal title={t('files.gitHistory')} size="wide" onClose={onClose}>
    <div className="git-history">
      <form className="git-history-search" onSubmit={event => {
        event.preventDefault(); setQuery(input.trim()); setLimit(pageSize); setSelected(undefined);
      }}>
        <input type="search" aria-label={t('files.historyQuery')} placeholder={t('files.historyQuery')} maxLength={256} value={input} onChange={event => setInput(event.target.value)} />
        <button type="submit" className="button">{t('files.historySearch')}</button>
        <label><input type="checkbox" checked={allBranches} onChange={event => {
          setAllBranches(event.target.checked); setLimit(pageSize); setSelected(undefined);
        }} />{t('files.historyAllBranches')}</label>
      </form>
      {error && <p className="pane-note error-text" role="alert">{error}</p>}
      {loading && <p className="pane-note" role="status">{t('files.historyLoading')}</p>}
      {history.value && !history.value.commits.length && <p className="pane-note">{t('files.historyEmpty')}</p>}
      <div className="git-history-content">
        <div className="git-history-commits">
          {history.value?.commits.map((commit, index) => <button type="button" className="git-history-commit" key={commit.sha}
            aria-pressed={commit.sha === sha} onClick={() => setSelected({ sha: commit.sha })}>
            <CommitLane row={graph[index]} />
            <span><strong>{commit.subject || commit.sha.slice(0, 8)}</strong>
              <small>{commit.sha.slice(0, 8)} · {commit.author} · {formatDate(commit.authoredAt)}</small>
              {commit.refs && <small title={commit.refs}>{commit.refs}</small>}
            </span>
          </button>)}
          {history.value?.limited && (limit < maxCommits
            ? <button className="button small" onClick={() => setLimit(current => current + pageSize)}>{t('files.historyMore')}</button>
            : <p className="pane-note">{t('files.historyLimit', { count: maxCommits })}</p>)}
        </div>
        {sha && <section className="git-history-details" aria-label={t('files.historyCommitFiles')}>
          <code>{sha.slice(0, 12)}</code>
          {files.value && (files.value.length ? <div className="git-history-files">{files.value.map(file =>
            <button type="button" className="tree-row" key={file} title={file} aria-pressed={path === file}
              onClick={() => setSelected({ sha, path: file })}><span className="tree-name">{file}</span></button>)}</div>
            : <p className="pane-note">{t('files.historyNoFiles')}</p>)}
          {diff.value?.truncated && <p role="status">{t('files.branchCompareTruncated')}</p>}
          {diff.value?.patch && <pre tabIndex={0} aria-label={t('files.branchComparePatch')}>{diff.value.patch}</pre>}
        </section>}
      </div>
    </div>
  </Modal>;
}
