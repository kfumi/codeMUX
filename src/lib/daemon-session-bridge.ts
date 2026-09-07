import { createLogger } from './logger';
import { ensureDaemonClient } from './facades/daemon-facade';

const logger = createLogger('daemon-session-bridge');

type SessionEventHandler = (raw: string) => void;
type SessionStateHandler = (running: boolean) => void;

const handlers = new Map<string, SessionEventHandler>();
const stateHandlers = new Map<string, SessionStateHandler>();
const unsubscribeFns = new Map<string, () => void>();
let lastSequenceBySession = new Map<string, number>();

export function registerDaemonSessionHandler(
  sessionId: string,
  handler: SessionEventHandler,
  onState?: SessionStateHandler,
): void {
  handlers.set(sessionId, handler);
  if (onState) {
    stateHandlers.set(sessionId, onState);
  }
  void ensureDaemonSubscription(sessionId);
}

export function unregisterDaemonSessionHandler(sessionId: string): void {
  handlers.delete(sessionId);
  stateHandlers.delete(sessionId);
}

export function getLastEventSequence(sessionId: string): number {
  return lastSequenceBySession.get(sessionId) ?? -1;
}

export function setLastEventSequence(sessionId: string, sequence: number): void {
  lastSequenceBySession.set(sessionId, sequence);
}

export async function catchUpTimelineAfterSequence(sessionId: string): Promise<void> {
  const after = getLastEventSequence(sessionId);
  if (after < 0) return;
  try {
    const client = await ensureDaemonClient();
    const page = await client.getTimeline(sessionId, { direction: 'after', cursor: after, limit: 200 });
    const handler = handlers.get(sessionId);
    if (!handler) return;
    for (const event of page.events ?? []) {
      if (event && typeof event === 'object') {
        const record = event as Record<string, unknown>;
        const sequence = typeof record.sequence === 'number' ? record.sequence : null;
        if (sequence !== null) {
          setLastEventSequence(sessionId, Math.max(getLastEventSequence(sessionId), sequence));
        }
        handler(JSON.stringify(record));
      }
    }
  } catch (error) {
    logger.warn('Failed to catch up timeline after reconnect', { sessionId }, error as Error);
  }
}

async function ensureDaemonSubscription(sessionId: string): Promise<void> {
  if (unsubscribeFns.has(sessionId)) return;
  try {
    const client = await ensureDaemonClient();
    const unsubscribe = client.subscribeSession(sessionId, {
      getInitialSequence: () => getLastEventSequence(sessionId),
      onEvent: (event) => {
        const handler = handlers.get(sessionId);
        if (!handler || !event || typeof event !== 'object') return;
        const record = event as Record<string, unknown>;
        const sequence = typeof record.sequence === 'number' ? record.sequence : null;
        if (sequence !== null) {
          const last = getLastEventSequence(sessionId);
          if (sequence <= last) return;
          setLastEventSequence(sessionId, sequence);
        }
        handler(JSON.stringify(record));
      },
      onState: (running) => {
        stateHandlers.get(sessionId)?.(running);
      },
      onReconnect: () => {
        void catchUpTimelineAfterSequence(sessionId);
      },
    });
    unsubscribeFns.set(sessionId, unsubscribe);
  } catch (error) {
    logger.warn('Failed to subscribe daemon session WS', { sessionId }, error as Error);
  }
}

export function teardownDaemonSession(sessionId: string): void {
  handlers.delete(sessionId);
  stateHandlers.delete(sessionId);
  const unsubscribe = unsubscribeFns.get(sessionId);
  if (unsubscribe) {
    unsubscribe();
    unsubscribeFns.delete(sessionId);
  }
}

export function resetDaemonSessionBridge(): void {
  for (const unsubscribe of unsubscribeFns.values()) {
    unsubscribe();
  }
  handlers.clear();
  stateHandlers.clear();
  unsubscribeFns.clear();
  lastSequenceBySession.clear();
}
