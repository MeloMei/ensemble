import type { Session } from '../shared/types';

export function recordSessionAttention(session: Session): void {
  const reason = session.status === 'waiting_approval' ? 'approval'
    : session.status === 'completed' ? 'result'
      : session.status === 'failed' || session.status === 'interrupted' ? 'failure' : undefined;
  if (!reason) return;
  const attempt = session.attempts?.at(-1)?.id ?? session.createdAt;
  const sourceId = `${attempt}:${reason}:${reason === 'approval' ? session.approvals.map(item => item.id).join(',') : session.status}`;
  if (session.attention?.sourceId === sourceId) return;
  session.attention = { revision: (session.attention?.revision ?? 0) + 1, seenRevision: session.attention?.seenRevision ?? 0,
    reason, updatedAt: new Date().toISOString(), sourceId };
}
