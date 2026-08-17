import { Moon, Sun, SunMoon } from 'lucide-react';

import { useTheme, type ThemePreference } from '../hooks/useTheme';

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: SunMoon },
];

interface ThemeSettingsProps {
  onClose: () => void;
}

export function ThemeSettings({ onClose }: ThemeSettingsProps) {
  const { theme, setTheme } = useTheme();

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <div className="w-full max-w-sm rounded-2xl bg-background p-5 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">主题</h2>
            <p className="mt-1 text-xs text-muted-foreground">选择界面外观</p>
          </div>
          <button type="button" className="text-sm text-muted-foreground" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2">
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              className={`flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-xs transition-colors ${
                theme === value
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted/40'
              }`}
              onClick={() => setTheme(value)}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
