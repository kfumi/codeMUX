import { useEffect, useRef, useState } from 'react';

import { buildWsUrl } from '../lib/api';
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

    let active = true;
    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;

    const connect = () => {
      socket = new WebSocket(buildWsUrl(connection, sessionId));
      socket.onopen = () => {
        if (!active) return;
        if (wasConnectedRef.current) {
          onReconnectRef.current?.();
        }
        wasConnectedRef.current = true;
        setConnected(true);
      };
      socket.onclose = () => {
        if (!active) return;
        setConnected(false);
        if (wasConnectedRef.current) {
          onConnectionLostRef.current?.();
        }
        retryTimer = window.setTimeout(connect, 2000);
      };
      socket.onerror = () => {
        if (!active) return;
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
      active = false;
      setConnected(false);
      wasConnectedRef.current = false;
      if (retryTimer) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [connection, sessionId]);

  return { connected };
}
