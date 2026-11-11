import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, LoaderCircle } from 'lucide-react';
import type { NativeAccountProvider, NativeRuntimeAccount } from '../shared/types';
import { CopyTextButton } from './ui-kit';
import { Modal, type Perform } from './ui';

function pendingAccount(state: NativeRuntimeAccount) {
  return state.phase === 'starting' || state.phase === 'waiting' || state.phase === 'signing-out';
}

export function RuntimeAccount({ id, name, perform }: { id: NativeAccountProvider; name: string; perform: Perform }) {
  const { t } = useTranslation('shell');
  const [state, setState] = useState<NativeRuntimeAccount>({ status: 'unknown' });
  const [request, setRequest] = useState<'sign-in' | 'sign-out'>();
  const [confirm, setConfirm] = useState(false);
  const [revision, setRevision] = useState(0);
  const checkedRevision = useRef(-1);
  useEffect(() => {
    if (!window.workbench.runtimeAccount) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (refresh = false) => {
      try {
        const value = await window.workbench.runtimeAccount(id, refresh);
        if (!current) return;
        setState(value);
        if (request || pendingAccount(value)) timer = setTimeout(() => void read(), 400);
      } catch {
        if (current && request) timer = setTimeout(() => void read(), 1000);
      }
    };
    const refresh = !request && checkedRevision.current !== revision;
    if (refresh) checkedRevision.current = revision;
    void read(refresh);
    return () => { current = false; clearTimeout(timer); };
  }, [id, request, revision]);

  if (!window.workbench.runtimeAccount) return null;
  const busy = Boolean(request) || pendingAccount(state);
  const signingOut = request === 'sign-out' || state.phase === 'signing-out';
  const run = (operation: 'sign-in' | 'sign-out', method: 'browser' | 'device' = 'browser') => {
    setRequest(operation);
    void perform(`runtime-account-${id}`, async () => {
      try { await (operation === 'sign-in' ? window.workbench.signInRuntime(id, method) : window.workbench.signOutRuntime(id)); }
      finally { setRequest(undefined); }
    });
  };
  return <section className="provider-account" aria-label={t('provider.accountLabel', { provider: name })}>
    <p>{t('provider.accountTitle')} · {t(`provider.accountStatus.${state.status}`)}{state.label && ` · ${state.label}`}</p>
    {busy && <p role="status"><LoaderCircle size={13} className="spin" />{t(signingOut ? 'provider.accountSigningOut'
      : state.phase === 'waiting' ? 'provider.accountBrowser' : 'provider.accountStarting')}</p>}
    {state.phase === 'failed' && <p role="alert" className="runtime-panel-error">{t('provider.accountFailed')}</p>}
    {state.phase === 'cancelled' && <p role="status">{t('provider.accountCancelled')}</p>}
    {state.challenge && <div className="provider-account-actions">
      {state.challenge.code && <><code>{state.challenge.code}</code><CopyTextButton text={state.challenge.code}
        labels={{ copy: t('provider.accountCopyCode'), copied: t('provider.accountCodeCopied'), failed: t('provider.accountCopyFailed') }} /></>}
      <a href={state.challenge.url} target="_blank" rel="noreferrer">{t('provider.accountOpenBrowser')} <ArrowUpRight size={12} /></a>
    </div>}
    <div className="provider-account-actions">
      {busy && !signingOut && <button type="button" className="button small"
        onClick={() => void perform(`runtime-account-cancel-${id}`, () => window.workbench.cancelRuntimeSignIn(id))}>{t('common.cancel')}</button>}
      {!busy && <>
        {state.status === 'signed-in' ? <button type="button" className="button small" onClick={() => setConfirm(true)}>{t('provider.accountSignOut')}</button>
          : state.status !== 'not-required' && <>
            <button type="button" className="button small" onClick={() => run('sign-in')}>{t('provider.accountSignIn')}</button>
            {id === 'codex' && <button type="button" className="button small" onClick={() => run('sign-in', 'device')}>{t('provider.accountDevice')}</button>}
          </>}
        <button type="button" className="button small" onClick={() => setRevision(current => current + 1)}>{t('provider.accountCheck')}</button>
      </>}
    </div>
    {confirm && <Modal title={t('provider.accountSignOutTitle', { provider: name })} subtitle={t('provider.accountSignOutNote')}
      onClose={() => setConfirm(false)}><div className="modal-actions">
        <button type="button" className="button" onClick={() => setConfirm(false)}>{t('common.cancel')}</button>
        <button type="button" className="button danger" onClick={() => { setConfirm(false); run('sign-out'); }}>{t('provider.accountSignOut')}</button>
      </div></Modal>}
  </section>;
}
