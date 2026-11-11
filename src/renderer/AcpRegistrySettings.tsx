import { useRef, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AcpRegistryEntry, ProviderInfo } from '../shared/types';

function newer(latest: string, installed: string) {
  const previous = installed.split('.').map(Number);
  const current = latest.split('.').map(Number);
  const difference = current.findIndex((value, index) => value !== previous[index]);
  return difference !== -1 && current[difference] > previous[difference];
}

export function AcpRegistrySettings({ providers }: { providers: ProviderInfo[] }) {
  const { t } = useTranslation('shell');
  const [catalog, setCatalog] = useState<AcpRegistryEntry[]>();
  const [query, setQuery] = useState('');
  const [working, setWorking] = useState<string>();
  const [error, setError] = useState('');
  const operation = useRef(false);

  const run = (key: string, action: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true;
    setWorking(key);
    setError('');
    void action().catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => { operation.current = false; setWorking(undefined); });
  };
  const installed = new Map(providers.flatMap(provider => provider.acpRegistry ? [[provider.acpRegistry.id, provider.acpRegistry.version] as const] : []));
  const filter = query.trim().toLocaleLowerCase();
  const matches = catalog?.filter(entry => [entry.name, entry.id, entry.description, entry.source, entry.distribution?.source]
    .some(value => value?.toLocaleLowerCase().includes(filter)));
  return <section className="plugin-section acp-registry-section">
    <div className="plugin-section-heading">
      <div><h2>{t('provider.acpRegistry')}</h2><p>{t('provider.acpRegistryNote')}</p></div>
      <button type="button" className="button" disabled={Boolean(working)}
        onClick={() => run('refresh', async () => { setCatalog(await window.workbench.refreshAcpRegistry()); })}>
        <RefreshCw size={14} className={working === 'refresh' ? 'spin' : undefined} />{t('provider.acpRegistryRefresh')}
      </button>
    </div>
    {error && <p className="field-error" role="alert">{error}</p>}
    {catalog && <>
      <input type="search" value={query} aria-label={t('provider.acpRegistrySearch')} placeholder={t('provider.acpRegistrySearch')}
        onChange={event => setQuery(event.target.value)} />
      {!matches?.length && <p role="status">{t('provider.acpRegistryEmpty')}</p>}
      <ul className="acp-registry-list">{matches?.map(entry => {
        const version = installed.get(entry.id);
        const update = version !== undefined && newer(entry.version, version);
        return <li key={entry.id}>
          <div>
            <h3>{entry.name} <small>{entry.version}</small></h3>
            <p>{entry.description}</p>
            <small>{[entry.distribution && t(`provider.acpRegistryKind.${entry.distribution.kind}`), entry.distribution?.source,
              entry.platforms.join(', '), entry.distribution?.kind === 'binary' && t(entry.distribution.checksum ? 'provider.acpRegistryChecksum' : 'provider.acpRegistryNoChecksum')].filter(Boolean).join(' · ')}</small>
            {entry.source && <a href={entry.source} target="_blank" rel="noreferrer">{t('provider.acpRegistrySource')}</a>}
            {entry.unavailable && <p>{t(`provider.acpRegistryUnavailable.${entry.unavailable}`)}</p>}
            {version && <p>{t('provider.acpRegistryInstalled', { version })}</p>}
          </div>
          {entry.distribution && (!version || update) && <button type="button" className="button" disabled={Boolean(working || entry.unavailable)}
            onClick={() => run(entry.id, () => window.workbench.installAcpRegistry(entry.id, entry.version))}>
            <Download size={14} />{t(working === entry.id ? 'provider.acpRegistryInstalling' : update ? 'provider.acpRegistryUpdate' : 'provider.acpRegistryInstall')}
          </button>}
        </li>;
      })}</ul>
    </>}
  </section>;
}
