import { useCallback, useState, useSyncExternalStore } from 'react';

import { companionViaDaemon } from '../lib/facades/daemon-facade';
import {
  DEFAULT_COMPANION_POLL_INTERVAL_MS,
  applyCompanionStatus,
  getCompanionStatusSnapshot,
  loadCompanionStatus,
  setCompanionStatusError,
  subscribeCompanionStatus,
} from '../lib/companionStatusPoll';
import type { CompanionStatus } from '../types/companion';

interface UseCompanionStatusOptions {
  pollIntervalMs?: number;
  polling?: boolean;
}

/** silent = 后台轮询:静默拉取,不翻转 loading(默认仍保持旧的置位行为)。 */
interface LoadStatusOptions {
  silent?: boolean;
}

/** 展示用错误文案:`Error: ` 前缀对用户没意义,只保留 message。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 移动伴侣状态。状态/loading/error 由模块级单例持有(`lib/companionStatusPoll`),
 * 多个消费方共享同一个定时器与同一份快照:节拍取各订阅方 interval 的最小值,
 * 内容未变的轮询结果不会落状态,订阅组件因此不会重渲染。busy 仍是每实例的。
 */
export function useCompanionStatus(options: UseCompanionStatusOptions = {}) {
  const { pollIntervalMs = DEFAULT_COMPANION_POLL_INTERVAL_MS, polling = true } = options;

  const subscribe = useCallback(
    (listener: () => void) => subscribeCompanionStatus(listener, { pollIntervalMs, polling }),
    [pollIntervalMs, polling],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    getCompanionStatusSnapshot,
    getCompanionStatusSnapshot,
  );

  const { status, loading, error } = snapshot;
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(
    (loadOptions: LoadStatusOptions = {}) => loadCompanionStatus(loadOptions),
    [],
  );

  const runMutation = useCallback(async (mutate: () => Promise<CompanionStatus>) => {
    setBusy(true);
    setCompanionStatusError(null);
    try {
      const next = await mutate();
      applyCompanionStatus(next);
      return next;
    } catch (err) {
      setCompanionStatusError(messageOf(err));
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);

  const setEnabled = useCallback(
    (enabled: boolean) => runMutation(() => companionViaDaemon.setEnabled(enabled)),
    [runMutation],
  );

  const refreshPairingCode = useCallback(
    () => runMutation(() => companionViaDaemon.refreshPairingCode()),
    [runMutation],
  );

  const setRelayEnabled = useCallback(
    (enabled: boolean) => runMutation(() => companionViaDaemon.setRelayEnabled(enabled)),
    [runMutation],
  );

  const setRelayConfig = useCallback(
    (endpoint: string, useTls: boolean) =>
      runMutation(() => companionViaDaemon.setRelayConfig(endpoint, useTls)),
    [runMutation],
  );

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
