import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { MotionConfig } from 'framer-motion';

export type Theme = 'light' | 'dark';
export const themes = ['light', 'dark', 'system'] as const;
export const textSizes = ['small', 'default', 'large'] as const;
export const codeFonts = ['system', 'menlo', 'courier'] as const;

type AppearancePreferences = {
  theme: (typeof themes)[number];
  textSize: (typeof textSizes)[number];
  codeFont: (typeof codeFonts)[number];
  codeSize: (typeof textSizes)[number];
  reduceMotion: boolean;
};

const storageKey = 'ensemble.appearance';
const darkModeQuery = '(prefers-color-scheme: dark)';
const reducedMotionQuery = '(prefers-reduced-motion: reduce)';
const defaults: AppearancePreferences = {
  theme: 'light', textSize: 'default', codeFont: 'system', codeSize: 'default', reduceMotion: false,
};

function isOption<T extends string>(options: readonly T[], value: unknown): value is T {
  return options.some(option => option === value);
}

function readPreferences(): AppearancePreferences {
  try {
    const saved = localStorage.getItem(storageKey);
    if (isOption(themes, saved)) return { ...defaults, theme: saved };
    if (!saved) return defaults;
    const value: unknown = JSON.parse(saved);
    if (!value || typeof value !== 'object') return defaults;
    const stored = value as Partial<Record<keyof AppearancePreferences, unknown>>;
    return {
      theme: isOption(themes, stored.theme) ? stored.theme : defaults.theme,
      textSize: isOption(textSizes, stored.textSize) ? stored.textSize : defaults.textSize,
      codeFont: isOption(codeFonts, stored.codeFont) ? stored.codeFont : defaults.codeFont,
      codeSize: isOption(textSizes, stored.codeSize) ? stored.codeSize : defaults.codeSize,
      reduceMotion: stored.reduceMotion === true,
    };
  } catch { return defaults; }
}

function resolveAppearance(preferences: AppearancePreferences, systemDark: boolean, systemReducedMotion: boolean) {
  const theme: Theme = preferences.theme === 'system' ? (systemDark ? 'dark' : 'light') : preferences.theme;
  return { theme, reducedMotion: preferences.reduceMotion || systemReducedMotion };
}

function applyAppearance(preferences: AppearancePreferences, theme: Theme, reducedMotion: boolean) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  root.dataset.textSize = preferences.textSize;
  root.dataset.codeFont = preferences.codeFont;
  root.dataset.codeSize = preferences.codeSize;
  root.toggleAttribute('data-reduced-motion', reducedMotion);
}

export function initializeAppearance() {
  const preferences = readPreferences();
  const { theme, reducedMotion } = resolveAppearance(preferences,
    window.matchMedia(darkModeQuery).matches, window.matchMedia(reducedMotionQuery).matches);
  applyAppearance(preferences, theme, reducedMotion);
}

const AppearanceContext = createContext<{
  theme: Theme;
  reducedMotion: boolean;
  preferences: AppearancePreferences;
  setPreference: <K extends keyof AppearancePreferences>(key: K, value: AppearancePreferences[K]) => void;
} | null>(null);

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    media.addEventListener('change', update);
    update();
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(readPreferences);
  const systemDark = useMediaQuery(darkModeQuery);
  const systemReducedMotion = useMediaQuery(reducedMotionQuery);
  const { theme, reducedMotion } = resolveAppearance(preferences, systemDark, systemReducedMotion);
  const setPreference = useCallback(<K extends keyof AppearancePreferences>(key: K, value: AppearancePreferences[K]) => {
    setPreferences(current => current[key] === value ? current : { ...current, [key]: value });
  }, []);
  useLayoutEffect(() => { applyAppearance(preferences, theme, reducedMotion); }, [preferences, theme, reducedMotion]);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch { /* Storage can be unavailable in restricted desktop profiles. */ }
  }, [preferences]);
  const value = useMemo(() => ({ theme, reducedMotion, preferences, setPreference }), [theme, reducedMotion, preferences, setPreference]);
  return <AppearanceContext.Provider value={value}>
    <MotionConfig reducedMotion={reducedMotion ? 'always' : 'never'}>{children}</MotionConfig>
  </AppearanceContext.Provider>;
}

export function useAppearance() {
  const context = useContext(AppearanceContext);
  if (!context) throw new Error('AppearanceProvider is required.');
  return context;
}

export function useReducedMotion() {
  return useAppearance().reducedMotion;
}
