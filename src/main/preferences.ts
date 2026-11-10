import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LanguagePreference } from '../shared/i18n';
import type { NotificationPreferences } from '../shared/types';

export const defaultNotificationPreferences: NotificationPreferences = {
  enabled: true, backgroundOnly: false, approvals: true, results: true, failures: true, sound: false,
};

export class DesktopPreferences {
  private preference: LanguagePreference = 'system';
  private updates = true;
  private notifications = { ...defaultNotificationPreferences };
  private windowCapture = false;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly dataPath: string) {}

  get languagePreference(): LanguagePreference { return this.preference; }
  get autoCheckUpdates(): boolean { return this.updates; }
  get notificationPreferences(): NotificationPreferences { return { ...this.notifications }; }
  get windowCaptureShortcut(): boolean { return this.windowCapture; }

  async load(): Promise<void> {
    const record = await this.readRecord();
    this.preference = record.languagePreference === 'en' || record.languagePreference === 'zh-CN' ? record.languagePreference : 'system';
    this.updates = record.autoCheckUpdates !== false;
    this.windowCapture = record.windowCaptureShortcut === true;
    if (record.notifications && typeof record.notifications === 'object') {
      for (const key of Object.keys(this.notifications) as (keyof NotificationPreferences)[]) {
        const value = (record.notifications as Record<string, unknown>)[key];
        if (typeof value === 'boolean') this.notifications[key] = value;
      }
    }
  }

  setLanguagePreference(preference: LanguagePreference): Promise<void> {
    return this.save({ languagePreference: preference }, () => { this.preference = preference; });
  }

  setAutoCheckUpdates(enabled: boolean): Promise<void> {
    return this.save({ autoCheckUpdates: enabled }, () => { this.updates = enabled; });
  }

  setWindowCaptureShortcut(enabled: boolean): Promise<void> {
    return this.save({ windowCaptureShortcut: enabled }, () => { this.windowCapture = enabled; });
  }

  setNotificationPreferences(patch: Partial<NotificationPreferences>): Promise<void> {
    return this.save(() => ({ notifications: { ...this.notifications, ...patch } }), () => {
      this.notifications = { ...this.notifications, ...patch };
    });
  }

  private save(patch: Record<string, unknown> | (() => Record<string, unknown>), committed: () => void): Promise<void> {
    const write = this.writes.then(async () => {
      const record = await this.readRecord();
      const temporary = join(this.dataPath, `preferences.${randomUUID()}.tmp`);
      await mkdir(this.dataPath, { recursive: true });
      try {
        await writeFile(temporary, `${JSON.stringify({ ...record, ...(typeof patch === 'function' ? patch() : patch) }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        await rename(temporary, join(this.dataPath, 'preferences.json'));
        committed();
      } finally { await rm(temporary, { force: true }); }
    });
    this.writes = write.catch(() => {});
    return write;
  }

  private async readRecord(): Promise<Record<string, unknown>> {
    let content: string;
    try { content = await readFile(join(this.dataPath, 'preferences.json'), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    try {
      const record: unknown = JSON.parse(content);
      return record && typeof record === 'object' && !Array.isArray(record) ? record as Record<string, unknown> : {};
    } catch { return {}; }
  }
}
