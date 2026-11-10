import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NotificationPreferences } from '../shared/types';
import type { Perform } from './ui';

const notificationKeys = ['enabled', 'backgroundOnly', 'approvals', 'results', 'failures', 'sound'] as const;

export function NotificationSettings({ perform }: { perform: Perform }) {
  const { t } = useTranslation('shell');
  const [settings, setSettings] = useState<NotificationPreferences>();
  const [saving, setSaving] = useState<keyof NotificationPreferences>();

  useEffect(() => {
    let mounted = true;
    if (typeof window.workbench.notificationPreferences !== 'function') return;
    void perform('read-notification-settings', async () => {
      const settings = await window.workbench.notificationPreferences();
      if (mounted) setSettings(settings);
    });
    return () => { mounted = false; };
  }, [perform]);

  function update(key: keyof NotificationPreferences, value: boolean) {
    setSaving(key);
    void perform('save-notification-settings', async () => {
      try { setSettings(await window.workbench.setNotificationPreferences({ [key]: value })); }
      finally { setSaving(undefined); }
    });
  }

  return <section className="notification-settings">
    <h3 className="preferences-heading">{t('settings.notifications.title')}</h3>
    {notificationKeys.map(key => <label key={key} className="notification-setting-row" data-setting-anchor={`notification-${key}`}>
      <span>{t(`settings.notifications.${key}`)}</span>
      <input type="checkbox" role="switch" checked={settings?.[key] ?? false}
        disabled={!settings || Boolean(saving) || (key !== 'enabled' && !settings.enabled)}
        onChange={event => update(key, event.currentTarget.checked)} />
    </label>)}
  </section>;
}
