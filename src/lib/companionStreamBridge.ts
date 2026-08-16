import { listen } from '@tauri-apps/api/event';

import { createLogger } from './logger';
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
    if (store.isRunning[sessionId]) {
      return;
    }

    let eventType: string | undefined;
    try {
      eventType = JSON.parse(payload)?.type;
    } catch {
      return;
    }
    if (!eventType || !REFRESH_EVENT_TYPES.has(eventType)) {
      return;
    }

    const existing = reloadTimers.get(sessionId);
    if (existing) {
      window.clearTimeout(existing);
    }
    reloadTimers.set(sessionId, window.setTimeout(() => {
      reloadTimers.delete(sessionId);
      void store.loadSessionMessages(sessionId, { force: true }).catch((error) => {
        logger.warn('Failed to refresh session after companion stream event', { sessionId }, error as Error);
      });
      useSessionStore.getState().markSessionUnread(sessionId);
    }, RELOAD_DEBOUNCE_MS));
  });
}
