import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, Download, LoaderCircle, RefreshCw } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AppUpdateState } from '../shared/application-updates';
import { formatDate } from '../shared/i18n';
import './application-updates.css';

export function useApplicationUpdates() {
  const [state, setState] = useState<AppUpdateState | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  useEffect(() => {
    let active = true;
    let received = false;
    const unsubscribe = window.workbench.onApplicationUpdateChanged(next => {
      received = true;
      if (active) { setState(next); setError(''); }
    });
    void window.workbench.getApplicationUpdate().then(next => {
      if (active && !received) setState(next);
    }, reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; unsubscribe(); };
  }, []);
  const run = useCallback(async (operation: () => Promise<AppUpdateState>) => {
    if (running.current) return;
    running.current = true;
    setPending(true); setError('');
    try { setState(await operation()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { running.current = false; setPending(false); }
  }, []);
  return { state, error, pending, run };
}

export function ApplicationUpdateNotice({ state, onOpen }: { state: AppUpdateState | null; onOpen: () => void }) {
  const { t } = useTranslation('shell');
  if (!state?.release || !['available', 'downloading', 'ready', 'installing', 'error'].includes(state.phase)) return null;
  return <div className="application-update-notice" role="status">
    <Download size={15} aria-hidden="true" /><span>{t(state.phase === 'ready' ? 'updates.noticeReady' : 'updates.noticeAvailable', { version: state.release.version })}</span>
    <button type="button" onClick={onOpen}>{t('updates.view')}</button>
  </div>;
}

export function ApplicationUpdateSettings({ state, error, pending, run }: ReturnType<typeof useApplicationUpdates>) {
  const { t } = useTranslation('shell');
  const busy = pending || !!state && ['checking', 'downloading', 'installing'].includes(state.phase);
  const progress = state?.totalBytes ? Math.min(100, Math.round((state.downloadedBytes ?? 0) / state.totalBytes * 100)) : undefined;
  return <section className="application-update-settings" aria-labelledby="application-update-heading">
    <div className="application-update-heading"><div><h3 id="application-update-heading">{t('updates.title')}</h3><p>{state ? t('updates.version', { version: state.currentVersion }) : t('updates.loading')}</p></div>
      <button type="button" className="button" disabled={!state?.supported || busy} onClick={() => void run(() => window.workbench.checkApplicationUpdate())}>
        {state?.phase === 'checking' ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}{t('updates.check')}
      </button>
    </div>
    {state && !state.supported && <p className="application-update-note">{t('updates.installedOnly')}</p>}
    {state?.supported && <>
      <label className="application-update-auto"><input type="checkbox" checked={state.autoCheck} disabled={busy} onChange={event => void run(() => window.workbench.setApplicationUpdateAutoCheck(event.target.checked))} /><span>{t('updates.autoCheck')}</span></label>
      <p className="application-update-note">{t('updates.autoCheckNote')}</p>
      <p className="application-update-status" role="status" aria-live="polite">{t(`updates.phase.${state.phase}`)}{state.checkedAt && !['checking', 'downloading', 'installing'].includes(state.phase) && <small>{t('updates.checkedAt', { time: formatDate(state.checkedAt) })}</small>}</p>
      {state.release && <div className="application-update-release">
        <div className="application-update-release-heading"><strong>{state.release.title}</strong><a href={state.release.url} target="_blank" rel="noreferrer">{t('updates.releasePage')}<ArrowUpRight size={13} /></a></div>
        <div className="application-update-release-notes"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children, title }) => <a href={href} title={title} target="_blank" rel="noreferrer">{children}</a> }}>{state.release.notes || t('updates.noNotes')}</ReactMarkdown></div>
        {state.phase === 'downloading' && <div className="application-update-progress"><progress aria-label={t('updates.downloadProgress')} max={100} value={progress} /><span>{progress === undefined ? t('updates.phase.downloading') : `${progress}%`}</span></div>}
        <div className="application-update-actions">
          {state.phase === 'ready' ? <button type="button" className="button primary" disabled={busy} onClick={() => void run(() => window.workbench.installApplicationUpdate())}><RefreshCw size={14} />{t('updates.install')}</button>
            : <button type="button" className="button primary" disabled={busy} onClick={() => void run(() => window.workbench.downloadApplicationUpdate())}><Download size={14} />{t('updates.download', { size: (state.release.size / 1024 / 1024).toFixed(1) })}</button>}
        </div><p className="application-update-note">{t('updates.installNote')}</p>
      </div>}
    </>}
    {(error || state?.error) && <p className="field-error" role="alert">{error || state?.error}</p>}
  </section>;
}
