import electron from 'electron';
import type { NotificationStatus, Session, Snapshot } from '../shared/types';
import { reserveNotificationCooldown } from './vendor/orca/notification-burst-cooldown';
import { translate } from '../shared/i18n';

interface NotificationHandle {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  show(): void;
  close(): void;
}
export interface NotificationDriver {
  supported: boolean;
  create(input: { title: string; body: string; silent: boolean }): NotificationHandle;
}

function nativeDriver(): NotificationDriver {
  const Notification = (electron as unknown as typeof import('electron')).Notification;
  return {
    supported: !!Notification?.isSupported(),
    create: input => new Notification(input) as unknown as NotificationHandle,
  };
}

const activeStates = new Set(['queued', 'running', 'waiting_approval', 'waiting_children']);

export class WorkbenchNotifications {
  private readonly driver: NotificationDriver;
  private readonly openSession: (sessionId: string) => void;
  private readonly notifications = new Set<NotificationHandle>();
  private readonly cooldown = new Map<string, number>();
  private readonly previous = new Map<string, { status: string; approvals: Set<string> }>();
  private latest: NotificationStatus & { errorKey?: string };
  private initialized = false;

  constructor(openSession: (sessionId: string) => void, driver: NotificationDriver = nativeDriver()) {
    this.openSession = openSession;
    this.driver = driver;
    this.latest = { supported: driver.supported, state: 'idle' };
  }

  status(): NotificationStatus {
    const { errorKey, ...status } = this.latest;
    return errorKey ? { ...status, error: translate(errorKey) } : status;
  }

  observe(snapshot: Pick<Snapshot, 'sessions'>): void {
    for (const session of snapshot.sessions) {
      const previous = this.previous.get(session.id);
      if (this.initialized) {
        const approval = session.approvals.find(item => !previous?.approvals.has(item.id));
        if (approval) this.send(session, 'permission', approval.id);
        else if (previous && activeStates.has(previous.status) && ['completed', 'failed'].includes(session.status)) {
          this.send(session, session.status === 'completed' ? 'finished' : 'error');
        }
      }
      this.previous.set(session.id, { status: session.status, approvals: new Set(session.approvals.map(item => item.id)) });
    }
    const existing = new Set(snapshot.sessions.map(session => session.id));
    for (const id of this.previous.keys()) if (!existing.has(id)) this.previous.delete(id);
    this.initialized = true;
  }

  private send(session: Session, reason: 'finished' | 'error' | 'permission', approvalId = ''): void {
    const turn = session.attempts?.at(-1)?.id ?? [...session.messages].reverse().find(message => message.role === 'user')?.id ?? session.createdAt;
    if (!reserveNotificationCooldown(this.cooldown, `${session.id}:${turn}:${reason}:${approvalId}`, Date.now())) return;
    if (!this.driver.supported) {
      this.latest = { supported: false, state: 'failed', errorKey: 'native:notification.unsupported' };
      return;
    }
    try {
      const notification = this.driver.create({
        title: translate(`native:notification.${reason}`),
        body: `${session.title} · ${session.providerId}`, silent: true,
      });
      this.notifications.add(notification);
      notification.on('show', () => { this.latest = { supported: true, state: 'shown' }; });
      notification.on('failed', (_event, failure) => {
        this.latest = { supported: true, state: 'failed', ...(typeof failure === 'string' ? { error: failure } : { errorKey: 'native:notification.deliveryFailed' }) };
        this.notifications.delete(notification);
      });
      notification.on('click', () => { this.openSession(session.id); this.notifications.delete(notification); });
      notification.on('close', () => this.notifications.delete(notification));
      this.latest = { supported: true, state: 'requested' };
      notification.show();
    } catch (error) {
      this.latest = { supported: true, state: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  dispose(): void {
    for (const notification of this.notifications) notification.close();
    this.notifications.clear(); this.previous.clear();
  }
}
