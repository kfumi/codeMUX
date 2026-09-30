import { useEffect } from 'react';
import { applyThemeLocally, useSettingsStore } from '../stores/settingsStore';

/**
 * 把 daemon 配置里的主题落到 `<html>`(并缓存给首帧引导脚本)。
 *
 * 实现复用 settingsStore 的 `applyThemeLocally`,而不是在这里重写一份:
 * 两份实现漂移过一次 —— 缓存/底色同步只有 store 那份有,hook 这份没有。
 */
export function useTheme() {
  const theme = useSettingsStore((state) => state.config?.theme);

  useEffect(() => {
    if (theme) {
      applyThemeLocally(theme);
    }
  }, [theme]);

  // Listen for OS theme changes when using System theme
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (theme === 'System' || !theme) {
        applyThemeLocally('System');
      }
    };
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, [theme]);
}
