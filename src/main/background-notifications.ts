import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { i18n, resolveLanguage } from '../shared/i18n';
import type { Snapshot } from '../shared/types';
import type { BackgroundNotificationDriver } from './mac-notification-helper';
import { NotificationTransitions, notificationEnabled } from './notification-transitions';
import { readNotificationPreferences } from './preferences';

export class BackgroundNotifications {
  private readonly transitions = new NotificationTransitions();
  private readonly delivery = new AbortController();
  private pending = Promise.resolve();

  constructor(private readonly dataPath: string, private readonly driver: BackgroundNotificationDriver) {}

  observe(snapshot: Pick<Snapshot, 'sessions'>, foreground = false): void {
    const notices = this.transitions.observe(snapshot).filter(notice => this.transitions.reserve(notice));
    const { signal } = this.delivery;
    if (signal.aborted || !notices.length) return;
    const preferences = readNotificationPreferences(this.dataPath).catch(() => undefined);
    this.pending = this.pending.then(async () => {
      if (signal.aborted) return;
      const saved = await preferences;
      if (!saved?.settings.afterQuit) return;
      const { settings, language } = saved;
      const lng = resolveLanguage(language, [Intl.DateTimeFormat().resolvedOptions().locale]);
      for (const notice of notices) {
        if (signal.aborted) return;
        if (!notificationEnabled(settings, notice.reason, foreground)) continue;
        await this.driver.deliver({
          id: createHash('sha256').update(notice.key).digest('hex'),
          title: i18n.t(`native:notification.${notice.reason}`, { lng }),
          body: Array.from(notice.body.replace(/\p{Cc}+/gu, ' ')).slice(0, 512).join(''),
          silent: !settings.sound,
          dataPath: resolve(this.dataPath),
          target: notice.target,
        }, signal);
      }
    }).catch(() => {
      if (!signal.aborted) process.stderr.write('Ensemble background notifications could not complete a delivery.\n');
    });
  }

  async close(): Promise<void> {
    this.delivery.abort();
    await this.pending;
  }
}
