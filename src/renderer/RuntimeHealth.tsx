import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, CircleAlert, CircleHelp, CircleSlash, LoaderCircle } from 'lucide-react';
import type { ProviderHealthStage, ProviderInfo } from '../shared/types';
import { formatDate } from '../shared/i18n';
import './RuntimeHealth.css';

const stages: ProviderHealthStage[] = ['binary', 'protocol', 'catalog', 'authentication', 'quota'];
const sourceLabels: Record<string, string> = {
  'runtime-discovery': 'discovery', 'completed-turn': 'completedTurn', 'runtime-authentication-error': 'authenticationError',
  'no-authentication-evidence': 'noAuthentication', 'no-quota-source': 'noQuota',
  'plugin-ready': 'plugin',
  'codex-app-server': 'codex', 'claude-local-configuration': 'claude',
  'pi-native-rpc': 'pi',
  'acp-runtime-discovery': 'acp', 'acp-discovery-error': 'acpError', 'plugin-manifest': 'manifest',
};

export function useRuntimeHealth(providers: ProviderInfo[], cwd: string) {
  const providerKey = JSON.stringify(providers);
  const key = JSON.stringify([cwd, providerKey]);
  const latestKey = useRef(key); latestKey.current = key;
  const [result, setResult] = useState<{ key: string; providers: ProviderInfo[] }>();
  const [loadingKey, setLoadingKey] = useState<string>();
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const [refreshRevision, setRefreshRevision] = useState(0);

  useEffect(() => {
    if (!cwd) return;
    let active = true;
    setLoadingKey(key); setFailure(undefined);
    void window.workbench.providerHealth(cwd).then(value => {
      if (active && latestKey.current === key) setResult({ key, providers: value });
    }, error => {
      if (active && latestKey.current === key) setFailure({ key, message: error instanceof Error ? error.message : String(error) });
    }).finally(() => { if (active) setLoadingKey(current => current === key ? undefined : current); });
    return () => { active = false; };
  }, [key, refreshRevision]);

  return {
    providers: !cwd ? providers : result?.key === key ? result.providers : providers.map(provider => ({ ...provider, health: undefined })),
    loading: Boolean(cwd) && (loadingKey === key || (result?.key !== key && failure?.key !== key)),
    error: failure?.key === key ? failure.message : '',
    refresh: async () => { await window.workbench.refreshProviders(); setRefreshRevision(value => value + 1); },
  };
}

export function RuntimeHealth({ provider, loading = false }: { provider: ProviderInfo; loading?: boolean }) {
  const { t } = useTranslation('runtime');
  return <section className="runtime-health" aria-label={t('health.title', { provider: provider.name })} aria-busy={loading}>
    <div className="runtime-health-heading"><h3>{t('health.checks')}</h3>{loading && <span role="status"><LoaderCircle className="spin" size={12} />{t('health.loading')}</span>}</div>
    <dl>{stages.map(stage => {
      const check = provider.health?.checks[stage];
      const status = check?.status ?? 'unknown';
      const Glyph = status === 'ready' ? Check : status === 'error' ? CircleAlert : status === 'missing' ? CircleSlash : CircleHelp;
      const observed = check?.observedAt && !Number.isNaN(Date.parse(check.observedAt)) ? check.observedAt : undefined;
      return <div className="runtime-health-check" data-stage={stage} data-status={status} key={stage}>
        <dt>{t(`health.stage.${stage}`)}</dt>
        <dd><span className={`health-status health-${status}`}><Glyph size={12} />{t(`health.status.${status}`)}</span>
          <small title={check?.source}>{t(`health.source.${check?.source ? sourceLabels[check.source] ?? 'other' : 'none'}`)}</small>
          {observed && <time dateTime={observed}>{t('health.observedAt', { time: formatDate(observed) })}</time>}
          {check?.detail && <p>{check.detail}</p>}
        </dd>
      </div>;
    })}</dl>
  </section>;
}
