import { useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import { composingShortcut, displayShortcut, shortcutActionIds, shortcutActions, shortcutFromEvent, useShortcuts, type ShortcutAction } from './app-shortcuts';
import { IconButton } from './ui';

export function ShortcutSettings() {
  const { t } = useTranslation('shell');
  const shortcuts = useShortcuts();
  const [recording, setRecording] = useState<ShortcutAction>();
  const [error, setError] = useState<{ action: ShortcutAction; message: string }>();
  const close = () => { setRecording(undefined); setError(undefined); };
  const assign = (action: ShortcutAction, binding?: string) => {
    const target = binding ?? shortcutActions[action].default;
    const occupied = shortcuts.conflict(action, target);
    if (target && occupied) {
      setError({ action, message: t('shortcuts.conflict', { shortcut: displayShortcut(target), action: t(occupied) }) });
      return;
    }
    shortcuts.assign(action, binding);
    close();
  };
  const record = (action: ShortcutAction, event: KeyboardEvent<HTMLButtonElement>) => {
    if (recording !== action || composingShortcut(event.nativeEvent) || event.key === 'Tab') return;
    if (['Alt', 'Control', 'Meta', 'Shift'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (event.key === 'Escape') { close(); return; }
    const binding = shortcutFromEvent(event.nativeEvent);
    if (binding) assign(action, binding);
    else setError({ action, message: t('shortcuts.invalid') });
  };

  return <>
    <header className="settings-section-heading shortcut-settings-heading">
      <div><h3>{t('shortcuts.title')}</h3><p>{t('shortcuts.description')}</p></div>
      <button className="button subtle" type="button" disabled={!shortcuts.canRestore}
        onClick={() => { shortcuts.restoreAll(); close(); }}>{t('shortcuts.restoreAll')}</button>
    </header>
    <div className="shortcut-settings">
      {shortcutActionIds.map(action => {
        const label = t(shortcutActions[action].label);
        const binding = shortcuts.binding(action);
        const key = binding ? displayShortcut(binding) : t('shortcuts.unassigned');
        const active = recording === action;
        const message = error?.action === action ? error.message : undefined;
        return <div key={action} className="shortcut-setting-row" data-setting-anchor={`shortcut-${action}`}>
          <span>{label}</span>
          <div className="shortcut-setting-actions">
            <button className="button subtle shortcut-recorder" type="button"
              aria-label={t(active ? 'shortcuts.recordFor' : 'shortcuts.change', { action: label, shortcut: key })}
              aria-pressed={active} data-shortcut-recording={active ? '' : undefined}
              onClick={() => { setError(undefined); setRecording(active ? undefined : action); }}
              onBlur={() => { if (active) setRecording(undefined); }}
              onKeyDown={event => record(action, event)}>
              {active ? t('shortcuts.press') : binding ? <kbd>{key}</kbd> : key}
            </button>
            <IconButton type="button" label={t('shortcuts.restore', { action: label })} disabled={!shortcuts.customized(action)}
              onClick={() => assign(action)}><RotateCcw size={14} aria-hidden="true" /></IconButton>
          </div>
          {message && <p className="shortcut-setting-error" role="alert">{message}</p>}
        </div>;
      })}
    </div>
  </>;
}
