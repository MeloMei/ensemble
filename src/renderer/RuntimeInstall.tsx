import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LoaderCircle } from 'lucide-react';
import type { RuntimeInstall } from '../shared/types';
import type { Perform } from './ui';

function inProgress(install: RuntimeInstall) {
  return ['installing', 'cancelling', 'detecting'].includes(install.phase);
}

export function useRuntimeInstalls(perform: Perform) {
  const [installs, setInstalls] = useState<RuntimeInstall[]>([]);
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    if (!window.workbench.runtimeInstalls) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const values = await window.workbench.runtimeInstalls();
        if (disposed) return;
        setInstalls(values);
        if (requested || values.some(inProgress)) timer = setTimeout(read, 400);
      } catch {
        if (!disposed && requested) timer = setTimeout(read, 1000);
      }
    };
    void read();
    return () => { disposed = true; clearTimeout(timer); };
  }, [requested]);

  return {
    installs,
    busy: requested || installs.some(inProgress),
    install: (id: string) => {
      setRequested(true);
      void perform(`runtime-install-${id}`, async () => {
        try { await window.workbench.installRuntime(id); }
        finally { setRequested(false); }
      });
    },
    cancel: (id: string) => void perform(`runtime-install-cancel-${id}`, () => window.workbench.cancelRuntimeInstall(id)),
  };
}

export function RuntimeInstallAction({ state, available, busy, install, cancel }: {
  state: RuntimeInstall;
  available: boolean;
  busy: boolean;
  install(): void;
  cancel(): void;
}) {
  const { t } = useTranslation('shell');
  if (available && state.phase === 'idle') return null;
  const running = inProgress(state);
  return <div className="provider-install-action">
    <p>{t('provider.installPackage', { package: state.packageName, manager: state.manager === 'brew' ? 'Homebrew' : 'npm' })}</p>
    {running && <p role="status"><LoaderCircle className="spin" size={13} />{t(`provider.installPhase.${state.phase}`)}</p>}
    {state.phase === 'failed' && <p role="alert" className="runtime-panel-error">{t(`provider.installProblem.${state.problem ?? 'install'}`)}</p>}
    {(state.phase === 'complete' || state.phase === 'cancelled') && <p role="status">{t(`provider.installPhase.${state.phase}`)}</p>}
    {!available && !running && (state.prerequisiteMet
      ? <button className="button small" type="button" disabled={busy} onClick={install}>
        {t(state.phase === 'failed' ? 'provider.installRetry' : 'provider.installNow')}</button>
      : <p>{t(state.manager === 'brew' ? 'provider.installNeedsBrew' : 'provider.installNeedsNpm')}</p>)}
    {state.phase === 'installing' && <button className="button small" type="button" onClick={cancel}>{t('provider.installCancel')}</button>}
  </div>;
}
