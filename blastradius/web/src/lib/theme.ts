/**
 * Theme storage and the pre-render class switch. The React side lives in
 * components/theme-provider.tsx (the shadcn/ui Vite dark-mode pattern, without next-themes).
 */
export type Theme = 'light' | 'dark' | 'system';
/** @deprecated use Theme */
export type ThemeChoice = Theme;

export const THEME_STORAGE_KEY = 'blastradius.theme';

export function readTheme(key = THEME_STORAGE_KEY, fallback: Theme = 'system'): Theme {
  try {
    const v = localStorage.getItem(key);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* storage unavailable (private mode, blocked site data) */
  }
  return fallback;
}

export function writeTheme(theme: Theme, key = THEME_STORAGE_KEY): void {
  try {
    localStorage.setItem(key, theme);
  } catch {
    /* storage unavailable */
  }
}

export function systemTheme(): 'light' | 'dark' {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/** Put "light" or "dark" on <html>. Call once before the first render to avoid a flash. */
export function applyTheme(theme: Theme = readTheme()): 'light' | 'dark' {
  const resolved = theme === 'system' ? systemTheme() : theme;
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
  return resolved;
}
