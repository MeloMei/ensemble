import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LanguagePreference } from '../shared/i18n';

export class DesktopPreferences {
  private preference: LanguagePreference = 'system';
  private updates = true;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly dataPath: string) {}

  get languagePreference(): LanguagePreference { return this.preference; }
  get autoCheckUpdates(): boolean { return this.updates; }

  async load(): Promise<void> {
    const record = await this.readRecord();
    this.preference = record.languagePreference === 'en' || record.languagePreference === 'zh-CN' ? record.languagePreference : 'system';
    this.updates = record.autoCheckUpdates !== false;
  }

  setLanguagePreference(preference: LanguagePreference): Promise<void> {
    return this.save({ languagePreference: preference }, () => { this.preference = preference; });
  }

  setAutoCheckUpdates(enabled: boolean): Promise<void> {
    return this.save({ autoCheckUpdates: enabled }, () => { this.updates = enabled; });
  }

  private save(patch: Record<string, unknown>, committed: () => void): Promise<void> {
    const write = this.writes.then(async () => {
      const record = await this.readRecord();
      const temporary = join(this.dataPath, `preferences.${randomUUID()}.tmp`);
      await mkdir(this.dataPath, { recursive: true });
      try {
        await writeFile(temporary, `${JSON.stringify({ ...record, ...patch }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
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
