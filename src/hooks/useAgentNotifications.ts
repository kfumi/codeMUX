import { useEffect, useMemo, useRef, useState } from 'react';
import { buildAgentNotificationCandidate } from '../lib/agentNotifications';
import { desktopBridge } from '../lib/desktop-bridge';
import { createLogger } from '../lib/logger';
import { shellFacade } from '../lib/facades/shell-facade';
import { resolveNotificationChannel, showWebNotification } from '../lib/webNotifications';
import type { AgentMessage } from '../stores/agentStore';
import { useAgentStore } from '../stores/agentStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSubagentStore } from '../stores/subagentStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { NotificationSound } from '../types/provider';
import { useHostCapabilities } from './useHostCapabilities';

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
    // 桌面壳通知(工单 09):main 进程 Notification,点击经 onAgentNotificationClicked 回流。
    await shellFacade.sendAgentNotification({
      title: candidate.title,
      body: candidate.body,
      sessionId: candidate.sessionId,
    });
  } catch {
    logger.error('Failed to send system notification');
  }
}

/**
 * 浏览器形态的通知回退(工单 03):没有壳就没有系统通知,Web Notification
 * 是可选旁路 —— 未授权时静默跳过,不阻塞任何业务。
 */
function sendWebAgentNotification(candidate: { title: string; body: string; sessionId: string }): void {
  showWebNotification(candidate, {
    onClick: (sessionId) => {
      void showAppSession(sessionId);
    },
  });
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
  // 桌面壳:唤起主窗口(最小化/隐藏到托盘时)再聚焦会话;浏览器形态没有
  // 可唤起的窗口,直接落到会话切换。
  if (desktopBridge) {
    await shellFacade.showMainWindow();
  }
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

function hashTurnSeed(seed: string): string {
  let hash = 5381;
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) + hash + seed.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

// 终态通知的回合身份 = 此前 user 事件的序数 + 其内容哈希。不能用事件时间戳：
// 实时路径由渲染层 Date.now() 打戳，历史水合路径改用持久化 timestamp（sidecar
// 上报或 daemon 落库时的 UTC 时间），同一回合两条路径数值不同，切走再切回会话
// 后去重失效、提示音重播。序数在两条路径下一致（流式回显的 user 事件会被丢弃，
// 不会重复计数）；内容哈希让 rewind 编辑过的回合拿到新 key。
function buildDispatchKey(
  sessionId: string,
  candidate: { key: string; kind: string },
  events: AgentMessage[],
  eventIndex: number,
): string {
  if (isTerminalNotification(candidate)) {
    const previousUserIndex = findPreviousUserEventIndex(events, eventIndex);
    const previousUserEvent = previousUserIndex >= 0 ? events[previousUserIndex] : undefined;
    if (previousUserEvent?.kind === 'user') {
      let ordinal = 0;
      for (let index = 0; index <= previousUserIndex; index += 1) {
        if (events[index]?.kind === 'user') {
          ordinal += 1;
        }
      }
      return `terminal:${sessionId}:${candidate.kind}:turn:${ordinal}:${hashTurnSeed(previousUserEvent.data.content)}`;
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
  const capabilities = useHostCapabilities();
  const events = useAgentStore((state) => state.events);
  const eventTimestamps = useAgentStore((state) => state.eventTimestamps);
  const isRunningBySession = useAgentStore((state) => state.isRunning);
  const subagentSessions = useSubagentStore((state) => state.sessions);
  const sessions = useSessionStore((state) => state.sessions);
  const notificationSettings = useSettingsStore((state) => state.config?.notifications);
  const isAppInactive = useAppInactive();
  const seenNotificationKeysRef = useRef<Set<string>>(new Set());
  const hookStartedAtRef = useRef(Date.now());
  // Per session: the time at which its background subagents all reached a
  // terminal state. A terminal parent event stamped before this moment is the
  // intermediate continuation turn's result, not the real end of the flow —
  // the parent is about to be woken to summarize.
  const subagentsAllTerminalAtRef = useRef<Map<string, number>>(new Map());

  const sessionTitles = useMemo(
    () => new Map(sessions.map((session) => [session.id, session.title])),
    [sessions],
  );

  useEffect(() => {
    let unregister: (() => void) | undefined;

    const activateSession = (payload: unknown) => {
      const sessionId = extractNotificationSessionId(payload);
      if (sessionId) {
        void showAppSession(sessionId);
      }
    };

    // 桌面壳(工单 09):main 进程通知点击经 preload onAgentNotificationClicked 转发;
    // 载荷契约与原 Tauri emit 一致({ sessionId })。桥缺失(纯 Web)时无原生通知可点,跳过订阅。
    if (desktopBridge) {
      unregister = desktopBridge.onAgentNotificationClicked(activateSession);
    }

    return () => {
      unregister?.();
    };
  }, []);

  // Track the "all subagents terminal" transition per session BEFORE the scan
  // effect below (same commit ordering matters) so the scan can tell the
  // intermediate continuation result apart from the real end-of-flow result
  // (which arrives after the parent summarizes).
  useEffect(() => {
    for (const [sessionId, session] of Object.entries(subagentSessions)) {
      const hasRunning = session.order.some((id) => session.descriptors[id]?.status === 'running');
      if (hasRunning) {
        subagentsAllTerminalAtRef.current.delete(sessionId);
        continue;
      }
      if (session.order.length > 0 && !subagentsAllTerminalAtRef.current.has(sessionId)) {
        subagentsAllTerminalAtRef.current.set(sessionId, Date.now());
      }
    }
  }, [subagentSessions]);

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

        const dispatchKey = buildDispatchKey(sessionId, candidate, sessionEvents, i);

        if (seenNotificationKeysRef.current.has(dispatchKey)) {
          break;
        }

        // Background subagents (or the parent turn itself) still active: a
        // "task completed" ping would read as "everything is done". Hold it
        // (without marking seen) until the whole flow settles.
        if (
          isTerminalNotification(candidate)
          && (hasRunningSubagents(sessionId) || (isRunningBySession[sessionId] ?? false))
        ) {
          break;
        }

        // The parent terminal event that predates the subagents finishing is
        // the intermediate turn's result; wait for the summary turn's own
        // terminal event which arrives after them.
        const allTerminalAt = subagentsAllTerminalAtRef.current.get(sessionId);
        if (isTerminalNotification(candidate) && allTerminalAt != null) {
          const eventTime = eventTimestamps[sessionId]?.[i] ?? 0;
          if (eventTime <= allTerminalAt) {
            break;
          }
          subagentsAllTerminalAtRef.current.delete(sessionId);
        }

        seenNotificationKeysRef.current.add(dispatchKey);

        const isTerminal = isTerminalNotification(candidate);
        const eventTimestamp = eventTimestamps[sessionId]?.[i] ?? 0;
        const isLiveEvent = eventTimestamp >= hookStartedAtRef.current;

        if (shouldSendNotification) {
          const channel = resolveNotificationChannel(capabilities.presentation);
          if (channel === 'system') {
            void sendNativeAgentNotification(candidate);
          } else if (channel === 'web') {
            sendWebAgentNotification(candidate);
          }
        }

        if (settings.sound_enabled && isTerminal && isLiveEvent) {
          playNotificationSound(settings.sound);
        }

        break; // Only notify once per session
      }
    }
  }, [capabilities.presentation, eventTimestamps, events, isAppInactive, isRunningBySession, notificationSettings, sessionTitles, subagentSessions]);
}
