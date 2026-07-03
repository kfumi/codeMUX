import {
  DEFAULT_NOTIFICATION_SOUND,
  NOTIFICATION_SOUNDS,
  type NotificationSettings,
  type NotificationSound,
} from '../types/provider';

export function normalizeNotificationSound(sound: unknown): NotificationSound {
  return NOTIFICATION_SOUNDS.includes(sound as NotificationSound)
    ? sound as NotificationSound
    : DEFAULT_NOTIFICATION_SOUND;
}

export function normalizeNotificationSettings(settings: Partial<NotificationSettings> | null | undefined): NotificationSettings {
  return {
    system_enabled: settings?.system_enabled ?? true,
    sound_enabled: settings?.sound_enabled ?? false,
    sound: normalizeNotificationSound(settings?.sound),
  };
}
