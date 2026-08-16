import { useEffect, useRef, useState } from 'react';

import { normalizeStoredConnection, resolveActiveConnection } from '@shared/lib/companion-connection';

import { buildWsUrl, fetchSessionEvents } from '../lib/api';
import type { CompanionConnection } from '../lib/storage';

export interface WsEnvelope {
  type: 'event';
  sessionId: string;
  event: Record<string, unknown>;
}

interface UseCompanionSocketOptions {
  onConnectionLost?: () => void;
}

export function useCompanionSocket(
  connection: CompanionConnection | null,
  sessionId: string | null,
  onEvent: (event: Record<string, unknown>) => void,
  onReconnect?: () => void,
  options: UseCompanionSocketOptions = {},
) {
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(onEvent);
  const onReconnectRef = useRef(onReconnect);
  const onConnectionLostRef = useRef(options.onConnectionLost);
  const wasConnectedRef = useRef(false);
  onEventRef.current = onEvent;
  onReconnectRef.current = onReconnect;
  onConnectionLostRef.current = options.onConnectionLost;

  useEffect(() => {
    if (!connection || !sessionId) {
      setConnected(false);
      wasConnectedRef.current = false;
      return;
    }

    const profile = normalizeStoredConnection(connection);
    const active = resolveActiveConnection(profile);
    if (active.type === 'relay') {
      let activePoll = true;
      let after = -1;
      let retryTimer: number | undefined;

      const poll = async () => {
        try {
          const events = await fetchSessionEvents(connection, sessionId, after);
          if (!activePoll) return;
          if (!wasConnectedRef.current) {
            wasConnectedRef.current = true;
            setConnected(true);
          }
          for (const event of events) {
            if (event && typeof event === 'object') {
              const record = event as Record<string, unknown>;
              const sequence = typeof record.sequence === 'number' ? record.sequence : null;
              if (sequence !== null) {
                after = Math.max(after, sequence);
              }
              onEventRef.current(record);
            }
          }
        } catch {
          if (!activePoll) return;
          setConnected(false);
          if (wasConnectedRef.current) {
            onConnectionLostRef.current?.();
          }
        }
      };

      void poll();
      const timer = window.setInterval(() => {
        void poll();
      }, 2000);

      return () => {
        activePoll = false;
        window.clearInterval(timer);
        if (retryTimer) window.clearTimeout(retryTimer);
        setConnected(false);
        wasConnectedRef.current = false;
      };
    }

    let activeSocket = true;
    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;

    const connect = () => {
      socket = new WebSocket(buildWsUrl(connection, sessionId));
      socket.onopen = () => {
        if (!activeSocket) return;
        if (wasConnectedRef.current) {
          onReconnectRef.current?.();
        }
        wasConnectedRef.current = true;
        setConnected(true);
      };
      socket.onclose = () => {
        if (!activeSocket) return;
        setConnected(false);
        if (wasConnectedRef.current) {
          onConnectionLostRef.current?.();
        }
        retryTimer = window.setTimeout(connect, 2000);
      };
      socket.onerror = () => {
        if (!activeSocket) return;
        if (wasConnectedRef.current) {
          onConnectionLostRef.current?.();
        }
      };
      socket.onmessage = (message) => {
        try {
          const payload = JSON.parse(String(message.data)) as WsEnvelope;
          if (payload.type === 'event' && payload.event) {
            onEventRef.current(payload.event);
          }
        } catch {
          // ignore malformed frames
        }
      };
    };

    connect();

    return () => {
      activeSocket = false;
      setConnected(false);
      wasConnectedRef.current = false;
      if (retryTimer) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [connection, sessionId]);

  return { connected };
}
