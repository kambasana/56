import { useCallback, useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';
const KEY = 'blastradius.theme';

function readChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* storage unavailable */
  }
  return 'system';
}

function systemDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Apply the theme to <html> (class "dark"). Call once before first render to avoid a flash. */
export function applyTheme(choice: ThemeChoice = readChoice()): void {
  const dark = choice === 'dark' || (choice === 'system' && systemDark());
  document.documentElement.classList.toggle('dark', dark);
}

export function useTheme(): { choice: ThemeChoice; setChoice: (c: ThemeChoice) => void; cycle: () => void } {
  const [choice, setChoiceState] = useState<ThemeChoice>(readChoice);

  useEffect(() => {
    applyTheme(choice);
    if (choice !== 'system' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => applyTheme('system');
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [choice]);

  const setChoice = useCallback((c: ThemeChoice) => {
    try {
      localStorage.setItem(KEY, c);
    } catch {
      /* storage unavailable */
    }
    setChoiceState(c);
  }, []);

  const cycle = useCallback(() => {
    setChoice(choice === 'system' ? 'light' : choice === 'light' ? 'dark' : 'system');
  }, [choice, setChoice]);

  return { choice, setChoice, cycle };
}
