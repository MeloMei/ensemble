import { hasConversationText } from '../shared/message-text';
import type { Message, Session, SessionAttention } from '../shared/types';

export function sessionIsUnread(session: Session) {
  return Boolean(session.attention && session.attention.revision > session.attention.seenRevision);
}

export function sessionAttentionReason(session: Session) {
  if (session.approvals.length > 0) return 'approval' as const;
  return sessionIsUnread(session) ? session.attention?.reason : undefined;
}

export interface SessionAttentionOpen {
  sessionId: string;
  reason: SessionAttention['reason'];
  revision?: number;
  approvalId?: string;
}

export function sessionAttentionMessage(session: Session, reason: 'failure' | 'result'): Message | undefined {
  const attentionTime = Date.parse(session.attention?.updatedAt ?? session.updatedAt);
  const cutoff = Number.isFinite(attentionTime) ? attentionTime : Number.POSITIVE_INFINITY;
  const attempts = session.attempts ?? [];
  const attempt = attempts.filter(item => Date.parse(item.endedAt ?? item.startedAt) <= cutoff &&
    (reason === 'failure' ? item.status === 'failed' || item.status === 'interrupted' : item.status === 'completed')).at(-1);
  const nextAttempt = attempt ? attempts[attempts.indexOf(attempt) + 1] : undefined;
  const from = attempt ? session.messages.findIndex(message => message.id === attempt.userMessageId) : -1;
  const before = nextAttempt ? session.messages.findIndex(message => message.id === nextAttempt.userMessageId) : -1;
  const startedAt = attempt ? Date.parse(attempt.startedAt) : Number.NEGATIVE_INFINITY;
  let completedEvent: Message | undefined;

  for (let index = (before < 0 ? session.messages.length : before) - 1; index > from; index--) {
    const message = session.messages[index];
    const createdAt = Date.parse(message.createdAt);
    if (createdAt > cutoff) continue;
    if (createdAt < startedAt || (!attempt && message.role === 'user')) break;
    if (reason === 'failure') {
      if (message.event?.status === 'failed') return message;
    } else {
      if (message.role === 'assistant' && hasConversationText(message)) return message;
      if (!completedEvent && message.event?.status === 'completed' && message.event.output?.trim()) completedEvent = message;
    }
  }
  return completedEvent;
}
