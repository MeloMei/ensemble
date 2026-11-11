import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RuntimeInstall } from '../shared/types';
import type { Perform } from './ui';
import { OperationFeedback } from './ui-kit/OperationFeedback';

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
      const request = async () => {
        setRequested(true);
        try { await window.workbench.installRuntime(id); }
        finally { setRequested(false); }
      };
      void perform(`runtime-install-${id}`, request, { retry: request });
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
  const unavailable = running ? state.phase !== 'installing' : busy;
  return <div className="provider-install-action">
    <p>{t('provider.installPackage', { package: state.packageName, manager: state.manager === 'brew' ? 'Homebrew' : 'npm' })}</p>
    {running && <OperationFeedback state="progress">{t(`provider.installPhase.${state.phase}`)}</OperationFeedback>}
    {state.phase === 'failed' && <OperationFeedback state="error">{t(`provider.installProblem.${state.problem ?? 'install'}`)}</OperationFeedback>}
    {(state.phase === 'complete' || state.phase === 'cancelled') && <OperationFeedback>{t(`provider.installPhase.${state.phase}`)}</OperationFeedback>}
    {(running || (!available && state.prerequisiteMet)) && <button className="button small" type="button" aria-disabled={unavailable}
      onClick={() => { if (!unavailable) (running ? cancel : install)(); }}>
      {t(running ? 'provider.installCancel' : state.phase === 'failed' ? 'provider.installRetry' : 'provider.installNow')}
    </button>}
    {!available && !running && !state.prerequisiteMet && <p>{t(state.manager === 'brew' ? 'provider.installNeedsBrew' : 'provider.installNeedsNpm')}</p>}
  </div>;
}
