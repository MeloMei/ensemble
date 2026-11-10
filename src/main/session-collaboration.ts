import { sessionCollaborationId, type SessionCollaboration, type SessionCollaborationMessage, type SessionCollaborationMessageStatus, type SessionCollaborationParticipant, type SessionHandoff } from '../shared/collaboration';
import { PROMPT_TEXT_LIMIT, type Message, type Session, type SessionAttempt } from '../shared/types';

const MESSAGE_PREVIEW_LIMIT = 280;

export function sessionTurnOutput(session: Session, attempt: SessionAttempt): string {
  const start = session.messages.findIndex(message => message.id === attempt.userMessageId);
  if (start < 0) return '';
  const index = session.attempts?.findIndex(item => item.id === attempt.id) ?? -1;
  const subsequentInputs = new Set(index >= 0 ? session.attempts?.slice(index + 1).map(item => item.userMessageId) : []);
  const end = subsequentInputs.size ? session.messages.findIndex((message, position) => position > start && subsequentInputs.has(message.id)) : -1;
  return session.messages.slice(start + 1, end < 0 ? undefined : end).filter(message => message.role === 'assistant').map(message => message.text).join('\n');
}

interface SessionQueueReceipt {
  status: SessionCollaborationMessageStatus;
  attempt?: SessionAttempt;
  message?: Message;
  error?: string;
  updatedAt?: string;
}

export function sessionQueueReceipt(session: Session | undefined, queueItemId: string): SessionQueueReceipt {
  if (!session) return { status: 'removed' };
  const queued = session.queue?.find(item => item.id === queueItemId);
  if (queued) return { status: session.queuePaused ? 'paused' : 'queued', error: session.queueHoldReason, updatedAt: queued.updatedAt };
  const attempt = session.attempts?.find(item => item.queueItemId === queueItemId);
  const updatedAt = attempt?.endedAt ?? attempt?.startedAt;
  if (!attempt || attempt.status === 'idle') return { status: 'removed', updatedAt };
  const message = session.messages.find(item => item.id === attempt.userMessageId && item.role === 'user');
  if (!message) return { status: 'removed', updatedAt };
  return { status: attempt.status, attempt, message, error: attempt.error, updatedAt };
}

function participant(session: Session): SessionCollaborationParticipant {
  return { sessionId: session.id, title: session.title, providerId: session.providerId, cwd: session.cwd };
}

function pendingContinuation(returnTo: NonNullable<SessionHandoff['returnTo']>, source: Session | undefined, target: Session | undefined,
  status: SessionCollaborationMessageStatus): 'waiting' | 'skipped' {
  if (returnTo.skipped || !source || !target || source.archived || target.archived || source.providerId !== returnTo.providerId || !source.messageTargetIds?.includes(target.id)) return 'skipped';
  if (status === 'failed' || status === 'cancelled' || status === 'interrupted' || status === 'removed') return 'skipped';
  return 'waiting';
}

function preview(text: string): string {
  return text.length <= MESSAGE_PREVIEW_LIMIT ? text : `${text.slice(0, MESSAGE_PREVIEW_LIMIT - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
}

function projectMessage(handoff: SessionHandoff, source: Session | undefined, target: Session | undefined, summarize: boolean) {
  const { id, fromSessionId, toSessionId, text, createdAt, returnTo } = handoff;
  const receipt = sessionQueueReceipt(target, handoff.targetQueueItemId);
  const continuation = returnTo?.queueItemId ? sessionQueueReceipt(source, returnTo.queueItemId) : undefined;
  const reply = target && receipt.status === 'completed' && receipt.attempt ? sessionTurnOutput(target, receipt.attempt) : undefined;
  const delivery = receipt.message?.delivery?.status;
  const message: SessionCollaborationMessage = { id, fromSessionId, toSessionId, text: summarize ? preview(text) : text, createdAt, status: receipt.status,
    ...(receipt.attempt ? { attemptId: receipt.attempt.id } : {}),
    ...(receipt.message ? { userMessageId: receipt.message.id } : {}),
    ...(delivery ? { delivery } : {}),
    ...(reply === undefined ? {} : { reply: summarize ? preview(reply) : reply.slice(0, PROMPT_TEXT_LIMIT) }),
    ...(receipt.error ? { error: summarize ? preview(receipt.error) : receipt.error } : {}),
    ...(returnTo ? { continuation: continuation?.status ?? pendingContinuation(returnTo, source, target, receipt.status) } : {}),
  };
  const updatedAt = [createdAt, receipt.updatedAt, continuation?.updatedAt]
    .reduce<string>((latest, timestamp) => timestamp && timestamp > latest ? timestamp : latest, createdAt);
  return { message, updatedAt };
}

export function sessionCollaborationMessage(sessions: readonly Session[], handoff: SessionHandoff): SessionCollaborationMessage {
  const source = sessions.find(session => session.id === handoff.fromSessionId);
  const target = sessions.find(session => session.id === handoff.toSessionId);
  return projectMessage(handoff, source, target, false).message;
}

export function projectSessionCollaborations(sessions: readonly Session[], handoffs: readonly SessionHandoff[]): SessionCollaboration[] {
  const byId = new Map(sessions.map(session => [session.id, session]));
  const pairs = new Map<string, SessionCollaboration>();
  function pair(source: Session, target: Session): SessionCollaboration {
    const [first, second] = source.id < target.id ? [source, target] : [target, source];
    const id = sessionCollaborationId(first.id, second.id);
    const existing = pairs.get(id);
    if (existing) return existing;
    const created: SessionCollaboration = { id, participants: [participant(first), participant(second)], grants: [], messages: [], updatedAt: '' };
    pairs.set(id, created);
    return created;
  }

  for (let index = handoffs.length - 1; index >= 0; index--) {
    const handoff = handoffs[index];
    const source = byId.get(handoff.fromSessionId);
    const target = byId.get(handoff.toSessionId);
    if (!source || !target || source.id === target.id || source.parentSessionId || target.parentSessionId) continue;
    const collaboration = pair(source, target);
    const { message, updatedAt } = projectMessage(handoff, source, target, true);
    collaboration.messages.push(message);
    if (updatedAt > collaboration.updatedAt) collaboration.updatedAt = updatedAt;
  }

  for (const source of sessions) {
    if (source.parentSessionId) continue;
    for (const toSessionId of new Set(source.messageTargetIds)) {
      const target = byId.get(toSessionId);
      if (!target || source.id === target.id || target.parentSessionId) continue;
      const collaboration = pair(source, target);
      collaboration.grants.push({ fromSessionId: source.id, toSessionId });
      if (!collaboration.messages.length && source.updatedAt > collaboration.updatedAt) collaboration.updatedAt = source.updatedAt;
    }
  }

  for (const collaboration of pairs.values()) {
    collaboration.messages.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  return [...pairs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}
