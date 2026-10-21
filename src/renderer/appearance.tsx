import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { motion } from 'framer-motion';
import { SPRING_SNAPPY } from './vendor/open-claude-ui/ClaudeMotionPresets';

export type Theme = 'light' | 'dark';
export type ThemePreference = Theme | 'system';
const storageKey = 'ensemble.appearance';
const systemTheme = () => window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
const readPreference = (): ThemePreference => {
  try {
    const saved = localStorage.getItem(storageKey);
    return saved === 'dark' || saved === 'system' ? saved : 'light';
  } catch { return 'light'; }
};
const resolveTheme = (preference: ThemePreference): Theme => preference === 'system' ? systemTheme() : preference;
const applyTheme = (theme: Theme) => {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
};

export function initializeAppearance() { applyTheme(resolveTheme(readPreference())); }

const AppearanceContext = createContext<{
  theme: Theme;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
} | null>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(readPreference);
  const [system, setSystem] = useState<Theme>(systemTheme);
  const theme = preference === 'system' ? system : preference;
  useLayoutEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const changed = () => setSystem(query.matches ? 'dark' : 'light');
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    try { localStorage.setItem(storageKey, preference); } catch { /* Storage can be unavailable in restricted desktop profiles. */ }
  }, [preference]);
  const value = useMemo(() => ({ theme, preference, setPreference }), [theme, preference]);
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance() {
  const context = useContext(AppearanceContext);
  if (!context) throw new Error('AppearanceProvider is required.');
  return context;
}

export function ThemeOptions() {
  const { preference, setPreference } = useAppearance();
  const options = [
    { value: 'light', label: '浅色', Icon: Sun },
    { value: 'dark', label: '深色', Icon: Moon },
    { value: 'system', label: '跟随系统', Icon: Monitor },
  ] as const;
  return <div className="appearance-options" role="group" aria-label="界面主题">
    {options.map(({ value, label, Icon }) => <button key={value} type="button" className={`appearance-option ${preference === value ? 'selected' : ''}`} aria-pressed={preference === value} onClick={() => setPreference(value)}>
      {preference === value && <motion.span className="appearance-selection" layoutId="appearance-selection" transition={SPRING_SNAPPY} />}
      <span className={`theme-sample sample-${value}`} aria-hidden="true"><span /><span><i /><i /><i /></span></span>
      <span className="appearance-label"><Icon size={15} />{label}</span>
    </button>)}
  </div>;
}
