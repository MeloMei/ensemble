import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { RemoteDevice, RemoteDeviceInput, RemoteDeviceSnapshot, RemoteRequest } from '../shared/remote-devices';
import { AppSelect } from './AppSelect';
import { ApprovalCard } from './SessionChat';
import { Status, type Perform } from './ui';
import './RemoteDevicesPanel.css';

type Mutation = Exclude<RemoteRequest, { action: 'snapshot' }>;
type WithoutCommandId<T> = T extends Mutation ? Omit<T, 'commandId'> : never;
const emptyDevice = { name: '', destination: '', cliPath: '', nodePath: '', dataPath: '' };
type FormDevice = RemoteDeviceInput & { id?: string };

export function RemoteDevicesPanel({ visible, perform, pending }: { visible: boolean; perform: Perform; pending: Set<string> }) {
  const { t } = useTranslation('shell');
  const id = useId();
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [form, setForm] = useState<FormDevice>();
  const [remote, setRemote] = useState<{ deviceId: string; snapshot: RemoteDeviceSnapshot }>();
  const [failure, setFailure] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const mutationIds = useRef(new Map<string, { fingerprint: string; id: string }>());
  const device = devices.find(item => item.id === deviceId);
  const snapshot = remote?.deviceId === deviceId ? remote.snapshot : undefined;
  const current = snapshot?.selected?.session.id === sessionId ? snapshot.selected : undefined;
  const scope = `remote:${deviceId}`;
  const draftKey = `${scope}:${sessionId}`;
  const text = drafts[draftKey] ?? '';
  const sendKey = `${draftKey}:send`;
  const editing = pending.has('remote-device-edit');

  useEffect(() => {
    let active = true;
    if (visible) void perform('remote-device-list', async () => {
      const list = await window.workbench.listRemoteDevices();
      if (active) {
        setDevices(list);
        setDeviceId(current => list.some(device => device.id === current) ? current : list[0]?.id ?? '');
      }
    });
    return () => { active = false; };
  }, [perform, visible]);

  useEffect(() => {
    if (!visible || !deviceId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await window.workbench.remoteDeviceRequest(deviceId, { action: 'snapshot', sessionId: sessionId || undefined });
        if (active && next) { setRemote({ deviceId, snapshot: next }); setFailure(''); }
      } catch (error) {
        if (active) setFailure(error instanceof Error ? error.message : String(error));
      } finally {
        if (active) timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [deviceId, sessionId, visible, refresh]);

  function selectDevice(next: string) {
    setFailure(''); setSessionId(''); setDeviceId(next); setRemote(undefined);
  }

  async function mutate(key: string, request: WithoutCommandId<Mutation>) {
    const fingerprint = JSON.stringify(request);
    const previous = mutationIds.current.get(key);
    const commandId = previous?.fingerprint === fingerprint ? previous.id : crypto.randomUUID();
    mutationIds.current.set(key, { fingerprint, id: commandId });
    try {
      await window.workbench.remoteDeviceRequest(deviceId, { ...request, commandId });
      mutationIds.current.delete(key);
    } finally { setRefresh(current => current + 1); }
  }

  function saveDevice(event: FormEvent) {
    event.preventDefault();
    if (!form || editing) return;
    void perform('remote-device-edit', async () => {
      const list = await window.workbench.saveRemoteDevice({ ...form, nodePath: form.nodePath?.trim() || undefined, dataPath: form.dataPath?.trim() || undefined });
      setDevices(list);
      selectDevice(form.id ?? list.at(-1)?.id ?? '');
      setForm(undefined);
      setRefresh(current => current + 1);
    });
  }

  return <section className="remote-devices-panel" data-setting-anchor="remote-devices">
    <header className="settings-section-heading"><h3>{t('remote.title')}</h3><p>{t('remote.help')}</p></header>
    <div className="remote-device-controls">
      {devices.length > 0 && <AppSelect label={t('remote.device')} value={deviceId}
        options={devices.map(item => ({ value: item.id, label: item.name, description: item.destination }))} onChange={selectDevice} />}
      <button type="button" className="button small" disabled={editing} onClick={() => setForm(emptyDevice)}>{t('remote.add')}</button>
      {device && <button type="button" className="button small" disabled={editing} onClick={() => setForm(device)}>{t('remote.edit')}</button>}
      {device && <button type="button" className="button small" onClick={() => setRefresh(value => value + 1)}>{t('common.reload')}</button>}
    </div>
    {form && <form className="remote-device-form" onSubmit={saveDevice}>
      {(['name', 'destination', 'cliPath', 'nodePath', 'dataPath'] as const).map(field => <label key={field}>
        <span>{t(`remote.${field}`)}</span>
        <input name={field} required={field !== 'dataPath' && field !== 'nodePath'} value={form[field] ?? ''} disabled={editing}
          onChange={event => setForm({ ...form, [field]: event.currentTarget.value })} />
      </label>)}
      <div className="remote-device-controls">
        <button className="button primary small" disabled={editing}>{t('remote.save')}</button>
        <button type="button" className="button small" disabled={editing} onClick={() => setForm(undefined)}>{t('remote.cancel')}</button>
        {form.id && <button type="button" className="button small" disabled={editing} onClick={() => {
          if (!window.confirm(t('remote.confirmRemove', { name: form.name }))) return;
          void perform('remote-device-edit', async () => {
            const list = await window.workbench.removeRemoteDevice(form.id!);
            setDevices(list); selectDevice(list[0]?.id ?? ''); setForm(undefined);
          });
        }}>{t('remote.remove')}</button>}
      </div>
    </form>}
    {failure && <p role="alert" className="error-text">{failure}</p>}
    {device && !snapshot && !failure && <p role="status">{t('remote.connecting')}</p>}
    {snapshot && <>
      {!snapshot.sessions.length && <p role="status">{t('remote.noSessions')}</p>}
      {snapshot.limited && <p>{t('remote.limited')}</p>}
      {snapshot.sessions.length > 0 && <AppSelect label={t('remote.session')} value={sessionId}
        options={[{ value: '', label: t('remote.selectSession') }, ...snapshot.sessions.map(item => ({
          value: item.id, label: item.title, description: item.pendingApprovals ? t('remote.approvalCount', { count: item.pendingApprovals }) : item.providerId,
        }))]} onChange={setSessionId} />}
      {current && <section className="remote-session" key={draftKey} aria-labelledby={`${id}-session`}>
        <header><h4 id={`${id}-session`}>{current.session.title}</h4><Status value={current.session.status} /></header>
        <div className="remote-session-messages" aria-label={t('remote.messages')} tabIndex={0}>
          {current.messages.map(message => <article key={message.id}><strong>{t(`remote.role.${message.role}`)}</strong><p>{message.text}</p></article>)}
        </div>
        {current.approvals.map(approval => <ApprovalCard key={approval.id} approval={approval} pending={pending} perform={perform}
          transport={{ scope, disabled: Boolean(failure),
            decide: (approvalId, choiceId) => mutate(`${scope}:approval:${approvalId}`, { action: 'approve', approvalId, choiceId }),
            answer: (approvalId, answers) => mutate(`${scope}:approval:${approvalId}`, { action: 'answer', approvalId, answers }),
          }} />)}
        <form className="remote-message-form" onSubmit={event => {
          event.preventDefault();
          if (!text.trim() || pending.has(sendKey) || failure) return;
          void perform(sendKey, async () => {
            await mutate(sendKey, { action: 'send', sessionId, providerId: current.session.providerId, text });
            setDrafts(values => values[draftKey] === text ? { ...values, [draftKey]: '' } : values);
          });
        }}>
          <textarea aria-label={t('remote.prompt')} placeholder={t('remote.prompt')} maxLength={40000} value={text}
            onChange={event => setDrafts({ ...drafts, [draftKey]: event.currentTarget.value })} />
          <button className="button primary small" disabled={!text.trim() || pending.has(sendKey) || Boolean(failure)}>{t('remote.send')}</button>
        </form>
      </section>}
    </>}
  </section>;
}
