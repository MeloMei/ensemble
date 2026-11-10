import type { Session } from '../shared/types';
export type { SessionAttentionOpen } from '../shared/types';
export { sessionAttentionMessage } from '../shared/session-attention-message';

export function sessionIsUnread(session: Session) {
  return Boolean(session.attention && session.attention.revision > session.attention.seenRevision);
}

export function sessionAttentionReason(session: Session) {
  if (session.approvals.length > 0) return 'approval' as const;
  return sessionIsUnread(session) ? session.attention?.reason : undefined;
}
