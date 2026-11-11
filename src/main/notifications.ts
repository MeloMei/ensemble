import electron from 'electron';
import type { NotificationPreferences, NotificationStatus, SessionAttentionOpen, Snapshot } from '../shared/types';
import { defaultNotificationPreferences } from './preferences';
import { notificationEnabled, NotificationTransitions, type NotificationTransition } from './notification-transitions';
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

export class WorkbenchNotifications {
  private readonly driver: NotificationDriver;

  private readonly notifications = new Set<NotificationHandle>();
  private readonly transitions = new NotificationTransitions();
  private latest: NotificationStatus & { errorKey?: string };

  constructor(private readonly openSession: (target: SessionAttentionOpen) => void,
    driver: NotificationDriver = nativeDriver(),
    private readonly preferences: () => NotificationPreferences = () => defaultNotificationPreferences,
    private readonly foreground: () => boolean = () => false) {
    this.driver = driver;
    this.latest = { supported: driver.supported, state: 'idle' };
  }

  status(): NotificationStatus {
    const { errorKey, ...status } = this.latest;
    return errorKey ? { ...status, error: translate(errorKey) } : status;
  }

  observe(snapshot: Pick<Snapshot, 'sessions'>, baseline = false): void {
    for (const notice of this.transitions.observe(snapshot, baseline)) this.send(notice);
  }

  private send(notice: NotificationTransition): void {
    const settings = this.preferences();
    if (!notificationEnabled(settings, notice.reason, this.foreground()) || !this.transitions.reserve(notice)) return;
    if (!this.driver.supported) {
      this.latest = { supported: false, state: 'failed', errorKey: 'native:notification.unsupported' };
      return;
    }
    try {
      const notification = this.driver.create({
        title: translate(`native:notification.${notice.reason}`),
        body: notice.body, silent: !settings.sound,
      });
      this.notifications.add(notification);
      notification.on('show', () => { this.latest = { supported: true, state: 'shown' }; });
      notification.on('failed', (_event, failure) => {
        this.latest = { supported: true, state: 'failed', ...(typeof failure === 'string' ? { error: failure } : { errorKey: 'native:notification.deliveryFailed' }) };
        this.notifications.delete(notification);
      });
      notification.on('click', () => { this.openSession(notice.target); this.notifications.delete(notification); });
      notification.on('close', () => this.notifications.delete(notification));
      this.latest = { supported: true, state: 'requested' };
      notification.show();
    } catch (error) {
      this.latest = { supported: true, state: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  dispose(): void {
    for (const notification of this.notifications) notification.close();
    this.notifications.clear();
  }
}
