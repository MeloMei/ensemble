import { useTranslation } from 'react-i18next';
import { translate as t, i18n } from '../shared/i18n';
import { useContext, useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Circle, CircleAlert, CircleDot, Clock3, Folder, GitBranch, LoaderCircle, Pause, ShieldQuestion, Square, X } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import type { ProviderInfo } from '../shared/types';
import { CdsButton } from './vendor/open-claude-ui/CdsButton';
import { SPRING_SNAPPY } from './vendor/open-claude-ui/ClaudeMotionPresets';
import { OverlayContext } from './overlays';
import { AppSelect } from './AppSelect';
import { Tooltip } from './Tooltip';

export { OverlayProvider } from './overlays';

export type Perform = (key: string, action: () => Promise<unknown>) => Promise<void>;

export function ErrorToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const { t } = useTranslation('shell');
  const { top } = useContext(OverlayContext);
  return createPortal(<div className="toast" role="alert"><CircleAlert size={16} /><span>{message}</span><IconButton label={t('common.dismissNotice')} onClick={onDismiss}><X size={14} /></IconButton></div>, top ?? document.body);
}
export function statusLabel(value: string): string {
  const key = `shell:status.${value}`;
  return i18n.exists(key) ? t(key) : value;
}

export function Status({ value }: { value: string }) {
  const { t } = useTranslation('shell');
  const Glyph = value === 'completed' ? Check : value === 'running' ? CircleDot
    : value === 'waiting_approval' ? ShieldQuestion : value === 'waiting_children' ? GitBranch
    : value === 'failed' || value === 'interrupted' ? CircleAlert
    : value === 'queued' || value === 'pending' || value === 'blocked' ? Clock3
    : value === 'paused' ? Pause : value === 'cancelled' ? Square : Circle;
  return <span className={`status status-${value}`}><Glyph size={12} aria-hidden="true" />{statusLabel(value)}</span>;
}

export function IconButton({ label, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <Tooltip label={props.title ?? label}><CdsButton variant="ghost" size="icon" className="icon-button" aria-label={label} {...props}>{children}</CdsButton></Tooltip>;
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  const reduced = useReducedMotion();
  return <motion.div className="empty-state" initial={reduced ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={SPRING_SNAPPY}><div className="empty-icon">{icon}</div><h2>{title}</h2><p>{children}</p>{action}</motion.div>;
}

export function ProviderSelect({ providers, value, onChange }: { providers: ProviderInfo[]; value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation('shell');
  return <AppSelect label={t('common.agent')} value={value} onChange={onChange} required options={[
    { value: '', label: t('provider.choose'), disabled: true },
    ...providers.map(provider => ({ value: provider.id, label: `${provider.name}${provider.available ? '' : t('provider.notReadySuffix')}`, disabled: !provider.available })),
  ]} />;
}

export function defaultModelId(provider?: ProviderInfo): string | undefined {
  return provider?.models?.find(model => model.id === provider.defaultModelId)?.id;
}

export function modelName(provider: ProviderInfo | undefined, modelId: string): string {
  return provider?.models?.find(model => model.id === modelId)?.name ?? modelId;
}

export function validModelSelection(provider: ProviderInfo | undefined, modelId?: string): boolean {
  return Boolean(provider?.available && (provider.models === undefined || (usesCliModelDefault(provider) && !modelId) || provider.models.some(model => model.id === modelId)));
}

export function usesCliModelDefault(provider: ProviderInfo): boolean { return ['codex', 'claude', 'pi', 'gemini', 'cursor'].includes(provider.id); }

export function modelPolicy(provider: ProviderInfo): string | undefined {
  if (provider.id === 'opencode') return t('provider.opencodePolicy');
  if (provider.id === 'deepseek-harness') return t('provider.deepseekPolicy');
  return undefined;
}

export function ModelField({ provider, value, onChange, disabled }: { provider?: ProviderInfo; value?: string; onChange: (value: string) => void; disabled?: boolean }) {
  const { t } = useTranslation('shell');
  if (!provider?.models) return null;
  const policy = modelPolicy(provider);
  return <div className="model-field"><label>{t('provider.model')}<AppSelect label={t('provider.model')} value={value ?? ''}
    disabled={disabled || !provider.models.length} onChange={onChange} required={!usesCliModelDefault(provider)} options={[
      { value: '', disabled: !usesCliModelDefault(provider), label: usesCliModelDefault(provider) ? t('provider.cliConfiguration') : provider.models.length ? t('provider.chooseModel') : t('provider.noModels') },
      ...(value && !provider.models.some(model => model.id === value) ? [{ value, label: `${value} ${t('provider.modelUnavailableSuffix')}`, disabled: true }] : []),
      ...provider.models.map(model => ({ value: model.id, label: `${model.name}${model.free ? t('provider.freeSuffix') : provider.id === 'codex' ? t('provider.accountQuotaSuffix') : t('provider.meteredSuffix')}` })),
    ]} /></label>{policy && <p className="model-policy">{policy}</p>}</div>;
}

export function DirectoryField({ value, onChange, perform }: { value: string; onChange: (value: string) => void; perform: Perform }) {
  const { t } = useTranslation('shell');
  return <div className="directory-field"><Folder size={15} /><input value={value} onChange={event => onChange(event.target.value)} placeholder={t('common.chooseProject')} required />
    <button type="button" className="subtle-button" onClick={() => void perform('choose-directory', async () => {
      const directory = await window.workbench.chooseDirectory();
      if (directory) onChange(directory);
    })}>{t('common.choose')}</button>
  </div>;
}

export function Modal({ title, subtitle, busy, size = 'default', onClose, children }: { title: string; subtitle?: string; busy?: boolean; size?: 'default' | 'wide'; onClose: () => void; children: ReactNode }) {
  const { t } = useTranslation('shell');
  const dialog = useRef<HTMLDialogElement>(null);
  const reduced = useReducedMotion();
  const { register } = useContext(OverlayContext);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    const unregister = register(element);
    return () => { unregister(); element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [register]);
  return createPortal(<dialog ref={dialog} className="modal-backdrop" aria-label={title} onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }} onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <motion.section className={`modal${size === 'wide' ? ' modal-wide' : ''}`} initial={reduced ? false : { opacity: 0, scale: .99, y: 4 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={SPRING_SNAPPY}>
      <div className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><IconButton label={t('common.close')} disabled={busy} onClick={onClose}><X size={18} /></IconButton></div>
      {children}
    </motion.section>
  </dialog>, document.body);
}

export function BusyIcon({ busy, children }: { busy: boolean; children: ReactNode }) {
  return busy ? <LoaderCircle className="spin" size={15} /> : children;
}

export function pathName(path: string) { return path.split(/[\\/]/).filter(Boolean).pop() || path; }

export function relativeTime(date: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60_000));
  if (minutes < 1) return t('time.now');
  if (minutes < 60) return t('time.minutes', { count: minutes });
  if (minutes < 1440) return t('time.hours', { count: Math.floor(minutes / 60) });
  return t('time.days', { count: Math.floor(minutes / 1440) });
}
