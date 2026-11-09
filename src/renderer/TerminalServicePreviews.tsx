import { Globe } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TerminalInfo, TerminalService } from '../shared/types';
import type { Perform } from './ui';
import './TerminalServicePreviews.css';

const pollInterval = 1500;
const closedDuration = 5000;
interface DisplayService extends TerminalService { closedUntil?: number }

function endpoint({ host, port }: TerminalService): string {
  return `${host === '::1' ? '[::1]' : host}:${port}`;
}

function useTerminalServices(id: string, running: boolean): DisplayService[] {
  const ready = useRef(new Map<string, DisplayService>());
  const [services, setServices] = useState<DisplayService[]>([]);
  useEffect(() => {
    if (!navigator.platform.startsWith('Mac')) return;
    let generation = 0;
    let timer: number | undefined;
    let previous = new Set<string>();
    const publish = () => setServices([...ready.current.values()].sort((a, b) => a.port - b.port || a.host.localeCompare(b.host)));

    const poll = async (token: number) => {
      const listeners = await window.workbench.listTerminalServices(id).catch(() => []);
      if (token !== generation || document.hidden) return;
      const now = Date.now();
      const sampled = new Set(listeners.map(endpoint));
      for (const [key, service] of ready.current) {
        if (service.closedUntil && service.closedUntil <= now) ready.current.delete(key);
        else if (!service.closedUntil && !sampled.has(key) && !previous.has(key)) {
          ready.current.set(key, { ...service, closedUntil: now + closedDuration });
        }
      }
      for (const listener of listeners) {
        const key = endpoint(listener);
        if (previous.has(key)) ready.current.set(key, listener);
      }
      previous = sampled;
      publish();
      timer = window.setTimeout(() => void poll(token), pollInterval);
    };
    const reschedule = () => {
      window.clearTimeout(timer);
      const token = ++generation;
      if (document.hidden) {
        previous = new Set();
        ready.current.clear();
        publish();
        return;
      }
      if (running) {
        if (typeof window.workbench.listTerminalServices === 'function') void poll(token);
        return;
      }
      const now = Date.now();
      for (const [key, service] of ready.current) {
        if (service.closedUntil && service.closedUntil <= now) ready.current.delete(key);
        else if (!service.closedUntil) ready.current.set(key, { ...service, closedUntil: now + closedDuration });
      }
      publish();
      if (ready.current.size) {
        const nextExpiry = Math.min(...[...ready.current.values()].map(service => service.closedUntil ?? now));
        timer = window.setTimeout(reschedule, Math.max(0, nextExpiry - now));
      }
    };
    reschedule();
    document.addEventListener('visibilitychange', reschedule);
    return () => {
      generation++;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', reschedule);
    };
  }, [id, running]);
  return services;
}

export function TerminalServicePreviews({ info, perform }: { info: TerminalInfo; perform: Perform }) {
  const { t } = useTranslation('workspace');
  const running = info.status === 'running';
  const services = useTerminalServices(info.id, running);
  const active = useRef(false);
  const runningRef = useRef(running);
  const pending = useRef(false);
  const [opening, setOpening] = useState(false);
  runningRef.current = running;
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  const open = (service: TerminalService) => {
    if (!running || pending.current) return;
    pending.current = true;
    setOpening(true);
    const address = endpoint(service);
    void perform(`preview-terminal-service-${info.id}`, async () => {
      try {
        const listeners = await window.workbench.listTerminalServices(info.id);
        if (!active.current || !runningRef.current || document.hidden) return;
        if (!listeners.some(listener => endpoint(listener) === address)) throw new Error(t('terminal.listenerUnavailable'));
        await window.workbench.createPreview(info.workspaceId, `http://${address}`);
      } finally {
        pending.current = false;
        if (active.current) setOpening(false);
      }
    });
  };

  if (!services.length) return null;
  return <div className="terminal-service-previews" role="group" aria-label={t('terminal.localListeners')}>
    <span><Globe size={13} />{t('terminal.localListeners')}</span>
    {services.map(service => {
      const address = endpoint(service);
      return service.closedUntil || !running
        ? <span className="terminal-service-closed" key={address}><code>{address}</code> {t('terminal.listenerClosed')}</span>
        : <button type="button" key={address} disabled={opening} onClick={() => open(service)}
          aria-label={t('terminal.previewListener', { address })}><code>{address}</code></button>;
    })}
  </div>;
}
