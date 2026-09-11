import { useCallback, useEffect, useState } from 'react';

import { companionViaDaemon } from '../lib/facades/daemon-facade';
import type { CompanionStatus } from '../types/companion';

interface UseCompanionStatusOptions {
  pollIntervalMs?: number;
  polling?: boolean;
}

export function useCompanionStatus(options: UseCompanionStatusOptions = {}) {
  const { pollIntervalMs = 12_000, polling = true } = options;
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await companionViaDaemon.getStatus();
      setStatus(next);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!polling) return undefined;
    const timer = window.setInterval(() => {
      void loadStatus();
    }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [loadStatus, pollIntervalMs, polling]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const next = await companionViaDaemon.setEnabled(enabled);
      setStatus(next);
      return next;
    } catch (err) {
      setError(String(err));
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);

  const refreshPairingCode = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await companionViaDaemon.refreshPairingCode();
      setStatus(next);
      return next;
    } catch (err) {
      setError(String(err));
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);

  const setRelayEnabled = useCallback(async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const next = await companionViaDaemon.setRelayEnabled(enabled);
      setStatus(next);
      return next;
    } catch (err) {
      setError(String(err));
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);

  const setRelayConfig = useCallback(async (endpoint: string, useTls: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const next = await companionViaDaemon.setRelayConfig(endpoint, useTls);
      setStatus(next);
      return next;
    } catch (err) {
      setError(String(err));
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    status,
    loading,
    busy,
    error,
    loadStatus,
    setEnabled,
    refreshPairingCode,
    setRelayEnabled,
    setRelayConfig,
  };
}
