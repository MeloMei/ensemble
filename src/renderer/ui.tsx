import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Circle, CircleAlert, CircleDot, Clock3, Folder, GitBranch, LoaderCircle, Pause, ShieldQuestion, Square, X } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import type { ProviderInfo } from '../shared/types';
import { CdsButton } from './vendor/open-claude-ui/CdsButton';
import { SPRING_SNAPPY } from './vendor/open-claude-ui/ClaudeMotionPresets';

export type Perform = (key: string, action: () => Promise<unknown>) => Promise<void>;
const OverlayContext = createContext<{
  top: HTMLDialogElement | null;
  register: (element: HTMLDialogElement) => () => void;
}>({ top: null, register: () => () => {} });

export function OverlayProvider({ children }: { children: ReactNode }) {
  const [dialogs, setDialogs] = useState<HTMLDialogElement[]>([]);
  const register = useCallback((element: HTMLDialogElement) => {
    setDialogs(current => current.includes(element) ? current : [...current, element]);
    return () => setDialogs(current => current.filter(item => item !== element));
  }, []);
  const value = useMemo(() => ({ top: dialogs.at(-1) ?? null, register }), [dialogs, register]);
  return <OverlayContext.Provider value={value}>{children}</OverlayContext.Provider>;
}

export function ErrorToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const { top } = useContext(OverlayContext);
  return createPortal(<div className="toast" role="alert"><CircleAlert size={16} /><span>{message}</span><IconButton label="关闭提示" onClick={onDismiss}><X size={14} /></IconButton></div>, top ?? document.body);
}
export const labels: Record<string, string> = {
  idle: '待发送', running: '执行中', waiting_approval: '等待审批', completed: '已完成',
  failed: '失败', cancelled: '已停止', interrupted: '已中断', draft: '草稿',
  paused: '已暂停', waiting: '等待中', pending: '待执行', blocked: '前序未完成', queued: '排队中', waiting_children: '等待子任务',
};

export function Status({ value }: { value: string }) {
  const Glyph = value === 'completed' ? Check : value === 'running' ? CircleDot
    : value === 'waiting_approval' ? ShieldQuestion : value === 'waiting_children' ? GitBranch
    : value === 'failed' || value === 'interrupted' ? CircleAlert
    : value === 'queued' || value === 'pending' || value === 'blocked' ? Clock3
    : value === 'paused' ? Pause : value === 'cancelled' ? Square : Circle;
  return <span className={`status status-${value}`}><Glyph size={12} aria-hidden="true" />{labels[value] ?? value}</span>;
}

export function IconButton({ label, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <CdsButton variant="ghost" size="icon" className="icon-button" title={label} aria-label={label} {...props}>{children}</CdsButton>;
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  const reduced = useReducedMotion();
  return <motion.div className="empty-state" initial={reduced ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={SPRING_SNAPPY}><div className="empty-icon">{icon}</div><h2>{title}</h2><p>{children}</p>{action}</motion.div>;
}

export function ProviderSelect({ providers, value, onChange }: { providers: ProviderInfo[]; value: string; onChange: (value: string) => void }) {
  return <select value={value} onChange={event => onChange(event.target.value)} required>
    <option value="" disabled>选择智能体</option>
    {providers.map(provider => <option key={provider.id} value={provider.id} disabled={!provider.available}>
      {provider.name}{provider.available ? '' : ' · 未就绪'}
    </option>)}
  </select>;
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

function usesCliModelDefault(provider: ProviderInfo): boolean { return provider.id === 'codex' || provider.id === 'claude'; }

export function modelPolicy(provider: ProviderInfo): string | undefined {
  if (provider.id === 'opencode') return '仅提供官方目录中已确认免费的模型。';
  if (provider.id === 'deepseek-harness') return 'Flash 按用量计费，需官方 API key。默认每次请求最多输出 4096 tokens，推理 off。';
  return undefined;
}

export function ModelField({ provider, value, onChange, disabled }: { provider?: ProviderInfo; value?: string; onChange: (value: string) => void; disabled?: boolean }) {
  if (!provider?.models) return null;
  const policy = modelPolicy(provider);
  return <div className="model-field"><label>模型<select value={value ?? ''} disabled={disabled || !provider.models.length} onChange={event => onChange(event.target.value)} required={!usesCliModelDefault(provider)}>
    <option value="" disabled={!usesCliModelDefault(provider)}>{usesCliModelDefault(provider) ? '当前 CLI 配置' : provider.models.length ? '选择模型' : '暂无可用模型'}</option>
    {value && !provider.models.some(model => model.id === value) && <option value={value} disabled>{value} · 当前不可用</option>}
    {provider.models.map(model => <option key={model.id} value={model.id}>{model.name}{model.free ? ' · 免费' : provider.id === 'codex' ? ' · 账户额度' : ' · 计费'}</option>)}
  </select></label>{policy && <p className="model-policy">{policy}</p>}</div>;
}

export function DirectoryField({ value, onChange, perform }: { value: string; onChange: (value: string) => void; perform: Perform }) {
  return <div className="directory-field"><Folder size={15} /><input value={value} onChange={event => onChange(event.target.value)} placeholder="选择项目目录" required />
    <button type="button" className="subtle-button" onClick={() => void perform('choose-directory', async () => {
      const directory = await window.workbench.chooseDirectory();
      if (directory) onChange(directory);
    })}>选择</button>
  </div>;
}

export function Modal({ title, subtitle, busy, onClose, children }: { title: string; subtitle?: string; busy?: boolean; onClose: () => void; children: ReactNode }) {
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
  return <dialog ref={dialog} className="modal-backdrop" aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <motion.section className="modal" initial={reduced ? false : { opacity: 0, scale: .99, y: 4 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={SPRING_SNAPPY}>
      <div className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><IconButton label="关闭" disabled={busy} onClick={onClose}><X size={18} /></IconButton></div>
      {children}
    </motion.section>
  </dialog>;
}

export function BusyIcon({ busy, children }: { busy: boolean; children: ReactNode }) {
  return busy ? <LoaderCircle className="spin" size={15} /> : children;
}

export function pathName(path: string) { return path.split(/[\\/]/).filter(Boolean).pop() || path; }

export function relativeTime(date: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}
