import type { NotificationPreferences, Session, SessionAttentionOpen, Snapshot } from '../shared/types';
import { reserveNotificationCooldown } from './vendor/orca/notification-burst-cooldown';

type NotificationReason = 'permission' | 'finished' | 'error';
export interface NotificationTransition {
  key: string;
  reason: NotificationReason;
  body: string;
  target: SessionAttentionOpen;
}

const activeStates = new Set<Session['status']>(['queued', 'running', 'waiting_approval', 'waiting_children']);
const categories = { permission: 'approvals', finished: 'results', error: 'failures' } as const;

export function notificationEnabled(settings: NotificationPreferences, reason: NotificationReason, foreground = false): boolean {
  return settings.enabled && settings[categories[reason]] && !(settings.backgroundOnly && foreground);
}

function transition(session: Session, reason: NotificationReason, approvalId?: string): NotificationTransition {
  const turn = session.attempts?.at(-1)?.id ?? [...session.messages].reverse().find(message => message.role === 'user')?.id ?? session.createdAt;
  return {
    key: JSON.stringify([session.id, turn, reason, approvalId]),
    reason,
    body: `${session.title} · ${session.providerId}`,
    target: {
      sessionId: session.id, reason: reason === 'permission' ? 'approval' : reason === 'finished' ? 'result' : 'failure',
      revision: session.attention?.revision, ...(approvalId ? { approvalId } : { messageId: session.attention?.messageId }),
    },
  };
}

export class NotificationTransitions {
  private readonly cooldown = new Map<string, number>();
  private previous?: Map<string, { status: Session['status']; approvals: Set<string> }>;

  observe({ sessions }: Pick<Snapshot, 'sessions'>, baseline = false): NotificationTransition[] {
    const previous = baseline ? undefined : this.previous;
    const next = new Map<string, { status: Session['status']; approvals: Set<string> }>();
    const notices: NotificationTransition[] = [];
    for (const session of sessions) {
      next.set(session.id, { status: session.status, approvals: new Set(session.approvals.map(item => item.id)) });
      if (!previous) continue;
      const old = previous.get(session.id);
      const approvals = session.approvals.filter(item => !old?.approvals.has(item.id));
      for (const approval of approvals) notices.push(transition(session, 'permission', approval.id));
      if (!approvals.length && old && activeStates.has(old.status) && (session.status === 'completed' || session.status === 'failed')) {
        notices.push(transition(session, session.status === 'completed' ? 'finished' : 'error'));
      }
    }
    this.previous = next;
    return notices;
  }

  reserve(notice: NotificationTransition): boolean {
    return reserveNotificationCooldown(this.cooldown, notice.key, Date.now());
  }
}
