import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { applyTheme, readTheme, THEME_STORAGE_KEY, writeTheme, type Theme } from '@/lib/theme';

/**
 * Theme provider from the shadcn/ui Vite dark-mode guide: "light" / "dark" class on <html>,
 * "system" follows prefers-color-scheme (live), the choice is kept in localStorage.
 */
interface ThemeProviderState {
  theme: Theme;
  resolvedTheme: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
}

const ThemeProviderContext = createContext<ThemeProviderState | null>(null);

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  storageKey = THEME_STORAGE_KEY,
}: {
  children: ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
}) {
  const [theme, setThemeState] = useState<Theme>(() => readTheme(storageKey, defaultTheme));
  const [resolvedTheme, setResolved] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    setResolved(applyTheme(theme));
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setResolved(applyTheme('system'));
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [theme]);

  const setTheme = useCallback(
    (t: Theme) => {
      writeTheme(t, storageKey);
      setThemeState(t);
    },
    [storageKey],
  );

  const value = useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme, setTheme]);
  return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>;
}

const fallback: ThemeProviderState = { theme: 'system', resolvedTheme: 'light', setTheme: () => {} };

/** Current theme. Outside a provider (isolated component tests) it reports "system". */
export function useTheme(): ThemeProviderState {
  return useContext(ThemeProviderContext) ?? fallback;
}
