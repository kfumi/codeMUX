import { useCallback, useEffect, useRef, useState } from 'react';

import { desktopBridge, isElectronDesktop } from '../../../lib/desktop-bridge';
import { createLogger, serializeError } from '../../../lib/logger';
import { createElectronUpdaterAdapters, UPDATER_UNAVAILABLE_MESSAGE } from '../electronUpdaterAdapter';

const logger = createLogger('updater');
const LATEST_STAGE_VISIBLE_MS = 2000;

export type DownloadEvent =
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
  }
  | {
    /** 壳侧 autoUpdater 的 error 事件(独立于 IPC 返回值,先于 reject 到达)。 */
    event: 'Error';
    data: { message: string };
  };

export type UpdateStage =
  | 'idle'
  | 'checking'
  | 'available'
  | 'latest'
  | 'downloading'
  /** 安装包已下载完成,等用户确认后退出应用并进入安装向导。 */
  | 'ready'
  | 'installing'
  | 'error';

export interface UpdateProgress {
  totalBytes: number | null;
  downloadedBytes: number;
}

export interface UpdateHandle {
  version: string;
  /** 只下载安装包;resolve 即下载完成(不安装)。 */
  download: (onEvent: (event: DownloadEvent) => void) => Promise<void>;
}

export type UpdaterAdapters = {
  check: () => Promise<UpdateHandle | null>;
  /** 退出应用并把已下载的包交给安装向导(用户按向导完成安装)。 */
  install: () => Promise<void>;
};

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

let testAdapters: UpdaterAdapters | null = null;

const loadUpdaterAdapters = async (): Promise<UpdaterAdapters> => {
  if (testAdapters) {
    return testAdapters;
  }

  // Electron 壳(工单 06/09 终态):electron-updater 桥是更新器唯一后端;
  // Tauri plugin-updater 通道随壳退役移除。桥缺失时由调用方报"环境不支持"。
  if (desktopBridge) {
    return createElectronUpdaterAdapters(desktopBridge);
  }

  return {
    check: async () => {
      throw new Error(UPDATER_UNAVAILABLE_MESSAGE);
    },
    install: async () => {
      throw new Error(UPDATER_UNAVAILABLE_MESSAGE);
    },
  };
};

const isUpdaterSupported = () => isElectronDesktop() || testAdapters != null;



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
  const installRequestIdRef = useRef(0);

  const clearLatestTimer = useCallback(() => {
    if (latestTimerRef.current !== null) {
      window.clearTimeout(latestTimerRef.current);
      latestTimerRef.current = null;
    }
  }, []);

  const invalidateRequests = useCallback(() => {
    checkRequestIdRef.current += 1;
    startRequestIdRef.current += 1;
    installRequestIdRef.current += 1;
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

    // 平台分流(工单 09 终态):仅 Electron 壳支持(测试适配器注入时放行);
    // DEV 模式一律禁用;打包态 Electron 由壳侧更新器接管。
    if (!enabled || import.meta.env.DEV || !isUpdaterSupported()) {
      if (interactive) {
        setState({
          stage: 'error',
          error: '当前环境不支持更新检查，请在桌面正式环境中使用。',
        });
      }
      // throwOnError 时必须抛,不能静默 return null —— 调用方(关于页)把 null
      // 一律当成「已经是最新版本」,于是「环境不支持」会被显示成最新版本,
      // 用户完全看不出到底发生了什么(这正是 dev 态误报的由来)。
      if (throwOnError) {
        throw new Error('当前环境不支持更新检查，请在桌面正式环境中使用。');
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

  /**
   * 下载安装包。下载完成后进入 `ready`(不安装)—— 安装要等用户看到指引并确认,
   * 走 {@link installUpdate}。
   */
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

      await update.download((event) => {
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

        if (event.event === 'Error') {
          // 壳侧 error 事件先于 IPC reject 到达,立即给出可见反馈;
          // 后续 catch 会用更完整的上下文再兜一次(同 stage,幂等)。
          setState((current) => ({
            ...current,
            stage: 'error',
            error: event.data.message,
          }));
          return;
        }

        // Finished:安装包落盘完成,进入「待安装」等用户确认。
        setState((current) => ({
          ...current,
          stage: 'ready',
        }));
      });

      if (startRequestIdRef.current !== requestId) {
        return;
      }

      // download() resolve 也代表下载完成(壳在缓存命中时不会再发 Finished 事件)。
      // 只从 downloading 推进:期间若已落 error(壳侧 error 事件),不能被覆盖。
      setState((current) => current.stage === 'downloading' ? {
        ...current,
        stage: 'ready',
      } : current);
    } catch (error) {
      if (startRequestIdRef.current !== requestId) {
        return;
      }

      logger.error('下载更新失败', undefined, serializeError(error));
      setState((current) => ({
        stage: 'error',
        version: current.version,
        progress: current.progress,
        error: getErrorMessage(error, '更新下载失败'),
      }));
    }
  }, [checkForUpdates]);

  /**
   * 安装:退出应用并把已下载的包交给 NSIS 安装向导(用户按向导完成)。
   * 应用退出后渲染层不复存在,所以这里不需要(也无法)回到某个后续状态 ——
   * 失败(极少:包丢了/壳拒绝)才落 error。
   */
  const installUpdate = useCallback(async () => {
    const requestId = installRequestIdRef.current + 1;
    installRequestIdRef.current = requestId;

    setState((current) => ({
      ...current,
      stage: 'installing',
    }));

    try {
      const { install } = await loadUpdaterAdapters();
      await install();
    } catch (error) {
      if (installRequestIdRef.current !== requestId) {
        return;
      }

      logger.error('启动安装失败', undefined, serializeError(error));
      setState((current) => ({
        stage: 'error',
        version: current.version,
        progress: current.progress,
        error: getErrorMessage(error, '启动安装失败'),
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
    installUpdate,
    resetToIdle,
  };
}
