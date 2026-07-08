import { useEffect, useMemo, useRef, useState } from 'react';
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';

import { buildAgentNotificationCandidate } from '../lib/agentNotifications';
import { createLogger } from '../lib/logger';
import { appApi } from '../lib/tauri';
import type { AgentMessage } from '../stores/agentStore';
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

async function sendTauriNotification(candidate: { title: string; body: string; sessionId: string }): Promise<void> {
  try {
    let permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      permissionGranted = await requestPermission() === 'granted';
    }

    if (permissionGranted) {
      sendNotification({
        title: candidate.title,
        body: candidate.body,
        autoCancel: true,
        extra: { sessionId: candidate.sessionId },
      });
    }
  } catch {
    logger.error('Failed to send system notification');
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

function extractNotificationSessionId(notification: unknown): string | null {
  if (!notification || typeof notification !== 'object') {
    return null;
  }

  const extra = (notification as { extra?: unknown }).extra;
  if (!extra || typeof extra !== 'object') {
    return null;
  }

  const sessionId = (extra as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId : null;
}

async function sendClickableNotification(candidate: { title: string; body: string; sessionId: string }) {
  const notificationCtor = typeof window !== 'undefined' ? window.Notification : undefined;
  if (notificationCtor) {
    try {
      let permission = notificationCtor.permission;
      if (permission !== 'granted') {
        permission = await notificationCtor.requestPermission();
      }

      if (permission === 'granted') {
        const notification = new notificationCtor(candidate.title, {
          body: candidate.body,
          tag: `codemux-${candidate.sessionId}`,
        });
        notification.onclick = () => {
          void showAppSession(candidate.sessionId);
        };
        return;
      }
    } catch {
      logger.debug('Web Notification setup failed');
    }
  }

  await sendTauriNotification(candidate);
}

function findPreviousUserEventIndex(events: AgentMessage[], eventIndex: number): number {
  for (let index = eventIndex; index >= 0; index -= 1) {
    if (events[index]?.kind === 'user') {
      return index;
    }
  }
  return -1;
}

function buildDispatchKey(
  sessionId: string,
  candidate: { key: string; kind: string },
  events: AgentMessage[],
  eventIndex: number,
  timestamps: number[] | undefined,
): string {
  if (candidate.kind === 'task_completed' || candidate.kind === 'task_failed') {
    const previousUserIndex = findPreviousUserEventIndex(events, eventIndex);
    if (previousUserIndex >= 0) {
      return `terminal:${sessionId}:${candidate.kind}:turn:${timestamps?.[previousUserIndex] ?? previousUserIndex}`;
    }
  }

  return candidate.key;
}

function isTerminalNotification(candidate: { kind: string }): boolean {
  return candidate.kind === 'task_completed' || candidate.kind === 'task_failed';
}

export function useAgentNotifications() {
  const events = useAgentStore((state) => state.events);
  const eventTimestamps = useAgentStore((state) => state.eventTimestamps);
  const sessions = useSessionStore((state) => state.sessions);
  const notificationSettings = useSettingsStore((state) => state.config?.notifications);
  const isAppInactive = useAppInactive();
  const seenNotificationKeysRef = useRef<Set<string>>(new Set());
  const hookStartedAtRef = useRef(Date.now());

  const sessionTitles = useMemo(
    () => new Map(sessions.map((session) => [session.id, session.title])),
    [sessions],
  );

  useEffect(() => {
    let disposed = false;
    let unregister: (() => Promise<void>) | undefined;

    void onAction((notification) => {
      const sessionId = extractNotificationSessionId(notification);
      if (sessionId) {
        void showAppSession(sessionId);
      }
    })
      .then((listener) => {
        if (disposed) {
          void listener.unregister();
          return;
        }
        unregister = () => listener.unregister();
      })
      .catch(() => {
        logger.debug('Tauri notification action listener setup failed');
      });

    return () => {
      disposed = true;
      void unregister?.();
    };
  }, []);

  useEffect(() => {
    const settings = notificationSettings ?? {
      system_enabled: true,
      sound_enabled: false,
      sound: 'ding' as const,
    };

    const shouldSendNotification = isAppInactive && settings.system_enabled;

    for (const [sessionId, sessionEvents] of Object.entries(events)) {
      // Scan all events, find the latest one that should trigger a notification
      for (let i = sessionEvents.length - 1; i >= 0; i--) {
        const event = sessionEvents[i];

        const candidate = buildAgentNotificationCandidate({
          sessionId,
          event,
          eventIndex: i,
          sessionTitles,
        });

        if (!candidate) {
          continue;
        }

        const dispatchKey = buildDispatchKey(sessionId, candidate, sessionEvents, i, eventTimestamps[sessionId]);

        if (seenNotificationKeysRef.current.has(dispatchKey)) {
          break;
        }

        seenNotificationKeysRef.current.add(dispatchKey);

        const isTerminal = isTerminalNotification(candidate);
        const eventTimestamp = eventTimestamps[sessionId]?.[i] ?? 0;
        const isLiveEvent = eventTimestamp >= hookStartedAtRef.current;

        if (shouldSendNotification) {
          void sendClickableNotification(candidate);
        }

        if (settings.sound_enabled && isTerminal && isLiveEvent) {
          playNotificationSound(settings.sound);
        }

        break; // Only notify once per session
      }
    }
  }, [eventTimestamps, events, isAppInactive, notificationSettings, sessionTitles]);
}
