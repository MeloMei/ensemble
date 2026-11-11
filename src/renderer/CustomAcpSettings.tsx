import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { FolderOpen, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CustomAcpInput } from '../shared/types';

const emptyInput: CustomAcpInput = { name: '', command: '', args: [], environment: [] };

export function CustomAcpSettings() {
  const { t } = useTranslation('shell');
  const executableId = useId();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState(emptyInput);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const request = useRef<string | null>(null);
  const live = useRef(true);
  const cancelled = useRef(false);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (request.current) void window.workbench.cancelCustomAcp(request.current).catch(() => {});
    };
  }, []);

  const close = () => {
    setInput(emptyInput);
    setError('');
    setOpen(false);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (request.current || !input.name.trim() || !input.command) return;
    const id = crypto.randomUUID();
    request.current = id;
    cancelled.current = false;
    setError('');
    setWorking(true);
    void window.workbench.addCustomAcp(id, input).then(() => {
      if (live.current) close();
    }, failure => {
      if (live.current && !cancelled.current) setError(failure instanceof Error ? failure.message : String(failure));
    }).finally(() => {
      request.current = null;
      if (live.current) { setWorking(false); setCancelling(false); }
    });
  };
  const cancel = () => {
    if (!request.current) { close(); return; }
    cancelled.current = true;
    setCancelling(true);
    void window.workbench.cancelCustomAcp(request.current).catch(failure => {
      if (!live.current) return;
      cancelled.current = false;
      setCancelling(false);
      setError(failure instanceof Error ? failure.message : String(failure));
    });
  };
  const choose = () => {
    void window.workbench.chooseAcpExecutable().then(command => {
      if (command && live.current) setInput(current => ({ ...current, command }));
    }, failure => {
      if (live.current) setError(failure instanceof Error ? failure.message : String(failure));
    });
  };

  return <section className="plugin-section">
    <div className="plugin-section-heading">
      <div><h2>{t('provider.acpCustom')}</h2><p>{t('provider.acpPermissionNote')}</p></div>
      {!open && <button type="button" className="button" onClick={() => setOpen(true)}><Plus size={14} />{t('provider.acpAdd')}</button>}
    </div>
    {open && <form className="custom-acp-form" onSubmit={submit}>
      <p className="form-note">{t('provider.acpLaunchNote')}</p>
      <label>{t('provider.acpName')}<input required maxLength={100} disabled={working} value={input.name}
        onChange={event => setInput({ ...input, name: event.target.value })} /></label>
      <div><label htmlFor={executableId}>{t('provider.acpExecutable')}</label><div className="custom-acp-row">
        <input id={executableId} required maxLength={4096} disabled={working} value={input.command} onChange={event => setInput({ ...input, command: event.target.value })} />
        <button type="button" className="button subtle" disabled={working} onClick={choose}><FolderOpen size={14} />{t('provider.acpChooseExecutable')}</button>
      </div></div>
      <fieldset disabled={working}>
        <legend>{t('provider.acpArguments')}</legend>
        {input.args.map((arg, index) => <div className="custom-acp-row" key={index}>
          <input aria-label={t('provider.acpArgument', { index: index + 1 })} maxLength={4096} value={arg}
            onChange={event => setInput({ ...input, args: input.args.map((value, at) => at === index ? event.target.value : value) })} />
          <button type="button" className="icon-button" aria-label={t('provider.acpRemoveRow')} onClick={() => setInput({ ...input, args: input.args.filter((_, at) => at !== index) })}><X size={14} /></button>
        </div>)}
        <button type="button" className="button subtle" disabled={input.args.length >= 64} onClick={() => setInput({ ...input, args: [...input.args, ''] })}><Plus size={14} />{t('provider.acpAddArgument')}</button>
      </fieldset>
      <fieldset disabled={working}>
        <legend>{t('provider.acpEnvironment')}</legend>
        {input.environment.map((entry, index) => <div className="custom-acp-row" key={index}>
          <input required aria-label={t('provider.acpEnvKey')} pattern="[A-Za-z_][A-Za-z0-9_]{0,127}" maxLength={128} value={entry.key}
            onChange={event => setInput({ ...input, environment: input.environment.map((value, at) => at === index ? { ...value, key: event.target.value } : value) })} />
          <input type="password" aria-label={t('provider.acpEnvValue')} autoComplete="off" maxLength={4096} value={entry.value}
            onChange={event => setInput({ ...input, environment: input.environment.map((value, at) => at === index ? { ...value, value: event.target.value } : value) })} />
          <button type="button" className="icon-button" aria-label={t('provider.acpRemoveRow')} onClick={() => setInput({ ...input, environment: input.environment.filter((_, at) => at !== index) })}><X size={14} /></button>
        </div>)}
        <button type="button" className="button subtle" disabled={input.environment.length >= 64} onClick={() => setInput({ ...input, environment: [...input.environment, { key: '', value: '' }] })}><Plus size={14} />{t('provider.acpAddEnvironment')}</button>
      </fieldset>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="custom-acp-row">
        <button className="button primary" disabled={working} type="submit">{t(working ? 'provider.acpChecking' : 'provider.acpSubmit')}</button>
        <button className="button subtle" disabled={cancelling} type="button" onClick={cancel}>{t('common.cancel')}</button>
      </div>
    </form>}
  </section>;
}
