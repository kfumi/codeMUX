import { useEffect } from 'react';
import { useSettingsStore } from '../stores/settingsStore';

function applyTheme(theme: string) {
  const root = document.documentElement;
  if (theme === 'Dark') {
    root.classList.add('dark');
  } else if (theme === 'Light') {
    root.classList.remove('dark');
  } else {
    // System: follow OS preference
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (prefersDark) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }
}

export function useTheme() {
  const { config } = useSettingsStore();

  useEffect(() => {
    if (config?.theme) {
      applyTheme(config.theme);
    }
  }, [config?.theme]);

  // Listen for OS theme changes when using System theme
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (config?.theme === 'System' || !config?.theme) {
        applyTheme('System');
      }
    };
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, [config?.theme]);
}
