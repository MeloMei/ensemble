import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Monitor, Moon, Sun } from 'lucide-react';
import { motion } from 'framer-motion';
import { AppSelect } from './AppSelect';
import { codeFonts, textSizes, themes, useAppearance } from './appearance';
import { SPRING_SNAPPY } from './vendor/open-claude-ui/ClaudeMotionPresets';

const themeIcons = { light: Sun, dark: Moon, system: Monitor };
const codeFontNames = { menlo: 'Menlo', courier: 'Courier New' };

export function AppearanceSettings() {
  const { t } = useTranslation('shell');
  const { preferences, setPreference, reducedMotion } = useAppearance();
  const motionNote = useId();
  const selects = [
    {
      key: 'textSize', anchor: 'text-size', label: t('preferences.textSize'),
      options: textSizes.map(value => ({ value, label: t(`preferences.size.${value}`) })),
    },
    {
      key: 'codeFont', anchor: 'code-font', label: t('preferences.codeFont'),
      options: codeFonts.map(value => ({ value, label: value === 'system' ? t('preferences.systemMonospace') : codeFontNames[value] })),
    },
    {
      key: 'codeSize', anchor: 'code-size', label: t('preferences.codeSize'),
      options: textSizes.map(value => ({ value, label: t(`preferences.size.${value}`) })),
    },
  ] as const;

  return <section className="settings-appearance">
    <div data-setting-anchor="theme">
      <h3 className="preferences-heading">{t('preferences.theme')}</h3>
      <div className="appearance-options" role="group" aria-label={t('preferences.theme')}>
        {themes.map(value => {
          const Icon = themeIcons[value];
          const selected = preferences.theme === value;
          return <button key={value} type="button" className={`appearance-option${selected ? ' selected' : ''}`} aria-pressed={selected} onClick={() => setPreference('theme', value)}>
            {selected && <motion.span className="appearance-selection" layoutId={reducedMotion ? undefined : 'appearance-selection'} transition={SPRING_SNAPPY} />}
            <span className={`theme-sample sample-${value}`} aria-hidden="true"><span /><span><i /><i /><i /></span></span>
            <span className="appearance-label"><Icon size={15} />{t(`preferences.${value}`)}</span>
          </button>;
        })}
      </div>
    </div>
    {selects.map(({ key, anchor, label, options }) => <div key={key} className="appearance-setting-row" data-setting-anchor={anchor}>
      <span>{label}</span>
      <AppSelect label={label} value={preferences[key]} options={options} onChange={value => {
        const option = options.find(option => option.value === value);
        if (option) setPreference(key, option.value);
      }} />
    </div>)}
    <label className="appearance-setting-row" data-setting-anchor="reduce-motion">
      <span>{t('preferences.reduceMotion')}<small id={motionNote}>{t('preferences.reduceMotionNote')}</small></span>
      <input type="checkbox" role="switch" checked={preferences.reduceMotion}
        aria-label={t('preferences.reduceMotion')} aria-describedby={motionNote}
        onChange={event => setPreference('reduceMotion', event.currentTarget.checked)} />
    </label>
  </section>;
}
