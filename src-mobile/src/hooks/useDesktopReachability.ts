import { useCallback, useEffect, useRef, useState } from 'react';

import { checkDesktopReachability, isAuthError } from '../lib/api';
import type { CompanionConnection } from '../lib/storage';

export type DesktopReachabilityState = 'checking' | 'online' | 'offline';

interface UseDesktopReachabilityOptions {
  enabled?: boolean;
  pollIntervalMs?: number;
  onAuthFailure?: () => void;
  onRecovered?: () => void;
}

export function useDesktopReachability(
  connection: CompanionConnection,
  options: UseDesktopReachabilityOptions = {},
) {
  const {
    enabled = true,
    pollIntervalMs = 3000,
    onAuthFailure,
    onRecovered,
  } = options;

  const [state, setState] = useState<DesktopReachabilityState>('checking');
  const [detail, setDetail] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const wasOfflineRef = useRef(false);
  const onAuthFailureRef = useRef(onAuthFailure);
  const onRecoveredRef = useRef(onRecovered);
  onAuthFailureRef.current = onAuthFailure;
  onRecoveredRef.current = onRecovered;

  const markOffline = useCallback((message: string) => {
    wasOfflineRef.current = true;
    setState('offline');
    setDetail(message);
  }, []);

  const check = useCallback(async () => {
    try {
      await checkDesktopReachability(connection);
      const wasOffline = wasOfflineRef.current;
      wasOfflineRef.current = false;
      setState('online');
      setDetail(null);
      if (wasOffline) {
        onRecoveredRef.current?.();
      }
      return true;
    } catch (error) {
      if (isAuthError(error)) {
        onAuthFailureRef.current?.();
        return false;
      }
      markOffline(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [connection, markOffline]);

  const reportUnreachable = useCallback((message = '桌面端连接已断开') => {
    markOffline(message);
  }, [markOffline]);

  const reconnect = useCallback(async () => {
    setReconnecting(true);
    try {
      return await check();
    } finally {
      setReconnecting(false);
    }
  }, [check]);

  useEffect(() => {
    if (!enabled) {
      setState('checking');
      return;
    }

    void check();
    const timer = window.setInterval(() => {
      void check();
    }, pollIntervalMs);

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void check();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [check, enabled, pollIntervalMs]);

  return {
    online: state === 'online',
    offline: state === 'offline',
    checking: state === 'checking',
    detail,
    reconnecting,
    reconnect,
    check,
    reportUnreachable,
  };
}
