import { useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

import { buildAgentNotificationCandidate } from '../lib/agentNotifications';
import { createLogger } from '../lib/logger';
import { appApi } from '../lib/tauri';
import type { AgentMessage } from '../stores/agentStore';
import { useAgentStore } from '../stores/agentStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSubagentStore } from '../stores/subagentStore';
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

async function sendNativeAgentNotification(candidate: { title: string; body: string; sessionId: string }): Promise<void> {
  try {
    await appApi.sendAgentNotification({
      title: candidate.title,
      body: candidate.body,
      sessionId: candidate.sessionId,
    });
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
  let sessions = useSessionStore.getState().sessions;
  if (!sessions.some((session) => session.id === sessionId)) {
    await useSessionStore.getState().fetchSessions();
    sessions = useSessionStore.getState().sessions;
  }
  if (sessions.some((session) => session.id === sessionId)) {
    useSessionStore.getState().setActiveSession(sessionId);
  }
}

function extractNotificationSessionId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const sessionId = (payload as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId : null;
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

function hasRunningSubagents(sessionId: string): boolean {
  const session = useSubagentStore.getState().sessions[sessionId];
  if (!session) return false;
  return session.order.some((id) => session.descriptors[id]?.status === 'running');
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
    let unregister: (() => void) | undefined;

    void listen('agent-notification-clicked', (event) => {
      const sessionId = extractNotificationSessionId(event.payload);
      if (sessionId) {
        void showAppSession(sessionId);
      }
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unregister = unlisten;
      })
      .catch(() => {
        logger.debug('Agent notification click listener setup failed');
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

        // Background subagents still running: a "task completed" ping from the
        // notification-woken continuation turn would read as "everything is
        // done". Hold it (without marking seen) while any child is running.
        if (isTerminalNotification(candidate) && hasRunningSubagents(sessionId)) {
          break;
        }

        seenNotificationKeysRef.current.add(dispatchKey);

        const isTerminal = isTerminalNotification(candidate);
        const eventTimestamp = eventTimestamps[sessionId]?.[i] ?? 0;
        const isLiveEvent = eventTimestamp >= hookStartedAtRef.current;

        if (shouldSendNotification) {
          void sendNativeAgentNotification(candidate);
        }

        if (settings.sound_enabled && isTerminal && isLiveEvent) {
          playNotificationSound(settings.sound);
        }

        break; // Only notify once per session
      }
    }
  }, [eventTimestamps, events, isAppInactive, notificationSettings, sessionTitles]);

  // Async agents: when the last running subagent of a session reaches a
  // terminal state, that — not the intermediate continuation turn — is the
  // real "task finished" moment worth pinging about.
  const subagentSessions = useSubagentStore((state) => state.sessions);
  const hadRunningSubagentsRef = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    for (const [sessionId, session] of Object.entries(subagentSessions)) {
      const hadRunning = hadRunningSubagentsRef.current.get(sessionId) ?? false;
      const hasRunning = session.order.some((id) => session.descriptors[id]?.status === 'running');
      hadRunningSubagentsRef.current.set(sessionId, hasRunning);
      if (!hadRunning || hasRunning) {
        continue;
      }

      if (isAppInactive && (notificationSettings?.system_enabled ?? true)) {
        void sendNativeAgentNotification({
          title: '子智能体已完成',
          body: sessionTitles.get(sessionId) ?? sessionId,
          sessionId,
        });
      }
      if (isAppInactive && (notificationSettings?.sound_enabled ?? false)) {
        playNotificationSound(notificationSettings?.sound ?? 'ding');
      }
    }
  }, [isAppInactive, notificationSettings, sessionTitles, subagentSessions]);
}
