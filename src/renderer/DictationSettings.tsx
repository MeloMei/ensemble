import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dictationLanguages, type DictationStatus } from '../shared/dictation';
import { AppSelect } from './AppSelect';

export function DictationSettings() {
  const { t } = useTranslation('workspace');
  const id = useId();
  const [status, setStatus] = useState<DictationStatus>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    if (typeof window.workbench.dictationStatus !== 'function') return;
    void window.workbench.dictationStatus().then(value => { if (active) setStatus(value); })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, []);
  if (!status && !error) return null;
  const label = t('dictation.settings.language');
  const hint = status?.unavailable ? t(`dictation.error.${status.unavailable}`) : t('dictation.settings.hint');
  return <section className="language-settings" data-setting-anchor="dictation-language">
    <label htmlFor={id}>{label}</label>
    <AppSelect id={id} label={label} value={status?.language ?? 'system'} disabled={saving || !status || Boolean(status.unavailable)}
      aria-describedby={`${id}-hint`} options={[
        { value: 'system', label: t('dictation.settings.system') },
        { value: 'en-US', label: 'English (US)' },
        { value: 'zh-CN', label: '普通话（中国大陆）' },
      ]}
      onChange={value => {
        const language = dictationLanguages.find(item => item === value);
        if (!status || !language || saving || status.language === language) return;
        setSaving(true);
        setError(false);
        void window.workbench.setDictationLanguage(language).then(() => setStatus({ ...status, language }))
          .catch(() => setError(true)).finally(() => setSaving(false));
      }} />
    <p id={`${id}-hint`}>{hint}</p>
    {error && <p className="field-error" role="alert">{t('dictation.settings.failed')}</p>}
  </section>;
}
