import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PromptAttachment } from '../shared/types';
import type { Perform } from './ui';

export const supportsWindowCapture = navigator.platform.startsWith('Mac');

export function WindowCaptureSettings({ perform }: { perform: Perform }) {
  const { t } = useTranslation('shell');
  const [enabled, setEnabled] = useState<boolean>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!supportsWindowCapture || typeof window.workbench.windowCaptureShortcut !== 'function') return;
    let active = true;
    void perform('read-window-capture-shortcut', async () => {
      const value = await window.workbench.windowCaptureShortcut();
      if (active) setEnabled(value);
    });
    return () => { active = false; };
  }, [perform]);
  if (!supportsWindowCapture) return null;
  return <label className="notification-setting-row" data-setting-anchor="window-capture">
    <span>{t('settings.capture.shortcut')} <kbd>⌃⌥Space</kbd></span>
    <input type="checkbox" role="switch" checked={enabled ?? false} disabled={enabled === undefined || saving}
      onChange={event => {
        const value = event.currentTarget.checked;
        setSaving(true);
        void perform('set-window-capture-shortcut', async () => {
          try { setEnabled(await window.workbench.setWindowCaptureShortcut(value)); }
          finally { setSaving(false); }
        });
      }} />
  </label>;
}

export function WindowCapturePreview({ attachment }: { attachment: PromptAttachment }) {
  const [source, setSource] = useState<string>();
  useEffect(() => {
    let active = true;
    void window.workbench.readImageAttachment(attachment).then(value => { if (active) setSource(value); }).catch(() => {});
    return () => { active = false; };
  }, [attachment]);
  return source ? <img className="window-capture-preview" src={source} alt={attachment.name} /> : null;
}
