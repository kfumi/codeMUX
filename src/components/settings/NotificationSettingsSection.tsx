import { Bell, Volume2 } from 'lucide-react';

import { normalizeNotificationSettings } from '../../lib/notificationSettings';
import { useSettingsStore } from '../../stores/settingsStore';
import type { NotificationSound } from '../../types/provider';
import { Button } from '../ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Switch } from '../ui/switch';

const SOUND_OPTIONS: Array<{ value: NotificationSound; label: string }> = [
  { value: 'ding', label: '默认（叮咚）' },
  { value: 'chime', label: '清脆铃声' },
  { value: 'bell', label: '钟声' },
  { value: 'success', label: '成功提示' },
];

function playPreview(sound: NotificationSound) {
  const audio = new Audio(`/sounds/${sound}.wav`);
  audio.volume = 0.55;
  void audio.play();
}

export function NotificationSettingsSection() {
  const config = useSettingsStore((state) => state.config);
  const setNotificationSettings = useSettingsStore((state) => state.setNotificationSettings);

  if (!config) return null;

  const settings = normalizeNotificationSettings(config.notifications);

  return (
    <div className="space-y-3">
      <label className="text-sm text-foreground/74">通知</label>
      <div className="space-y-3 rounded-xl bg-muted/40 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground/90">
              <Bell className="h-4 w-4 text-foreground/58" />
              系统通知
            </div>
            <p className="mt-1 text-xs leading-relaxed text-foreground/60">
              codeMUX 不活跃时，任务完成或等待你回复会显示系统通知。
            </p>
          </div>
          <Switch
            aria-label="系统通知"
            checked={settings.system_enabled}
            onCheckedChange={(checked) => {
              void setNotificationSettings({ ...settings, system_enabled: checked });
            }}
          />
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-border/55 pt-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground/90">
              <Volume2 className="h-4 w-4 text-foreground/58" />
              提示音
            </div>
            <p className="mt-1 text-xs leading-relaxed text-foreground/60">
              任务完成后可选播放短提示音，默认关闭。
            </p>
          </div>
          <Switch
            aria-label="提示音"
            checked={settings.sound_enabled}
            onCheckedChange={(checked) => {
              void setNotificationSettings({ ...settings, sound_enabled: checked });
            }}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border/55 pt-3">
          <Select
            value={settings.sound}
            disabled={!settings.sound_enabled}
            onValueChange={(value) => {
              void setNotificationSettings({ ...settings, sound: value as NotificationSound });
            }}
          >
            <SelectTrigger aria-label="提示音类型" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOUND_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={!settings.sound_enabled}
            onClick={() => playPreview(settings.sound)}
          >
            <Volume2 className="h-3.5 w-3.5" />
            试听
          </Button>
        </div>
      </div>
    </div>
  );
}
