import { useCallback, useEffect, useRef, useState } from 'react';
import { relaunch as relaunchApp } from '@tauri-apps/plugin-process';
import { check as checkForTauriUpdate } from '@tauri-apps/plugin-updater';

import { createLogger, serializeError } from '../../../lib/logger';

const logger = createLogger('updater');
const LATEST_STAGE_VISIBLE_MS = 2000;

type DownloadEvent =
  | {
    event: 'Started';
    data: {
      contentLength?: number;
    };
  }
  | {
    event: 'Progress';
    data: {
      chunkLength: number;
    };
  }
  | {
    event: 'Finished';
  };

export type UpdateStage =
  | 'idle'
  | 'checking'
  | 'available'
  | 'latest'
  | 'downloading'
  | 'installing'
  | 'restarting'
  | 'error';

export interface UpdateProgress {
  totalBytes: number | null;
  downloadedBytes: number;
}

export interface UpdateHandle {
  version: string;
  downloadAndInstall: (onEvent: (event: DownloadEvent) => void) => Promise<void>;
}

export interface CheckForUpdatesOptions {
  interactive?: boolean;
  announceNoUpdate?: boolean;
  throwOnError?: boolean;
}

export interface UseUpdaterOptions {
  autoCheck?: boolean;
  enabled?: boolean;
}

interface UpdaterState {
  stage: UpdateStage;
  version?: string;
  progress?: UpdateProgress;
  error?: string;
}

type UpdaterAdapters = {
  check: () => Promise<UpdateHandle | null>;
  relaunch: () => Promise<void>;
};

let testAdapters: UpdaterAdapters | null = null;

const loadUpdaterAdapters = async (): Promise<UpdaterAdapters> => {
  if (testAdapters) {
    return testAdapters;
  }

  return {
    check: checkForTauriUpdate as UpdaterAdapters['check'],
    relaunch: relaunchApp,
  };
};

const isTauriRuntime = () => (
  typeof window !== 'undefined'
  && typeof (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined'
);

const getErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error) {
    return error;
  }

  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) {
      return message;
    }
  }

  const serialized = serializeError(error);
  return serialized || fallback;
};

export const __setUpdaterTestAdapters = (adapters: UpdaterAdapters | null) => {
  testAdapters = adapters;
};

export function useUpdater(options: UseUpdaterOptions = {}) {
  const { autoCheck = true, enabled = true } = options;
  const [state, setState] = useState<UpdaterState>({ stage: 'idle' });
  const updateRef = useRef<UpdateHandle | null>(null);
  const latestTimerRef = useRef<number | null>(null);
  const checkRequestIdRef = useRef(0);
  const startRequestIdRef = useRef(0);
  const relaunchRequestIdRef = useRef(0);

  const clearLatestTimer = useCallback(() => {
    if (latestTimerRef.current !== null) {
      window.clearTimeout(latestTimerRef.current);
      latestTimerRef.current = null;
    }
  }, []);

  const invalidateRequests = useCallback(() => {
    checkRequestIdRef.current += 1;
    startRequestIdRef.current += 1;
    relaunchRequestIdRef.current += 1;
  }, []);

  const resetToIdle = useCallback(() => {
    invalidateRequests();
    clearLatestTimer();
    updateRef.current = null;
    setState({ stage: 'idle' });
  }, [clearLatestTimer, invalidateRequests]);

  const scheduleLatestReset = useCallback(() => {
    clearLatestTimer();
    latestTimerRef.current = window.setTimeout(() => {
      latestTimerRef.current = null;
      setState((current) => current.stage === 'latest' ? { stage: 'idle' } : current);
    }, LATEST_STAGE_VISIBLE_MS);
  }, [clearLatestTimer]);

  const checkForUpdates = useCallback(async (checkOptions: CheckForUpdatesOptions = {}) => {
    const interactive = checkOptions.interactive ?? false;
    const announceNoUpdate = checkOptions.announceNoUpdate ?? interactive;
    const throwOnError = checkOptions.throwOnError ?? false;

    if (!enabled || import.meta.env.DEV || !isTauriRuntime()) {
      if (interactive) {
        setState({
          stage: 'error',
          error: '当前环境不支持更新检查，请在桌面正式环境中使用。',
        });
      }
      return null;
    }

    const requestId = checkRequestIdRef.current + 1;
    checkRequestIdRef.current = requestId;
    clearLatestTimer();

    if (interactive) {
      setState((current) => ({
        stage: 'checking',
        version: current.version,
        progress: current.progress,
      }));
    }

    try {
      const { check } = await loadUpdaterAdapters();
      const update = await check();

      if (checkRequestIdRef.current !== requestId) {
        return null;
      }

      updateRef.current = update;

      if (update) {
        setState({
          stage: 'available',
          version: update.version,
        });
        return update;
      }

      if (announceNoUpdate) {
        setState({ stage: 'latest' });
        scheduleLatestReset();
      } else {
        setState({ stage: 'idle' });
      }

      return null;
    } catch (error) {
      if (checkRequestIdRef.current !== requestId) {
        return null;
      }

      logger.error('检查更新失败', undefined, serializeError(error));
      updateRef.current = null;

      if (interactive) {
        setState({
          stage: 'error',
          error: getErrorMessage(error, '更新检查失败'),
        });
      } else {
        setState({ stage: 'idle' });
      }

      if (throwOnError) {
        throw error;
      }

      return null;
    }
  }, [clearLatestTimer, enabled, scheduleLatestReset]);

  const startUpdate = useCallback(async () => {
    const requestId = startRequestIdRef.current + 1;
    startRequestIdRef.current = requestId;

    try {
      let update = updateRef.current;

      if (!update) {
        update = await checkForUpdates({ interactive: true });
      }

      if (!update || startRequestIdRef.current !== requestId) {
        return;
      }

      let downloadedBytes = 0;

      setState({
        stage: 'downloading',
        version: update.version,
        progress: {
          totalBytes: null,
          downloadedBytes: 0,
        },
      });

      await update.downloadAndInstall((event) => {
        if (startRequestIdRef.current !== requestId) {
          return;
        }

        if (event.event === 'Started') {
          downloadedBytes = 0;
          setState((current) => ({
            ...current,
            stage: 'downloading',
            progress: {
              totalBytes: event.data.contentLength ?? null,
              downloadedBytes: 0,
            },
          }));
          return;
        }

        if (event.event === 'Progress') {
          downloadedBytes += event.data.chunkLength;
          setState((current) => ({
            ...current,
            stage: 'downloading',
            progress: {
              totalBytes: current.progress?.totalBytes ?? null,
              downloadedBytes,
            },
          }));
          return;
        }

        setState((current) => ({
          ...current,
          stage: 'installing',
        }));
      });

      await Promise.resolve();

      if (startRequestIdRef.current !== requestId) {
        return;
      }

      await relaunch();
    } catch (error) {
      if (startRequestIdRef.current !== requestId) {
        return;
      }

      logger.error('安装更新失败', undefined, serializeError(error));
      setState((current) => ({
        stage: 'error',
        version: current.version,
        progress: current.progress,
        error: getErrorMessage(error, '更新安装失败'),
      }));
    }
  }, [checkForUpdates]);

  const relaunch = useCallback(async () => {
    const requestId = relaunchRequestIdRef.current + 1;
    relaunchRequestIdRef.current = requestId;

    try {
      const { relaunch: runRelaunch } = await loadUpdaterAdapters();
      await runRelaunch();

      if (relaunchRequestIdRef.current !== requestId) {
        return;
      }

      setState((current) => ({
        ...current,
        stage: 'restarting',
      }));
    } catch (error) {
      if (relaunchRequestIdRef.current !== requestId) {
        return;
      }

      logger.error('重启应用失败', undefined, serializeError(error));
      setState((current) => ({
        stage: 'error',
        version: current.version,
        progress: current.progress,
        error: getErrorMessage(error, '应用重启失败'),
      }));
    }
  }, []);

  useEffect(() => {
    if (!autoCheck || !enabled) {
      return;
    }

    void checkForUpdates();
  }, [autoCheck, checkForUpdates, enabled]);

  useEffect(() => () => {
    invalidateRequests();
    clearLatestTimer();
  }, [clearLatestTimer, invalidateRequests]);

  return {
    ...state,
    checkForUpdates,
    startUpdate,
    relaunch,
    resetToIdle,
  };
}
