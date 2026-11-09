import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GitBranchComparison } from '../shared/types';
import { AppSelect } from './AppSelect';
import { Modal } from './ui';
import './BranchComparison.css';

export function BranchComparison({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation('workspace');
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="review-text-button" onClick={() => setOpen(true)}>{t('files.branchCompare')}</button>
    {open && <BranchComparisonDialog key={workspaceId} workspaceId={workspaceId} onClose={() => setOpen(false)} />}
  </>;
}

type Comparison =
  | { state: 'loading' }
  | { state: 'failed'; error: string }
  | { state: 'ready'; value: GitBranchComparison };

function BranchComparisonDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const { t } = useTranslation('workspace');
  const [refs, setRefs] = useState<string[]>();
  const [refsError, setRefsError] = useState('');
  const [selected, setSelected] = useState('');
  const [comparison, setComparison] = useState<Comparison>();
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    void window.workbench.gitBranchRefs(workspaceId).then(
      value => { if (active) setRefs(value); },
      error => { if (active) setRefsError(error instanceof Error ? error.message : String(error)); },
    );
    return () => { active = false; generation.current++; };
  }, [workspaceId]);

  const compare = () => {
    const token = ++generation.current;
    setComparison({ state: 'loading' });
    void window.workbench.gitBranchComparison(workspaceId, selected).then(
      value => { if (token === generation.current) setComparison({ state: 'ready', value }); },
      error => { if (token === generation.current) setComparison({ state: 'failed', error: error instanceof Error ? error.message : String(error) }); },
    );
  };
  const result = comparison?.state === 'ready' ? comparison.value : undefined;
  const loading = comparison?.state === 'loading';

  return <Modal title={t('files.branchCompare')} subtitle={t('files.branchCompareNote')} size="wide" onClose={onClose}>
    <div className="branch-comparison">
      <form className="branch-comparison-controls" onSubmit={event => { event.preventDefault(); if (selected && !loading) compare(); }}>
        <AppSelect label={t('files.branchCompareTarget')} value={selected} required disabled={!refs?.length}
          display={selected || t('files.branchCompareChoose')} options={refs?.map(ref => ({ value: ref, label: ref })) ?? []}
          onChange={value => { generation.current++; setSelected(value); setComparison(undefined); }} />
        <button type="submit" className="button" disabled={!selected || loading}>{t('files.branchCompareRun')}</button>
      </form>
      {refsError ? <p className="branch-comparison-error" role="alert">{refsError}</p>
        : !refs ? <p role="status">{t('files.branchCompareLoadingRefs')}</p>
          : !refs.length && <p role="status">{t('files.branchCompareNoRefs')}</p>}
      {loading && <p role="status">{t('files.branchCompareLoading')}</p>}
      {comparison?.state === 'failed' && <p className="branch-comparison-error" role="alert">{comparison.error}</p>}
      {result && <>
        <dl className="branch-comparison-revisions">
          <div><dt>{t('files.branchCompareTarget')}</dt><dd><code>{result.targetRef}</code><code>{result.targetSha}</code></dd></div>
          <div><dt>{t('files.branchCompareBase')}</dt><dd><code>{result.mergeBase}</code></dd></div>
          <div><dt>{t('files.branchCompareHead')}</dt><dd><code>{result.headSha}</code></dd></div>
        </dl>
        {result.truncated && <p role="status">{t('files.branchCompareTruncated')}</p>}
        {result.patch ? <pre tabIndex={0} aria-label={t('files.branchComparePatch')}>{result.patch}</pre>
          : !result.truncated && <p role="status">{t('files.branchCompareEmpty')}</p>}
      </>}
    </div>
  </Modal>;
}
