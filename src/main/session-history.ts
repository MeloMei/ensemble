import type { Message, Session } from '../shared/types';
import type { SessionHistoryWindow } from '../shared/backend';
import { searchableMessageText } from '../shared/message-text';

export function sessionHistory(session: Session, input: { before?: string; after?: string; around?: string; limit?: number } = {}): SessionHistoryWindow {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('历史读取范围无效。');
  const cursor = input.before ?? input.after ?? input.around;
  const index = cursor === undefined ? session.messages.length : session.messages.findIndex(message => message.id === cursor);
  if (index < 0) throw new Error('历史游标已经失效，请返回最新消息。');
  const start = input.after !== undefined ? index + 1 : input.around !== undefined ? Math.max(0, index - Math.floor(limit / 2)) : Math.max(0, index - limit);
  const end = input.after !== undefined || input.around !== undefined ? Math.min(session.messages.length, start + limit) : index;
  const messages = structuredClone(session.messages.slice(start, end));
  return { messages, hasMore: start > 0, ...(start > 0 && messages.length ? { beforeCursor: messages[0].id } : {}),
    hasAfter: end < session.messages.length, ...(end < session.messages.length && messages.length ? { afterCursor: messages.at(-1)!.id } : {}) };
}

export function searchMessages(session: Session, query: string, limit = 100): { messages: Message[]; truncated: boolean } {
  if (!query.trim()) return { messages: [], truncated: false };
  const needle = query.toLocaleLowerCase();
  const messages: Message[] = [];
  for (const message of session.messages) {
    if (message.role === 'activity' && !message.event) continue;
    const text = searchableMessageText(message);
    const match = text.toLocaleLowerCase().indexOf(needle);
    if (match < 0) continue;
    if (messages.length === limit) return { messages: structuredClone(messages), truncated: true };
    const start = Math.max(0, match - 300);
    messages.push({ id: message.id, role: message.role, createdAt: message.createdAt, text: text.slice(start, start + 2000) });
  }
  return { messages: structuredClone(messages), truncated: false };
}
