import type { ProcessEvent } from '../../shared/types';
import type { TurnContext } from './types';

export function processStatus(value: unknown): ProcessEvent['status'] {
  if (value === 'completed' || value === 'success') return 'completed';
  if (['failed', 'error', 'cancelled', 'canceled', 'interrupted', 'stopped', 'killed'].includes(String(value))) return 'failed';
  if (['running', 'in_progress', 'inProgress', 'executing'].includes(String(value))) return 'running';
  return 'pending';
}

export function processText(value: unknown, limit = 16_000): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, (_key, item) => {
      if (item && typeof item === 'object' && ['image', 'audio', 'blob'].includes(String(item.type))) return '[media omitted]';
      if (item && typeof item === 'object' && item.type === 'base64') return '[media omitted]';
      return item;
    }, 2);
  } catch { return '[无法展示该结构化数据]'; }
  text = text.replace(/data:(image|audio)\/[^;\s]+;base64,[A-Za-z0-9+/=]+/g, '[media omitted]');
  return text.length > limit ? `${text.slice(0, limit)}\n[内容已截断]` : text;
}

export function emitProcess(context: TurnContext, event: Omit<ProcessEvent, 'id'> & { id?: string }): void {
  context.emit({ type: 'structured', event: { ...event, id: event.id ?? `${context.userMessageId ?? context.session.id}:${event.kind}:${event.nativeId ?? event.title}` } });
}

export function attachmentText(name: string, text: string): string {
  return `用户附加的 UTF-8 文件：${JSON.stringify(name)}\n<attached-file>\n${text}\n</attached-file>`;
}
