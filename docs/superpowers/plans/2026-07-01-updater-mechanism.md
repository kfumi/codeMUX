# Updater Mechanism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 codeMUX 接入 Tauri 2 软件更新检测、启动静默检查、关于页手动检查、下载安装和重启流程。

**Architecture:** Tauri 层启用 updater/process 插件并配置 GitHub Releases `latest.json` 端点；前端新增 updater Hook 和 Context 作为单一状态源；`App.tsx` 挂载全局更新提示，`AboutSettings.tsx` 提供手动检查入口。

**Tech Stack:** Tauri 2、`@tauri-apps/plugin-updater`、`@tauri-apps/plugin-process`、React 18、Vitest、Testing Library、shadcn/ui、lucide-react。

---

## File Structure

- Modify: `package.json`
  - 增加 `@tauri-apps/plugin-updater` 和 `@tauri-apps/plugin-process` 依赖。
- Modify: `src-tauri/Cargo.toml`
  - 增加 `tauri-plugin-updater` 和 `tauri-plugin-process` 依赖。
- Modify: `src-tauri/src/lib.rs`
  - 注册 process 和 updater 插件。
- Modify: `src-tauri/tauri.conf.json`
  - 开启 `bundle.createUpdaterArtifacts`。
  - 增加 `plugins.updater.pubkey` 占位值和 GitHub Releases endpoint。
- Modify: `src-tauri/capabilities/default.json`
  - 增加 updater/process 权限。
- Create: `src/features/update/hooks/useUpdater.ts`
  - 负责更新状态机、Tauri API 调用、并发保护、自动检查、下载进度和重启。
- Create: `src/features/update/hooks/useUpdater.test.ts`
  - 覆盖状态机行为。
- Create: `src/features/update/components/UpdateToast.tsx`
  - 负责全局更新提示 UI。
- Create: `src/features/update/components/UpdateToast.test.tsx`
  - 覆盖各阶段渲染和按钮回调。
- Create: `src/features/update/UpdaterProvider.tsx`
  - 提供全局 updater context。
- Create: `src/features/update/UpdaterProvider.test.tsx`
  - 覆盖 Provider 与 context 的基础行为。
- Modify: `src/App.tsx`
  - 挂载 `UpdaterProvider` 和 `UpdateToast`。
- Modify: `src/components/settings/AboutSettings.tsx`
  - 增加“检查更新”按钮。
- Create: `src/components/settings/AboutSettings.test.tsx`
  - 覆盖手动检查入口。
- Modify: `docs/desktop-release-guide.md`
  - 增加 updater 密钥生成、Secrets 配置和发版注意事项。
- Modify: `.github/workflows/release.yml`
  - 为 Tauri 构建注入 updater 签名环境变量。

## Task 1: 配置 Tauri updater 与 process 依赖

**Files:**
- Modify: `package.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: 修改依赖配置**

在 `package.json` 的 `dependencies` 中加入：

```json
"@tauri-apps/plugin-process": "^2",
"@tauri-apps/plugin-updater": "^2"
```

在 `src-tauri/Cargo.toml` 的 `[dependencies]` 中加入：

```toml
tauri-plugin-process = "2"
tauri-plugin-updater = "2"
```

- [ ] **Step 2: 安装依赖并更新锁文件**

Run:

```bash
npm install
cd src-tauri && cargo check --all-targets --all-features
```

Expected:

- `package-lock.json` 更新。
- `src-tauri/Cargo.lock` 更新。
- `cargo check` 可能因插件未注册前的未使用问题不报错；若依赖解析失败，先修正版本。

- [ ] **Step 3: 注册 Tauri 插件**

在 `src-tauri/src/lib.rs` 的 builder 链中，放在 shell/dialog 插件附近：

```rust
.plugin(tauri_plugin_process::init())
.plugin(tauri_plugin_updater::Builder::new().build())
```

目标片段：

```rust
.plugin(tauri_plugin_shell::init())
.plugin(tauri_plugin_dialog::init())
.plugin(tauri_plugin_process::init())
.plugin(tauri_plugin_updater::Builder::new().build())
```

- [ ] **Step 4: 配置 updater endpoint 和占位公钥**

在 `src-tauri/tauri.conf.json` 中：

```json
"bundle": {
  "active": true,
  "targets": "all",
  "createUpdaterArtifacts": true,
  "resources": {
    "sidecar/": "sidecar/"
  },
  "icon": [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
    "icons/icon.icns",
    "icons/icon.ico"
  ]
},
"plugins": {
  "updater": {
    "pubkey": "PLACEHOLDER_UPDATER_PUBLIC_KEY_REPLACE_BEFORE_RELEASE",
    "endpoints": [
      "https://github.com/kfumi/codeMUX-desktop/releases/latest/download/latest.json"
    ]
  }
}
```

JSON 中不能写注释；占位含义放到文档。

- [ ] **Step 5: 配置 capability 权限**

在 `src-tauri/capabilities/default.json` 的 `permissions` 中增加：

```json
"updater:default",
"process:allow-restart"
```

如果 `process:allow-restart` 在本项目依赖版本中名称不匹配，运行 `npm run tauri dev` 或 `cargo check` 时会报 capability schema 错误；按生成的 schema 将权限改为 process 插件允许 relaunch/restart 的最小权限。

- [ ] **Step 6: 验证配置**

Run:

```bash
npm run build
cd src-tauri && cargo check --all-targets --all-features
cd src-tauri && cargo fmt --all -- --check
```

Expected:

- `npm run build` PASS。
- `cargo check` PASS。
- `cargo fmt` PASS。

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/tauri.conf.json src-tauri/capabilities/default.json
git commit -m "feat(updater): 配置 Tauri 更新插件"
```

## Task 2: 实现 updater 状态机 Hook

**Files:**
- Create: `src/features/update/hooks/useUpdater.ts`
- Create: `src/features/update/hooks/useUpdater.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/features/update/hooks/useUpdater.test.ts`：

```typescript
// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const checkMock = vi.fn();
const relaunchMock = vi.fn();

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: checkMock,
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: relaunchMock,
}));

vi.mock('../../../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
  serializeError: (error: unknown) => error,
}));

const setTauri = (enabled: boolean) => {
  if (enabled) {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
  } else {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  }
};

describe('useUpdater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    checkMock.mockReset();
    relaunchMock.mockReset();
    setTauri(true);
  });

  it('reports latest for interactive checks without updates', async () => {
    checkMock.mockResolvedValue(null);
    const { useUpdater } = await import('./useUpdater');
    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    await act(async () => {
      await result.current.checkForUpdates({ interactive: true, announceNoUpdate: true });
    });

    expect(result.current.stage).toBe('latest');

    act(() => {
      vi.advanceTimersByTime(2200);
    });

    expect(result.current.stage).toBe('idle');
  });

  it('keeps silent background checks idle when there is no update', async () => {
    checkMock.mockResolvedValue(null);
    const { useUpdater } = await import('./useUpdater');
    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.stage).toBe('idle');
  });

  it('stores available update metadata', async () => {
    checkMock.mockResolvedValue({
      version: '0.0.5',
      downloadAndInstall: vi.fn(),
    });
    const { useUpdater } = await import('./useUpdater');
    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    await act(async () => {
      await result.current.checkForUpdates({ interactive: true });
    });

    expect(result.current.stage).toBe('available');
    expect(result.current.version).toBe('0.0.5');
  });

  it('downloads, installs, and relaunches with progress', async () => {
    const downloadAndInstall = vi.fn(async (onEvent: (event: unknown) => void) => {
      onEvent({ event: 'Started', data: { contentLength: 100 } });
      onEvent({ event: 'Progress', data: { chunkLength: 40 } });
      onEvent({ event: 'Progress', data: { chunkLength: 60 } });
      onEvent({ event: 'Finished' });
    });
    checkMock.mockResolvedValue({ version: '0.0.5', downloadAndInstall });
    const { useUpdater } = await import('./useUpdater');
    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    await act(async () => {
      await result.current.checkForUpdates({ interactive: true });
      await result.current.startUpdate();
    });

    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
    expect(result.current.stage).toBe('restarting');
    expect(result.current.progress).toEqual({ totalBytes: 100, downloadedBytes: 100 });
  });

  it('ignores stale check results', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    checkMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ version: '0.0.6', downloadAndInstall: vi.fn() });
    const { useUpdater } = await import('./useUpdater');
    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    const first = result.current.checkForUpdates({ interactive: true });
    const second = result.current.checkForUpdates({ interactive: true });

    await act(async () => {
      await second;
      resolveFirst({ version: '0.0.5', downloadAndInstall: vi.fn() });
      await first;
    });

    expect(result.current.version).toBe('0.0.6');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
npx vitest run src/features/update/hooks/useUpdater.test.ts
```

Expected:

- FAIL，原因是 `src/features/update/hooks/useUpdater.ts` 不存在。

- [ ] **Step 3: 实现 Hook**

创建 `src/features/update/hooks/useUpdater.ts`：

```typescript
import { useCallback, useEffect, useRef, useState } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

import { createLogger, serializeError } from '../../../lib/logger';

const logger = createLogger('updater');
const LATEST_VISIBLE_MS = 2000;

export type UpdateStage =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'restarting'
  | 'latest'
  | 'error';

export interface UpdateProgress {
  totalBytes: number | null;
  downloadedBytes: number;
}

export interface UpdaterState {
  stage: UpdateStage;
  version?: string;
  progress?: UpdateProgress;
  error?: string;
}

export interface CheckForUpdatesOptions {
  announceNoUpdate?: boolean;
  interactive?: boolean;
}

export interface UseUpdaterOptions {
  autoCheck?: boolean;
  enabled?: boolean;
}

const isTauri = () =>
  typeof window !== 'undefined'
  && typeof (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '更新检查失败';
};

export function useUpdater(options: UseUpdaterOptions = {}) {
  const { autoCheck = true, enabled = true } = options;
  const [state, setState] = useState<UpdaterState>({ stage: 'idle' });
  const updateRef = useRef<Update | null>(null);
  const latestTimerRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);

  const clearLatestTimer = useCallback(() => {
    if (latestTimerRef.current !== null) {
      window.clearTimeout(latestTimerRef.current);
      latestTimerRef.current = null;
    }
  }, []);

  const resetToIdle = useCallback(() => {
    requestIdRef.current += 1;
    clearLatestTimer();
    updateRef.current = null;
    setState({ stage: 'idle' });
  }, [clearLatestTimer]);

  const scheduleLatestReset = useCallback(() => {
    clearLatestTimer();
    latestTimerRef.current = window.setTimeout(() => {
      setState((current) => current.stage === 'latest' ? { stage: 'idle' } : current);
      latestTimerRef.current = null;
    }, LATEST_VISIBLE_MS);
  }, [clearLatestTimer]);

  const checkForUpdates = useCallback(async (checkOptions: CheckForUpdatesOptions = {}) => {
    const interactive = checkOptions.interactive ?? false;
    const announceNoUpdate = checkOptions.announceNoUpdate ?? interactive;

    if (!enabled || !isTauri() || import.meta.env.DEV) {
      if (interactive) {
        setState({
          stage: 'error',
          error: '当前环境不支持更新检查，请在正式桌面应用中使用。',
        });
      }
      return null;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const isStale = () => requestIdRef.current !== requestId;

    clearLatestTimer();
    if (interactive) {
      setState({ stage: 'checking' });
    }

    try {
      const update = await check();
      if (isStale()) return null;

      updateRef.current = update;
      if (update) {
        setState({ stage: 'available', version: update.version });
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
      if (isStale()) return null;

      logger.error('Failed to check for updates', undefined, serializeError(error));
      if (interactive) {
        setState({ stage: 'error', error: getErrorMessage(error) });
      } else {
        setState({ stage: 'idle' });
      }
      return null;
    }
  }, [clearLatestTimer, enabled, scheduleLatestReset]);

  const startUpdate = useCallback(async () => {
    let update = updateRef.current;
    if (!update) {
      update = await checkForUpdates({ interactive: true });
    }
    if (!update) return;

    try {
      let downloadedBytes = 0;
      setState((current) => ({
        stage: 'downloading',
        version: current.version ?? update?.version,
        progress: { totalBytes: null, downloadedBytes: 0 },
      }));

      await update.downloadAndInstall((event) => {
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
        }
        if (event.event === 'Finished') {
          setState((current) => ({ ...current, stage: 'installing' }));
        }
      });

      setState((current) => ({ ...current, stage: 'restarting' }));
      await relaunch();
    } catch (error) {
      logger.error('Failed to install update', undefined, serializeError(error));
      setState((current) => ({
        stage: 'error',
        version: current.version,
        error: getErrorMessage(error),
      }));
    }
  }, [checkForUpdates]);

  useEffect(() => {
    if (!autoCheck) return;
    void checkForUpdates();
  }, [autoCheck, checkForUpdates]);

  useEffect(() => () => {
    requestIdRef.current += 1;
    clearLatestTimer();
  }, [clearLatestTimer]);

  return {
    ...state,
    checkForUpdates,
    startUpdate,
    resetToIdle,
  };
}
```

- [ ] **Step 4: 运行 Hook 测试**

Run:

```bash
npx vitest run src/features/update/hooks/useUpdater.test.ts
```

Expected:

- PASS。

- [ ] **Step 5: Commit**

```bash
git add src/features/update/hooks/useUpdater.ts src/features/update/hooks/useUpdater.test.ts
git commit -m "feat(updater): 添加更新状态机"
```

## Task 3: 添加 updater Context 和全局提示组件

**Files:**
- Create: `src/features/update/UpdaterProvider.tsx`
- Create: `src/features/update/UpdaterProvider.test.tsx`
- Create: `src/features/update/components/UpdateToast.tsx`
- Create: `src/features/update/components/UpdateToast.test.tsx`

- [ ] **Step 1: 写 Provider 测试**

创建 `src/features/update/UpdaterProvider.test.tsx`：

```typescript
// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./hooks/useUpdater', () => ({
  useUpdater: () => ({
    stage: 'idle',
    checkForUpdates: vi.fn(),
    startUpdate: vi.fn(),
    resetToIdle: vi.fn(),
  }),
}));

describe('UpdaterProvider', () => {
  it('provides updater state to children', async () => {
    const { UpdaterProvider, useUpdaterContext } = await import('./UpdaterProvider');

    function Probe() {
      const updater = useUpdaterContext();
      return <div>阶段：{updater.stage}</div>;
    }

    render(
      <UpdaterProvider>
        <Probe />
      </UpdaterProvider>,
    );

    expect(screen.getByText('阶段：idle')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 实现 Provider**

创建 `src/features/update/UpdaterProvider.tsx`：

```typescript
import { createContext, type ReactNode, useContext } from 'react';

import { useUpdater } from './hooks/useUpdater';

type UpdaterContextValue = ReturnType<typeof useUpdater>;

const UpdaterContext = createContext<UpdaterContextValue | null>(null);

export function UpdaterProvider({ children }: { children: ReactNode }) {
  const updater = useUpdater();

  return (
    <UpdaterContext.Provider value={updater}>
      {children}
    </UpdaterContext.Provider>
  );
}

export function useUpdaterContext() {
  const context = useContext(UpdaterContext);
  if (!context) {
    throw new Error('useUpdaterContext must be used within UpdaterProvider');
  }
  return context;
}
```

- [ ] **Step 3: 写 UpdateToast 测试**

创建 `src/features/update/components/UpdateToast.test.tsx`：

```typescript
// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

describe('UpdateToast', () => {
  it('renders available update actions', async () => {
    const { UpdateToast } = await import('./UpdateToast');
    const startUpdate = vi.fn();
    const resetToIdle = vi.fn();

    render(
      <UpdateToast
        stage="available"
        version="0.0.5"
        startUpdate={startUpdate}
        resetToIdle={resetToIdle}
        checkForUpdates={vi.fn()}
      />,
    );

    expect(screen.getByText('发现新版本')).toBeTruthy();
    expect(screen.getByText('v0.0.5')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '立即更新' }));
    expect(startUpdate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '稍后' }));
    expect(resetToIdle).toHaveBeenCalledTimes(1);
  });

  it('renders download progress', async () => {
    const { UpdateToast } = await import('./UpdateToast');

    render(
      <UpdateToast
        stage="downloading"
        progress={{ totalBytes: 100, downloadedBytes: 25 }}
        startUpdate={vi.fn()}
        resetToIdle={vi.fn()}
        checkForUpdates={vi.fn()}
      />,
    );

    expect(screen.getByText('正在下载更新')).toBeTruthy();
    expect(screen.getByText('25 B / 100 B')).toBeTruthy();
  });

  it('renders retry action for errors', async () => {
    const { UpdateToast } = await import('./UpdateToast');
    const checkForUpdates = vi.fn();

    render(
      <UpdateToast
        stage="error"
        error="网络错误"
        startUpdate={vi.fn()}
        resetToIdle={vi.fn()}
        checkForUpdates={checkForUpdates}
      />,
    );

    expect(screen.getByText('更新失败')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(checkForUpdates).toHaveBeenCalledWith({ interactive: true, announceNoUpdate: true });
  });
});
```

- [ ] **Step 4: 实现 UpdateToast**

创建 `src/features/update/components/UpdateToast.tsx`：

```typescript
import { AlertCircle, CheckCircle2, Download, RefreshCw, RotateCw, X } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { cn } from '../../../lib/utils';
import type { CheckForUpdatesOptions, UpdateProgress, UpdateStage } from '../hooks/useUpdater';

interface UpdateToastProps {
  stage: UpdateStage;
  version?: string;
  progress?: UpdateProgress;
  error?: string;
  checkForUpdates: (options?: CheckForUpdatesOptions) => Promise<unknown>;
  startUpdate: () => Promise<void>;
  resetToIdle: () => void;
}

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const getProgressPercent = (progress?: UpdateProgress) => {
  if (!progress?.totalBytes) return 0;
  return Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100));
};

export function UpdateToast({
  stage,
  version,
  progress,
  error,
  checkForUpdates,
  startUpdate,
  resetToIdle,
}: UpdateToastProps) {
  if (stage === 'idle') return null;

  const percent = getProgressPercent(progress);
  const progressLabel = progress?.totalBytes
    ? `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}`
    : progress
      ? formatBytes(progress.downloadedBytes)
      : '';

  return (
    <div className="fixed right-4 top-16 z-[210] w-[min(360px,calc(100vw-32px))] rounded-lg border border-border/70 bg-card p-4 shadow-[0_18px_60px_-32px_hsl(var(--foreground)/0.45)]">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted/70 text-foreground/70">
          {stage === 'error' ? <AlertCircle className="h-4 w-4 text-destructive" /> : null}
          {stage === 'latest' ? <CheckCircle2 className="h-4 w-4 text-primary" /> : null}
          {stage === 'available' ? <Download className="h-4 w-4 text-primary" /> : null}
          {stage === 'checking' || stage === 'downloading' ? <RefreshCw className="h-4 w-4 animate-spin text-primary" /> : null}
          {stage === 'installing' || stage === 'restarting' ? <RotateCw className="h-4 w-4 animate-spin text-primary" /> : null}
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          {stage === 'checking' && (
            <div>
              <h3 className="text-sm font-semibold text-foreground/90">正在检查更新</h3>
              <p className="text-xs text-foreground/58">正在连接发布源。</p>
            </div>
          )}

          {stage === 'available' && (
            <div>
              <h3 className="text-sm font-semibold text-foreground/90">发现新版本</h3>
              <p className="text-xs text-foreground/58">{version ? `v${version}` : '有可用更新'}</p>
            </div>
          )}

          {stage === 'latest' && (
            <div>
              <h3 className="text-sm font-semibold text-foreground/90">当前已是最新版本</h3>
              <p className="text-xs text-foreground/58">codeMUX 已保持最新。</p>
            </div>
          )}

          {stage === 'downloading' && (
            <div className="space-y-2">
              <div>
                <h3 className="text-sm font-semibold text-foreground/90">正在下载更新</h3>
                <p className="text-xs text-foreground/58">{progressLabel}</p>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${percent}%` }} />
              </div>
            </div>
          )}

          {stage === 'installing' && (
            <div>
              <h3 className="text-sm font-semibold text-foreground/90">正在安装更新</h3>
              <p className="text-xs text-foreground/58">安装完成后将准备重启。</p>
            </div>
          )}

          {stage === 'restarting' && (
            <div>
              <h3 className="text-sm font-semibold text-foreground/90">正在重启应用</h3>
              <p className="text-xs text-foreground/58">新版本即将生效。</p>
            </div>
          )}

          {stage === 'error' && (
            <div>
              <h3 className="text-sm font-semibold text-foreground/90">更新失败</h3>
              <p className="break-words text-xs text-foreground/58">{error ?? '请稍后重试。'}</p>
            </div>
          )}

          <div className={cn('flex gap-2', stage === 'checking' || stage === 'downloading' || stage === 'installing' || stage === 'restarting' ? 'hidden' : '')}>
            {stage === 'available' && (
              <>
                <Button variant="outline" size="sm" onClick={resetToIdle}>稍后</Button>
                <Button size="sm" onClick={() => { void startUpdate(); }}>立即更新</Button>
              </>
            )}
            {stage === 'latest' && (
              <Button variant="outline" size="sm" onClick={resetToIdle}>关闭</Button>
            )}
            {stage === 'error' && (
              <>
                <Button variant="outline" size="sm" onClick={resetToIdle}>关闭</Button>
                <Button size="sm" onClick={() => { void checkForUpdates({ interactive: true, announceNoUpdate: true }); }}>重试</Button>
              </>
            )}
          </div>
        </div>

        {stage !== 'downloading' && stage !== 'installing' && stage !== 'restarting' ? (
          <button
            type="button"
            aria-label="关闭"
            onClick={resetToIdle}
            className="rounded-md p-1 text-foreground/45 transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 运行组件测试**

Run:

```bash
npx vitest run src/features/update/UpdaterProvider.test.tsx src/features/update/components/UpdateToast.test.tsx
```

Expected:

- PASS。

- [ ] **Step 6: Commit**

```bash
git add src/features/update/UpdaterProvider.tsx src/features/update/UpdaterProvider.test.tsx src/features/update/components/UpdateToast.tsx src/features/update/components/UpdateToast.test.tsx
git commit -m "feat(updater): 添加更新提示组件"
```

## Task 4: 接入 App 和关于页手动检查

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/settings/AboutSettings.tsx`
- Create: `src/components/settings/AboutSettings.test.tsx`

- [ ] **Step 1: 写 AboutSettings 测试**

创建 `src/components/settings/AboutSettings.test.tsx`：

```typescript
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const checkForUpdatesMock = vi.fn();

vi.mock('@tauri-apps/api/app', () => ({
  getName: vi.fn(async () => 'codeMUX'),
  getVersion: vi.fn(async () => '0.0.4'),
  getTauriVersion: vi.fn(async () => '2.0.0'),
}));

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn(),
}));

vi.mock('../../features/update/UpdaterProvider', () => ({
  useUpdaterContext: () => ({
    stage: 'idle',
    checkForUpdates: checkForUpdatesMock,
    startUpdate: vi.fn(),
    resetToIdle: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  checkForUpdatesMock.mockReset();
});

describe('AboutSettings', () => {
  it('starts an interactive update check', async () => {
    const { AboutSettings } = await import('./AboutSettings');

    render(<AboutSettings />);

    fireEvent.click(screen.getByRole('button', { name: /检查更新/ }));

    expect(checkForUpdatesMock).toHaveBeenCalledWith({
      interactive: true,
      announceNoUpdate: true,
    });
  });
});
```

- [ ] **Step 2: 修改 App 挂载 Provider 和 Toast**

在 `src/App.tsx` 增加导入：

```typescript
import { UpdateToast } from './features/update/components/UpdateToast';
import { UpdaterProvider, useUpdaterContext } from './features/update/UpdaterProvider';
```

在 `App` 组件外新增：

```typescript
function GlobalUpdateToast() {
  const updater = useUpdaterContext();
  return <UpdateToast {...updater} />;
}
```

将返回结构包在 `UpdaterProvider` 内：

```tsx
return (
  <UpdaterProvider>
    <TooltipProvider>
      ...
      <Toaster position="top-center" richColors />
      <GlobalUpdateToast />
    </TooltipProvider>
  </UpdaterProvider>
);
```

- [ ] **Step 3: 修改 AboutSettings**

在 `src/components/settings/AboutSettings.tsx` 增加导入：

```typescript
import { RefreshCw } from 'lucide-react';
import { useUpdaterContext } from '../../features/update/UpdaterProvider';
```

如果已有 `ExternalLink, Github` 导入，合并为：

```typescript
import { ExternalLink, Github, RefreshCw } from 'lucide-react';
```

组件内增加：

```typescript
const updater = useUpdaterContext();
const checking = updater.stage === 'checking';
```

在应用身份卡片或运行环境区域后添加按钮：

```tsx
<div className="flex justify-center">
  <Button
    variant="outline"
    size="sm"
    className="gap-1.5"
    disabled={checking}
    onClick={() => {
      void updater.checkForUpdates({ interactive: true, announceNoUpdate: true });
    }}
  >
    <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
    {checking ? '正在检查' : '检查更新'}
  </Button>
</div>
```

同时导入 `cn`：

```typescript
import { cn } from '../../lib/utils';
```

- [ ] **Step 4: 运行测试**

Run:

```bash
npx vitest run src/components/settings/AboutSettings.test.tsx
npx vitest run src/components/settings/SettingsDialog.test.tsx
```

Expected:

- PASS。

- [ ] **Step 5: 运行构建**

Run:

```bash
npm run build
```

Expected:

- PASS。

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/components/settings/AboutSettings.tsx src/components/settings/AboutSettings.test.tsx
git commit -m "feat(updater): 接入手动更新入口"
```

## Task 5: 更新发布文档和 Release workflow

**Files:**
- Modify: `docs/desktop-release-guide.md`
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: 修改 Release workflow 注入签名环境变量**

在 `.github/workflows/release.yml` 的 `Build and publish Tauri app` 步骤 env 中加入：

```yaml
TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
```

目标片段：

```yaml
      - name: Build and publish Tauri app
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.DESKTOP_RELEASE_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
```

- [ ] **Step 2: 更新发版文档**

在 `docs/desktop-release-guide.md` 增加章节：

```markdown
## 自动更新签名配置

Tauri updater 需要签名校验。仓库中的 `src-tauri/tauri.conf.json` 当前使用占位 `pubkey`，正式发布前必须替换为真实公钥。

### 生成密钥

在本机执行：

```bash
npm run tauri signer generate -- -w ~/.tauri/codemux-updater.key
```

命令会输出公钥，并把私钥写入 `~/.tauri/codemux-updater.key`。私钥不要提交到仓库。

如果要设置私钥密码：

```bash
npm run tauri signer generate -- -w ~/.tauri/codemux-updater.key -p "你的强密码"
```

### 写入公钥

将命令输出的 public key 写入：

```json
"plugins": {
  "updater": {
    "pubkey": "这里替换为真实公钥",
    "endpoints": [
      "https://github.com/kfumi/codeMUX-desktop/releases/latest/download/latest.json"
    ]
  }
}
```

### 配置 GitHub Secrets

在私有源码仓库的 GitHub Secrets 中配置：

- `TAURI_SIGNING_PRIVATE_KEY`：`~/.tauri/codemux-updater.key` 文件内容。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：生成密钥时设置的密码；如果没有设置密码，可以留空或不配置。

发布 workflow 会把这些变量传给 Tauri 构建。`bundle.createUpdaterArtifacts` 开启后，构建会生成 updater 所需的 `latest.json` 和签名产物，并随 Release 上传到 `kfumi/codeMUX-desktop`。
```

- [ ] **Step 3: 验证文档和 workflow 格式**

Run:

```bash
npm run build
```

Expected:

- PASS。该命令不会验证 GitHub Secrets，但能确认 TypeScript/Vite 不受文档和 workflow 改动影响。

- [ ] **Step 4: Commit**

```bash
git add docs/desktop-release-guide.md .github/workflows/release.yml
git commit -m "docs(release): 补充自动更新签名说明"
```

## Task 6: 总体验证

**Files:**
- Verify all modified files.

- [ ] **Step 1: 运行前端测试**

Run:

```bash
npx vitest run src/features/update/hooks/useUpdater.test.ts src/features/update/UpdaterProvider.test.tsx src/features/update/components/UpdateToast.test.tsx src/components/settings/AboutSettings.test.tsx src/components/settings/SettingsDialog.test.tsx
```

Expected:

- PASS。

- [ ] **Step 2: 运行前端构建**

Run:

```bash
npm run build
```

Expected:

- PASS。

- [ ] **Step 3: 运行 Rust 校验**

Run:

```bash
cd src-tauri && cargo fmt --all -- --check
cd src-tauri && cargo check --all-targets --all-features
```

Expected:

- PASS。

- [ ] **Step 4: 检查 git 状态**

Run:

```bash
git status --short
```

Expected:

- 空输出，表示所有任务提交完成。

## Self-Review

- Spec coverage:
  - 启动静默检查：Task 2 `useUpdater` 的 `autoCheck` 实现。
  - 关于页手动检查：Task 4 `AboutSettings` 按钮。
  - 检测、下载、安装、重启：Task 2 状态机与 `downloadAndInstall`、`relaunch`。
  - 全局更新提示：Task 3 `UpdateToast` 与 Task 4 `App` 挂载。
  - 签名和发布说明：Task 1 配置占位公钥，Task 5 文档和 workflow。
  - 测试：Task 2、Task 3、Task 4、Task 6。
- Placeholder scan:
  - 计划没有 `TBD` 或未定义的后续项。
  - `PLACEHOLDER_UPDATER_PUBLIC_KEY_REPLACE_BEFORE_RELEASE` 是明确的配置占位值，并有文档替换步骤。
- Type consistency:
  - `UpdateStage`、`UpdateProgress`、`CheckForUpdatesOptions` 在 Hook、Toast 和 Context 中保持一致。
  - `checkForUpdates`、`startUpdate`、`resetToIdle` 在 Provider、Toast、AboutSettings 中名称一致。
