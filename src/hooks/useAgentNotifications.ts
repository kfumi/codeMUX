import { useEffect, useMemo, useRef, useState } from 'react';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';

import { buildAgentNotificationCandidate, shouldDispatchAgentNotification } from '../lib/agentNotifications';
import { createLogger, serializeError } from '../lib/logger';
import { appApi } from '../lib/tauri';
import { useAgentStore } from '../stores/agentStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { NotificationSound } from '../types/provider';

const logger = createLogger('agentNotifications');

function getSoundUrl(sound: NotificationSound): string {
  return `/sounds/${sound}.wav`;
}

function useAppInactive(): boolean {
  const [inactive, setInactive] = useState(() =>
    typeof document !== 'undefined' ? !document.hasFocus() : false,
  );

  useEffect(() => {
    const updateFromFocus = () => {
      setInactive(!document.hasFocus());
    };

    window.addEventListener('focus', updateFromFocus);
    window.addEventListener('blur', updateFromFocus);
    document.addEventListener('visibilitychange', updateFromFocus);

    updateFromFocus();

    return () => {
      window.removeEventListener('focus', updateFromFocus);
      window.removeEventListener('blur', updateFromFocus);
      document.removeEventListener('visibilitychange', updateFromFocus);
    };
  }, []);

  return inactive;
}

async function ensureNotificationPermission(): Promise<boolean> {
  try {
    if (await isPermissionGranted()) {
      return true;
    }
    return await requestPermission() === 'granted';
  } catch (error) {
    logger.error('Failed to check notification permission', undefined, serializeError(error));
    return false;
  }
}

function playNotificationSound(sound: NotificationSound) {
  try {
    const audio = new Audio(getSoundUrl(sound));
    audio.volume = 0.55;
    void audio.play().catch(() => {
      logger.debug('Notification sound playback failed');
    });
  } catch {
    logger.debug('Notification sound setup failed');
  }
}

async function showAppSession(sessionId: string) {
  await appApi.showMainWindow();
  const sessions = useSessionStore.getState().sessions;
  if (sessions.some((session) => session.id === sessionId)) {
    useSessionStore.getState().setActiveSession(sessionId);
  }
}

// Tauri notification actions are mobile-only. Desktop uses the Web
// Notification API so notification clicks can reopen codeMUX and select
// the originating session. The Tauri plugin remains the fallback sender.
async function sendClickableNotification(candidate: { title: string; body: string; sessionId: string }) {
  const notificationCtor = typeof window !== 'undefined' ? window.Notification : undefined;

  if (notificationCtor) {
    if (notificationCtor.permission === 'default') {
      await notificationCtor.requestPermission();
    }

    if (notificationCtor.permission === 'granted') {
      const notification = new notificationCtor(candidate.title, {
        body: candidate.body,
        tag: `codemux-${candidate.sessionId}`,
      });
      notification.onclick = () => {
        void showAppSession(candidate.sessionId);
      };
      return;
    }
  }

  if (await ensureNotificationPermission()) {
    sendNotification({
      title: candidate.title,
      body: candidate.body,
    });
  }
}

export function useAgentNotifications() {
  const events = useAgentStore((state) => state.events);
  const sessions = useSessionStore((state) => state.sessions);
  const notificationSettings = useSettingsStore((state) => state.config?.notifications);
  const isAppInactive = useAppInactive();
  const dispatchedKeysRef = useRef<Set<string>>(new Set());

  const sessionTitles = useMemo(
    () => new Map(sessions.map((session) => [session.id, session.title])),
    [sessions],
  );

  useEffect(() => {
    const settings = notificationSettings ?? {
      system_enabled: true,
      sound_enabled: false,
      sound: 'soft' as const,
    };

    for (const [sessionId, sessionEvents] of Object.entries(events)) {
      sessionEvents.forEach((event, eventIndex) => {
        const candidate = buildAgentNotificationCandidate({
          sessionId,
          event,
          eventIndex,
          sessionTitles,
        });

        if (!shouldDispatchAgentNotification({
          candidate,
          isAppInactive,
          systemEnabled: settings.system_enabled,
          alreadyDispatched: candidate ? dispatchedKeysRef.current.has(candidate.key) : false,
        }) || !candidate) {
          return;
        }

        dispatchedKeysRef.current.add(candidate.key);

        void sendClickableNotification(candidate);

        if (settings.sound_enabled) {
          playNotificationSound(settings.sound);
        }
      });
    }
  }, [events, isAppInactive, notificationSettings, sessionTitles]);
}
