import { Bell, BellRing, Volume2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useHostCapabilities } from '../../hooks/useHostCapabilities';
import { normalizeNotificationSettings } from '../../lib/notificationSettings';
import {
  requestWebNotificationPermission,
  webNotificationSupport,
  type WebNotificationSupport,
} from '../../lib/webNotifications';
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
import { SettingsRow } from './SettingsRow';

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
  const { presentation } = useHostCapabilities();
  const [webSupport, setWebSupport] = useState<WebNotificationSupport>(() => webNotificationSupport());

  // 权限可能在别的标签页被改动,挂载时重新读一次。
  useEffect(() => {
    setWebSupport(webNotificationSupport());
  }, []);

  if (!config) return null;

  const settings = normalizeNotificationSettings(config.notifications);

  return (
    <div className="space-y-3">
      <label className="text-ui-compact font-medium text-muted-foreground">通知</label>
      <div className="space-y-3 rounded-xl settings-tile p-4">
        {presentation.systemNotifications ? (
          <SettingsRow
            inlineControl
            label={
              <span className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-muted-foreground" />
                系统通知
              </span>
            }
            description="CodeMUX 不活跃时，任务完成或等待你回复会显示系统通知。"
            control={
              <Switch
              aria-label="系统通知"
              checked={settings.system_enabled}
              onCheckedChange={(checked) => {
                void setNotificationSettings({ ...settings, system_enabled: checked });
              }}
              />
            }
          />
        ) : presentation.webNotifications ? (
          /* 浏览器形态(工单 03):系统通知由壳承担,这里退化为可选的 Web Notification,
             未授权时静默不提示,不阻塞任何功能。 */
          <SettingsRow
            inlineControl
            label={
              <span className="flex items-center gap-2">
                <BellRing className="h-4 w-4 text-muted-foreground" />
                浏览器通知
              </span>
            }
            description="需要浏览器的通知权限。未授权时不会弹出任何提示，功能不受影响。"
            control={
              <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={webSupport === 'granted' || webSupport === 'denied' || webSupport === 'unsupported'}
              onClick={() => {
                void requestWebNotificationPermission().then(setWebSupport);
              }}
            >
              {WEB_SUPPORT_LABEL[webSupport]}
            </Button>
            }
          />
        ) : null}

        <SettingsRow
          divided
          inlineControl
          label={
            <span className="flex items-center gap-2">
              <Volume2 className="h-4 w-4 text-muted-foreground" />
              提示音
            </span>
          }
          description="任务完成后可选播放短提示音，默认关闭。"
          control={
            <Switch
            aria-label="提示音"
            checked={settings.sound_enabled}
            onCheckedChange={(checked) => {
              void setNotificationSettings({ ...settings, sound_enabled: checked });
            }}
            />
          }
        />

        <div className="flex flex-col gap-2 border-t border-border/55 pt-3 sm:flex-row sm:items-center">
          <Select
            value={settings.sound}
            disabled={!settings.sound_enabled}
            onValueChange={(value) => {
              void setNotificationSettings({ ...settings, sound: value as NotificationSound });
            }}
          >
            <SelectTrigger aria-label="提示音类型" className="w-full sm:w-44">
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

const WEB_SUPPORT_LABEL: Record<WebNotificationSupport, string> = {
  granted: '已开启',
  denied: '已被浏览器拒绝',
  unsupported: '浏览器不支持',
  default: '授权',
};
