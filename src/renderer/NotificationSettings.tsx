import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BackgroundNotificationAuthorization, NotificationPreferences } from '../shared/types';
import type { BackendConnectionState } from '../shared/backend';
import type { Perform } from './ui';

const notificationKeys = ['enabled', 'backgroundOnly', 'approvals', 'results', 'failures', 'sound'] as const;

export function NotificationSettings({ perform, backendConnection }: { perform: Perform; backendConnection?: BackendConnectionState }) {
  const { t } = useTranslation('shell');
  const descriptionId = useId();
  const [settings, setSettings] = useState<NotificationPreferences>();
  const [saving, setSaving] = useState<keyof NotificationPreferences>();
  const [authorization, setAuthorization] = useState<BackgroundNotificationAuthorization>();

  useEffect(() => {
    let mounted = true;
    if (typeof window.workbench.notificationPreferences !== 'function') return;
    void perform('read-notification-settings', async () => {
      const settings = await window.workbench.notificationPreferences();
      if (mounted) setSettings(settings);
    });
    return () => { mounted = false; };
  }, [perform]);

  useEffect(() => {
    let mounted = true;
    setAuthorization(undefined);
    if (typeof window.workbench.backgroundNotificationStatus !== 'function') return;
    void perform('read-background-notification-status', async () => {
      const status = await window.workbench.backgroundNotificationStatus();
      if (mounted) setAuthorization(status);
    });
    return () => { mounted = false; };
  }, [perform, backendConnection?.instanceId, backendConnection?.synced]);

  function update(key: typeof notificationKeys[number], value: boolean) {
    setSaving(key);
    void perform('save-notification-settings', async () => {
      try { setSettings(await window.workbench.setNotificationPreferences({ [key]: value })); }
      finally { setSaving(undefined); }
    });
  }

  function updateAfterQuit(enabled: boolean) {
    setSaving('afterQuit');
    void perform('save-notification-settings', async () => {
      try {
        const result = await window.workbench.setBackgroundNotifications(enabled);
        setSettings(result.preferences);
        setAuthorization(result.authorization);
      } finally { setSaving(undefined); }
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
    <label className="notification-setting-row" data-setting-anchor="notification-afterQuit">
      <span>{t('settings.notifications.afterQuit')}
        <small className="notification-setting-detail" id={descriptionId}>
          {t('settings.notifications.afterQuitDetail')}
          {authorization && authorization !== 'authorized' && <span role="status"> {t(`settings.notifications.authorization.${authorization}`)}</span>}
        </small>
      </span>
      <input type="checkbox" role="switch" aria-label={t('settings.notifications.afterQuit')} aria-describedby={descriptionId} checked={settings?.afterQuit ?? false}
        disabled={!settings || Boolean(saving) || (!settings.afterQuit && (!settings.enabled || backendConnection?.synced === false
          || !authorization || authorization === 'unsupported' || authorization === 'backend-unsupported'))}
        onChange={event => updateAfterQuit(event.currentTarget.checked)} />
    </label>
  </section>;
}
