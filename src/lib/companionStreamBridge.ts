import { listen } from '@tauri-apps/api/event';

import { createLogger } from './logger';
import { shouldFollowBackgroundStream } from './attachToActiveTurn';
import { useAgentStore } from '@/stores/agentStore';
import { useSessionStore } from '@/stores/sessionStore';

const logger = createLogger('companionStreamBridge');
const RELOAD_DEBOUNCE_MS = 300;
const reloadTimers = new Map<string, number>();

const REFRESH_EVENT_TYPES = new Set([
  'user_message',
  'assistant_message',
  'turn_finished',
  'tool_finished',
  'error',
]);

export function initCompanionStreamBridge() {
  void listen<{ sessionId: string; payload: string }>('agent-session-stream-event', (event) => {
    const { sessionId, payload } = event.payload;
    if (!sessionId || !payload) return;

    const store = useAgentStore.getState();
    if (!shouldFollowBackgroundStream(
      Boolean(store.isRunning[sessionId]),
      Boolean(store.backgroundLive[sessionId]),
    )) {
      return;
    }

    let eventType: string | undefined;
    try {
      eventType = JSON.parse(payload)?.type;
    } catch {
      return;
    }
    if (
      eventType !== 'codemux_event_batch'
      && eventType !== 'text_delta'
      && eventType !== 'content_finished'
      && (!eventType || !REFRESH_EVENT_TYPES.has(eventType))
    ) {
      return;
    }

    const existing = reloadTimers.get(sessionId);
    if (existing) {
      window.clearTimeout(existing);
    }
    reloadTimers.set(sessionId, window.setTimeout(() => {
      reloadTimers.delete(sessionId);
      const latest = useAgentStore.getState();
      void latest.loadSessionMessages(sessionId, { force: true }).then(() => {
        if (useAgentStore.getState().backgroundLive[sessionId]) {
          return useAgentStore.getState().completeBackgroundLiveIfIdle(sessionId);
        }
        return undefined;
      }).catch((error) => {
        logger.warn('Failed to refresh session after companion stream event', { sessionId }, error as Error);
      });
      useSessionStore.getState().markSessionUnread(sessionId);
    }, RELOAD_DEBOUNCE_MS));
  });
}
