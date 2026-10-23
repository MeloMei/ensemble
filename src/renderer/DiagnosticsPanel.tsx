import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, LoaderCircle, RefreshCw } from 'lucide-react';
import type { DiagnosticEntry, Session } from '../shared/types';
import { formatDate } from '../shared/i18n';
import { statusLabel } from './ui';
import './RuntimeHealth.css';

const kindLabels: Record<string, string> = { 'dispatch.started': 'started', 'dispatch.settled': 'settled', normalized: 'updated', 'rpc.send': 'sent', 'rpc.receive': 'received' };

export function DiagnosticsPanel({ sessions }: { sessions: Session[] }) {
  const { t } = useTranslation('runtime');
  const [entries, setEntries] = useState<DiagnosticEntry[]>([]);
  const [tracing, setTracing] = useState<boolean>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportPath, setExportPath] = useState('');
  const [error, setError] = useState('');
  const active = useRef(true);
  const savingRef = useRef(false);
  const request = useRef(0);
  const refresh = async () => {
    const generation = ++request.current;
    setLoading(true); setError('');
    try {
      const [records, enabled] = await Promise.all([window.workbench.diagnostics(), window.workbench.diagnosticTracing()]);
      if (active.current && generation === request.current) { setEntries(records); setTracing(enabled); }
    } catch (failure) { if (active.current && generation === request.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (active.current && generation === request.current) setLoading(false); }
  };
  useEffect(() => { active.current = true; void refresh(); return () => { active.current = false; request.current++; }; }, []);

  const changeTracing = async (enabled: boolean) => {
    if (savingRef.current) return;
    savingRef.current = true; setSaving(true); setError('');
    try { await window.workbench.setDiagnosticTracing(enabled); if (active.current) setTracing(enabled); }
    catch (failure) { if (active.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { savingRef.current = false; if (active.current) setSaving(false); }
  };
  const exportRecords = async () => {
    setExporting(true); setError('');
    try { const path = await window.workbench.exportDiagnostics(); if (active.current) setExportPath(path); }
    catch (failure) { if (active.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (active.current) setExporting(false); }
  };
  return <section className="diagnostics-panel" aria-label={t('diagnostics.title')}>
    <div className="tools-actions"><span className="tools-section-title">{t('diagnostics.title')}</span><div className="runtime-panel-actions">
      <button className="button small" disabled={loading || saving} onClick={() => void refresh()}><RefreshCw className={loading ? 'spin' : ''} size={13} />{t('diagnostics.refresh')}</button>
      <button className="button small" disabled={exporting} onClick={() => void exportRecords()}>{exporting ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />}{t('diagnostics.export')}</button>
    </div></div>
    <p className="pane-note">{t('diagnostics.defaultNote')}</p>
    <label className="diagnostics-tracing"><input type="checkbox" checked={tracing ?? false} disabled={tracing === undefined || loading || saving} onChange={event => void changeTracing(event.target.checked)} />
      <span><strong>{t('diagnostics.tracing')}</strong><small>{t('diagnostics.tracingNote')}</small></span></label>
    {exportPath && <div className="diagnostics-export" role="status"><span>{t('diagnostics.exported')}</span><code>{exportPath}</code></div>}
    {error && <p className="runtime-panel-error" role="alert">{error}</p>}
    <div className="diagnostics-records" aria-busy={loading}>{entries.length ? <>
      <p className="diagnostics-count">{t('diagnostics.recordCount', { count: entries.length })}</p>
      <div className="diagnostics-table-scroll"><table><thead><tr><th>{t('diagnostics.time')}</th><th>{t('diagnostics.session')}</th><th>{t('diagnostics.layer')}</th><th>{t('diagnostics.event')}</th><th>{t('diagnostics.status')}</th></tr></thead>
        <tbody>{[...entries].reverse().map(entry => <tr key={entry.seq}>
          <td><time dateTime={entry.at}>{Number.isNaN(Date.parse(entry.at)) ? '—' : formatDate(entry.at)}</time></td>
          <td>{sessions.find(session => session.id === entry.sessionId)?.title ?? entry.sessionId?.slice(0, 12) ?? '—'}
            {(entry.attemptId || entry.turnId) && <details><summary>{t('diagnostics.identifiers')}</summary>
              {entry.sessionId && <span>{t('diagnostics.session')}: <code>{entry.sessionId}</code></span>}
              {entry.attemptId && <span>{t('diagnostics.attempt')}: <code>{entry.attemptId}</code></span>}
              {entry.turnId && <span>{t('diagnostics.turn')}: <code>{entry.turnId}</code></span>}
            </details>}</td>
          <td>{t(`diagnostics.layer.${entry.layer}`)}</td>
          <td><span title={entry.kind}>{kindLabels[entry.kind] ? t(`diagnostics.event.${kindLabels[entry.kind]}`) : entry.kind}</span>{entry.method && <small>{entry.method}</small>}</td>
          <td>{entry.status ? statusLabel(entry.status) : '—'}{entry.errorCode && <small>{entry.errorCode}</small>}</td>
        </tr>)}</tbody></table></div>
    </> : <p className="pane-note" role="status">{loading ? t('diagnostics.loading') : t('diagnostics.empty')}</p>}</div>
  </section>;
}
