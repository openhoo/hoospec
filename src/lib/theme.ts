'use client';

import { useEffect, useSyncExternalStore } from 'react';
export type Theme = 'light' | 'dark' | 'system';
function preference(): Theme {
  const value = document.documentElement.dataset.theme;
  return value === 'light' || value === 'dark' ? value : 'system';
}
function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches));
}
function subscribe(listener: () => void) {
  const system = matchMedia('(prefers-color-scheme: dark)');
  const changed = () => { apply(preference()); listener(); };
  const storage = (event: StorageEvent) => {
    if (event.key === 'hoospec-theme') { const value = event.newValue; apply(value === 'dark' || value === 'light' ? value : 'system'); listener(); }
  };
  window.addEventListener('hoospec-theme', changed);
  window.addEventListener('storage', storage);
  system.addEventListener('change', changed);
  return () => { window.removeEventListener('hoospec-theme', changed); window.removeEventListener('storage', storage); system.removeEventListener('change', changed); };
}
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, preference, () => 'system' as Theme);
  useEffect(() => { apply(preference()); }, []);
  return { theme, setTheme: (next: Theme) => {
    try { localStorage.setItem('hoospec-theme', next); } catch { /* Keep the selection for this session. */ }
    apply(next); window.dispatchEvent(new Event('hoospec-theme'));
  } };
}
