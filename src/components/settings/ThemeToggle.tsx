import { useSettingsStore } from '../../stores/settingsStore';
import type { Theme } from '../../types/provider';
import { Button } from '../ui/button';
import { Sun, Moon, Monitor } from 'lucide-react';

export function ThemeToggle() {
  const { config, setTheme } = useSettingsStore();
  const currentTheme = config?.theme || 'System';

  const themes: { value: Theme; label: string; icon: typeof Sun }[] = [
    { value: 'Light', label: '浅色', icon: Sun },
    { value: 'Dark', label: '深色', icon: Moon },
    { value: 'System', label: '跟随系统', icon: Monitor },
  ];

  return (
    <div className="space-y-4">
      <h3 className="font-medium">外观</h3>
      <div className="space-y-2">
        <label className="text-sm text-muted-foreground">主题</label>
        <div className="flex gap-2">
          {themes.map(({ value, label, icon: Icon }) => (
            <Button
              key={value}
              variant={currentTheme === value ? 'default' : 'outline'}
              size="sm"
              onClick={() => setTheme(value)}
              className="flex items-center gap-2"
            >
              <Icon className="h-4 w-4" />
              {label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
