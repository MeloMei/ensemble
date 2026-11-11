import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { providerForDirectory } from '../shared/provider-models';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { PROMPT_TEXT_LIMIT, type ProviderInfo } from '../shared/types';
import { RuntimeHealth, useRuntimeHealth } from './RuntimeHealth';
import { ProviderGuides } from './WorkflowViews';
import { runSessionCommand } from './session-command';
import { BusyIcon, DirectoryField, ModelField, ProviderSelect, defaultModelId, pathName, validModelSelection, type Perform } from './ui';
import './FirstTask.css';

const starterProviders: Pick<ProviderInfo, 'id' | 'name' | 'source'>[] = [
  { id: 'codex', name: 'Codex', source: 'builtin' },
  { id: 'claude', name: 'Claude Code', source: 'builtin' },
];

export function FirstTask({ providers, connected, perform, pending }: {
  providers: ProviderInfo[]; connected: boolean; perform: Perform; pending: Set<string>;
}) {
  const { t } = useTranslation('shell');
  const [cwd, setCwd] = useState('');
  const [draft, setDraft] = useState('');
  const [selection, setSelection] = useState(() => {
    const provider = providers.find(item => item.available);
    return { providerId: provider?.id ?? '', modelId: defaultModelId(provider) };
  });
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState('');
  const health = useRuntimeHealth(providers, cwd.trim());
  const available = health.providers.some(item => item.available);
  const provider = providerForDirectory(health.providers.find(item => item.id === selection.providerId), cwd.trim());
  useEffect(() => {
    if (selection.providerId) return;
    const detected = health.providers.find(item => item.available);
    if (detected) setSelection({ providerId: detected.id, modelId: defaultModelId(detected) });
  }, [health.providers, selection.providerId]);
  const valid = Boolean(connected && cwd.trim() && validModelSelection(provider, selection.modelId) && draft.length <= PROMPT_TEXT_LIMIT);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    const input = { title: pathName(cwd.trim()).slice(0, 200), cwd: cwd.trim(), providerId: selection.providerId,
      ...(selection.modelId ? { modelId: selection.modelId } : {}), ...(draft ? { initialDraft: draft } : {}) };
    void runSessionCommand('first-task', input, commandId => window.workbench.createSession({ ...input, commandId }))
      .catch(reason => { submitting.current = false; setBusy(false); setError(reason instanceof Error ? reason.message : String(reason)); });
  };
  return <section className="first-task scroll-content" aria-labelledby="first-task-title">
    <div className="first-task-content">
      <header><h2 id="first-task-title">{t('firstTask.title')}</h2><p>{t('firstTask.description')}</p></header>
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          <label>{t('common.projectDirectory')}<DirectoryField value={cwd} onChange={setCwd} perform={perform} /></label>
          <div className="first-task-runtime-heading"><span>{t('firstTask.runtime')}</span><button type="button" className="subtle-button" disabled={!connected || busy || pending.has('first-task-refresh')} onClick={() => void perform('first-task-refresh', health.refresh)}><RefreshCw size={13} className={pending.has('first-task-refresh') ? 'spin' : ''} />{t('provider.refresh')}</button></div>
          <p className="first-task-runtime-note">{t('firstTask.detectionNote')}</p>
          {available ? <>
            <label>{t('common.agent')}<ProviderSelect providers={health.providers} value={selection.providerId} disabled={busy} onChange={providerId => setSelection({ providerId, modelId: defaultModelId(health.providers.find(item => item.id === providerId)) })} /></label>
            <ModelField provider={provider} value={selection.modelId} disabled={busy} onChange={modelId => setSelection(current => ({ ...current, modelId }))} />
            {provider && <details className="first-task-health"><summary>{t('firstTask.health')}</summary><RuntimeHealth provider={provider} loading={health.loading} /><ProviderGuides provider={provider} /></details>}
          </> : <div className="first-task-setup"><p role="status">{t('firstTask.noRuntime')}</p>{(providers.length ? providers : starterProviders).map(item => <details key={item.id}><summary>{item.name}</summary><ProviderGuides provider={item} /></details>)}</div>}
          {health.error && <p className="first-task-error" role="alert">{health.error}</p>}
          <label>{t('firstTask.draft')}<span className="first-task-optional">{t('common.optional')}</span><textarea value={draft} maxLength={PROMPT_TEXT_LIMIT} rows={4} onChange={event => setDraft(event.target.value)} placeholder={t('firstTask.draftHint')} /></label>
        </fieldset>
        {error && <p className="first-task-error" role="alert">{error}</p>}
        <footer><p>{t('firstTask.openNote')}</p><button className="button primary" disabled={!valid || busy}><BusyIcon busy={busy}><ArrowRight size={15} /></BusyIcon>{t('firstTask.open')}</button></footer>
      </form>
    </div>
  </section>;
}
