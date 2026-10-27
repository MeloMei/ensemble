import { createContext, useCallback, useMemo, useState, type ReactNode } from 'react';

export const OverlayContext = createContext<{
  top: HTMLDialogElement | null;
  register: (element: HTMLDialogElement) => () => void;
}>({ top: null, register: () => () => {} });

export function OverlayProvider({ children }: { children: ReactNode }) {
  const [dialogs, setDialogs] = useState<HTMLDialogElement[]>([]);
  const register = useCallback((element: HTMLDialogElement) => {
    setDialogs(current => current.includes(element) ? current : [...current, element]);
    return () => setDialogs(current => current.filter(item => item !== element));
  }, []);
  const value = useMemo(() => ({ top: dialogs.at(-1) ?? null, register }), [dialogs, register]);
  return <OverlayContext.Provider value={value}>{children}</OverlayContext.Provider>;
}
