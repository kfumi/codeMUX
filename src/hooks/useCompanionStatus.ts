import { useCallback, useEffect, useState } from 'react';

import { companionApi } from '../lib/tauri';
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
  const [refreshingDevices, setRefreshingDevices] = useState(false);

  const loadStatus = useCallback(async (devicesOnly = false) => {
    if (devicesOnly) {
      setRefreshingDevices(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const next = await companionApi.getStatus();
      setStatus(next);
    } catch (err) {
      setError(String(err));
    } finally {
      if (devicesOnly) {
        setRefreshingDevices(false);
      } else {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!polling) return undefined;
    const timer = window.setInterval(() => {
      void loadStatus(true);
    }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [loadStatus, pollIntervalMs, polling]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const next = await companionApi.setEnabled(enabled);
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
      const next = await companionApi.refreshPairingCode();
      setStatus(next);
      return next;
    } catch (err) {
      setError(String(err));
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);

  const revokeDevice = useCallback(async (deviceId: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await companionApi.revokeDevice(deviceId);
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
      const next = await companionApi.setRelayEnabled(enabled);
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
    refreshingDevices,
    loadStatus,
    setEnabled,
    refreshPairingCode,
    revokeDevice,
    setRelayEnabled,
  };
}
