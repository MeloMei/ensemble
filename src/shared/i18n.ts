import { createInstance } from 'i18next';
import type { DisplayText } from './display-text';
import { en as shellEn, zhCN as shellZh } from './locales/shell';
import { en as workspaceEn, zhCN as workspaceZh } from './locales/workspace';
import { en as collaborationEn, zhCN as collaborationZh } from './locales/collaboration';
import { en as nativeEn, zhCN as nativeZh } from './locales/native';
import { en as runtimeEn, zhCN as runtimeZh } from './locales/runtime';

export type Language = 'zh-CN' | 'en';
export type LanguagePreference = Language | 'system';
export interface LanguageState { preference: LanguagePreference; language: Language }

export const resources = {
  en: { shell: shellEn, workspace: workspaceEn, collaboration: collaborationEn, native: nativeEn, runtime: runtimeEn },
  'zh-CN': { shell: shellZh, workspace: workspaceZh, collaboration: collaborationZh, native: nativeZh, runtime: runtimeZh },
};

export const i18n = createInstance();
void i18n.init({
  resources, lng: 'zh-CN', fallbackLng: 'en', supportedLngs: ['zh-CN', 'en'],
  defaultNS: 'shell', keySeparator: false, initAsync: false,
  interpolation: { escapeValue: false },
});

export function resolveLanguage(preference: LanguagePreference, systemLanguages: readonly string[]): Language {
  if (preference !== 'system') return preference;
  return systemLanguages[0]?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export async function initializeI18n(language: Language): Promise<void> { await i18n.changeLanguage(language); }
export async function setLanguage(language: Language): Promise<void> { await i18n.changeLanguage(language); }
export function translate(key: string, values?: Record<string, unknown>): string { return i18n.t(key, values) as string; }
export function renderDisplayText(fallback: string, descriptor?: DisplayText): string {
  return descriptor && i18n.exists(descriptor.key) ? translate(descriptor.key, descriptor.values) : fallback;
}
export function formatDate(value: string | number | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(i18n.resolvedLanguage, options ?? { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(i18n.resolvedLanguage, options).format(value);
}
