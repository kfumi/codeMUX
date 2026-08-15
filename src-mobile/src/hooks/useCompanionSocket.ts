import { useEffect, useRef, useState } from 'react';

import { buildWsUrl } from '../lib/api';
import type { CompanionConnection } from '../lib/storage';

export interface WsEnvelope {
  type: 'event';
  sessionId: string;
  event: Record<string, unknown>;
}

export function useCompanionSocket(
  connection: CompanionConnection | null,
  sessionId: string | null,
  onEvent: (event: Record<string, unknown>) => void,
) {
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!connection || !sessionId) {
      setConnected(false);
      return;
    }

    let active = true;
    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;

    const connect = () => {
      socket = new WebSocket(buildWsUrl(connection, sessionId));
      socket.onopen = () => {
        if (!active) return;
        setConnected(true);
      };
      socket.onclose = () => {
        if (!active) return;
        setConnected(false);
        retryTimer = window.setTimeout(connect, 2000);
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
      if (retryTimer) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [connection, sessionId]);

  return { connected };
}
