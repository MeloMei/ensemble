import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { i18n, setLanguage, type LanguagePreference, type LanguageState } from '../shared/i18n';
import { AppSelect } from './AppSelect';

const LanguageContext = createContext<{
  state: LanguageState;
  saving: boolean;
  error: string;
  select: (preference: LanguagePreference) => Promise<void>;
} | null>(null);

export function LanguageProvider({ initial, children }: { initial: LanguageState; children: ReactNode }) {
  const [state, setState] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const apply = useCallback(async (next: LanguageState) => {
    await setLanguage(next.language);
    document.documentElement.lang = next.language;
    setState(next);
  }, []);
  useEffect(() => window.workbench.onLanguageChanged(next => { void apply(next); }), [apply]);
  const select = useCallback(async (preference: LanguagePreference) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true); setError('');
    try { await apply(await window.workbench.setLanguage(preference)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { inFlight.current = false; setSaving(false); }
  }, [apply]);
  const value = useMemo(() => ({ state, saving, error, select }), [state, saving, error, select]);
  return <I18nextProvider i18n={i18n}><LanguageContext.Provider value={value}>{children}</LanguageContext.Provider></I18nextProvider>;
}

export function LanguageOptions() {
  const { t } = useTranslation('shell');
  const context = useContext(LanguageContext);
  if (!context) throw new Error('LanguageProvider is required.');
  return <section className="language-settings"><label htmlFor="interface-language">{t('preferences.language')}</label>
    <AppSelect id="interface-language" label={t('preferences.language')} value={context.state.preference} disabled={context.saving}
      onChange={value => { void context.select(value as LanguagePreference); }}
      options={[{ value: 'system', label: t('preferences.system') }, { value: 'zh-CN', label: '简体中文' }, { value: 'en', label: 'English' }]} /><p>{t('preferences.languageNote')}</p>{context.error && <p className="field-error" role="alert">{context.error}</p>}
  </section>;
}
