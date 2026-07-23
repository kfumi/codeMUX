# 开发期全栈性能诊断集成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 CodeMUX 集成开发期专用的全栈性能诊断能力（前端性能浮层 + IPC 计时 + React Profiler + Rust 可选 tracing feature），release 构建零开销。

**Architecture:** 薄自研 Zustand store（perfStore）聚合性能信号；在 IPC 唯一入口 `invokeLogged` 处用 `import.meta.env.DEV` 门控注入计时；React `<Profiler>` 包裹消息树；Rust 用可选 Cargo feature 启用 tokio-console / cmd-tracing。所有诊断代码经编译期门控，release 完全移除。

**Tech Stack:** React 18、Zustand 5、TypeScript、Vite（`import.meta.env.DEV`）、Rust（Cargo features / `cfg`）、tokio-console、tracing、tauri-plugin-dialog。

**Spec:** `docs/superpowers/specs/2026-07-23-dev-performance-diagnostics-design.md`

---

## File Structure

**新增：**
- `src/stores/perfStore.ts` — 性能数据 Zustand store（环形缓冲、聚合、采样值、开关）。纯数据逻辑，不跑采样循环。
- `src/stores/perfStore.test.ts` — store 单元测试。
- `src/components/dev/PerfOverlay.tsx` — 性能浮层组件（FPS/内存/IPC/render 展示 + 按钮 + 采样循环）。
- `src/components/dev/PerfOverlay.css` — 浮层样式（半透明、可拖拽、可折叠）。
- `src-tauri/src/commands/perf.rs` — Rust 性能命令（快照导出、tokio-console 地址）。

**改动：**
- `src/lib/tauri.ts` — `invokeLogged` 加 DEV 计时埋点。
- `src/App.tsx` — dev 挂载浮层 + `Ctrl+Shift+D` 快捷键。
- `src/components/agent/AgentPanel.tsx` — 消息树包 `<Profiler>`。
- `src-tauri/Cargo.toml` — 可选 features + 可选依赖。
- `src-tauri/src/lib.rs` — 条件初始化 tracing + 注册 perf 命令。
- `src-tauri/src/commands/mod.rs` — 声明 `perf` 子模块。

---

## Task 1: perfStore — 性能数据聚合核心

**Files:**
- Create: `src/stores/perfStore.ts`
- Test: `src/stores/perfStore.test.ts`

纯前端逻辑：环形缓冲、阈值过滤、re-render 聚合、IPC rate 窗口。无副作用，最易测，是整个功能的数据底座。

- [ ] **Step 1: 写失败测试（环形缓冲 + 阈值过滤）**

Create `src/stores/perfStore.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePerfStore, SLOW_IPC_CAP, RENDER_AGGREGATE_CAP } from './perfStore';

beforeEach(() => {
  usePerfStore.getState().reset();
});

describe('perfStore IPC samples', () => {
  it('只记录超过阈值的慢调用到 slowIpcSamples', () => {
    const store = usePerfStore.getState();
    store.setSlowThresholdMs(50);
    store.recordIpc('fast_cmd', 10, false);
    store.recordIpc('slow_cmd', 80, false);
    const slow = usePerfStore.getState().slowIpcSamples;
    expect(slow).toHaveLength(1);
    expect(slow[0].command).toBe('slow_cmd');
    expect(slow[0].durationMs).toBe(80);
  });

  it('慢调用环形缓冲超过容量时淘汰最旧', () => {
    const store = usePerfStore.getState();
    store.setSlowThresholdMs(0);
    for (let i = 0; i < SLOW_IPC_CAP + 5; i++) {
      store.recordIpc(`cmd_${i}`, 1, false);
    }
    const slow = usePerfStore.getState().slowIpcSamples;
    expect(slow).toHaveLength(SLOW_IPC_CAP);
    expect(slow[0].command).toBe(`cmd_5`);
    expect(slow[slow.length - 1].command).toBe(`cmd_${SLOW_IPC_CAP + 4}`);
  });

  it('每次 IPC 调用都计入时间戳窗口用于 rate', () => {
    const now = 1_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const store = usePerfStore.getState();
    store.recordIpc('a', 1, false);
    store.recordIpc('a', 1, false);
    store.recordIpc('a', 1, false);
    expect(usePerfStore.getState().getIpcRateNow()).toBe(3);
  });

  it('getIpcRateNow 只统计最近 1000ms 的调用', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const store = usePerfStore.getState();
    store.recordIpc('a', 1, false);
    store.recordIpc('a', 1, false);
    vi.spyOn(Date, 'now').mockReturnValue(2_500);
    store.recordIpc('a', 1, false);
    expect(usePerfStore.getState().getIpcRateNow()).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/stores/perfStore.test.ts`
Expected: FAIL — 模块 `./perfStore` 不存在。

- [ ] **Step 3: 写 perfStore 最小实现**

Create `src/stores/perfStore.ts`:

```ts
import { create } from 'zustand';

export const SLOW_IPC_CAP = 50;
export const RENDER_AGGREGATE_CAP = 50;
const IPC_RATE_WINDOW_MS = 1000;

export interface IpcSample {
  command: string;
  durationMs: number;
  timestamp: number;
  failed: boolean;
}

export interface RenderAggregate {
  id: string;
  commitCount: number;
  totalMs: number;
  baseTotalMs: number;
  lastSeen: number;
}

export interface PerfSnapshot {
  slowIpcSamples: IpcSample[];
  renderAggregates: RenderAggregate[];
  fps: number;
  memoryMb: number | null;
  slowThresholdMs: number;
  capturedAt: number;
}

interface PerfState {
  slowIpcSamples: IpcSample[];
  ipcTimestamps: number[];
  renderAggregates: Record<string, RenderAggregate>;
  renderOrder: string[];
  fps: number;
  memoryMb: number | null;
  overlayVisible: boolean;
  slowThresholdMs: number;

  recordIpc: (command: string, durationMs: number, failed: boolean) => void;
  recordRender: (id: string, actualDurationMs: number, baseDurationMs: number) => void;
  setFps: (fps: number) => void;
  setMemoryMb: (mb: number | null) => void;
  setOverlayVisible: (visible: boolean) => void;
  setSlowThresholdMs: (ms: number) => void;
  getIpcRateNow: () => number;
  getTopSlowIpc: (n: number) => IpcSample[];
  getTopRenders: (n: number) => RenderAggregate[];
  snapshot: () => PerfSnapshot;
  reset: () => void;
}

function pushCapped<T>(arr: T[], item: T, cap: number): T[] {
  arr.push(item);
  if (arr.length > cap) {
    arr.splice(0, arr.length - cap);
  }
  return arr;
}

export const usePerfStore = create<PerfState>((set, get) => ({
  slowIpcSamples: [],
  ipcTimestamps: [],
  renderAggregates: {},
  renderOrder: [],
  fps: 0,
  memoryMb: null,
  overlayVisible: true,
  slowThresholdMs: 50,

  recordIpc: (command, durationMs, failed) => {
    const now = Date.now();
    const state = get();
    const nextSlow =
      durationMs >= state.slowThresholdMs
        ? pushCapped(
            [...state.slowIpcSamples],
            { command, durationMs, timestamp: now, failed },
            SLOW_IPC_CAP,
          )
        : state.slowIpcSamples;

    const nextTimestamps = [...state.ipcTimestamps, now];
    while (nextTimestamps.length > 0 && now - nextTimestamps[0] > IPC_RATE_WINDOW_MS) {
      nextTimestamps.shift();
    }

    set({ slowIpcSamples: nextSlow, ipcTimestamps: nextTimestamps });
  },

  recordRender: (id, actualDurationMs, baseDurationMs) => {
    const now = Date.now();
    const state = get();
    const existing = state.renderAggregates[id];
    const aggregates = { ...state.renderAggregates };
    aggregates[id] = existing
      ? {
          id,
          commitCount: existing.commitCount + 1,
          totalMs: existing.totalMs + actualDurationMs,
          baseTotalMs: existing.baseTotalMs + baseDurationMs,
          lastSeen: now,
        }
      : { id, commitCount: 1, totalMs: actualDurationMs, baseTotalMs: baseDurationMs, lastSeen: now };

    let order = state.renderOrder.filter((entry) => entry !== id);
    order.push(id);
    if (order.length > RENDER_AGGREGATE_CAP) {
      const evicted = order.splice(0, order.length - RENDER_AGGREGATE_CAP);
      for (const id of evicted) {
        delete aggregates[id];
      }
    }

    set({ renderAggregates: aggregates, renderOrder: order });
  },

  setFps: (fps) => set({ fps }),
  setMemoryMb: (memoryMb) => set({ memoryMb }),
  setOverlayVisible: (overlayVisible) => set({ overlayVisible }),
  setSlowThresholdMs: (slowThresholdMs) => set({ slowThresholdMs }),

  getIpcRateNow: () => {
    const now = Date.now();
    const timestamps = get().ipcTimestamps;
    let count = 0;
    for (let i = timestamps.length - 1; i >= 0; i--) {
      if (now - timestamps[i] <= IPC_RATE_WINDOW_MS) {
        count++;
      } else {
        break;
      }
    }
    return count;
  },

  getTopSlowIpc: (n) =>
    [...get().slowIpcSamples].sort((a, b) => b.durationMs - a.durationMs).slice(0, n),

  getTopRenders: (n) =>
    Object.values(get().renderAggregates)
      .sort((a, b) => b.commitCount - a.commitCount)
      .slice(0, n),

  snapshot: () => {
    const s = get();
    return {
      slowIpcSamples: s.getTopSlowIpc(20),
      renderAggregates: s.getTopRenders(20),
      fps: s.fps,
      memoryMb: s.memoryMb,
      slowThresholdMs: s.slowThresholdMs,
      capturedAt: Date.now(),
    };
  },

  reset: () =>
    set({
      slowIpcSamples: [],
      ipcTimestamps: [],
      renderAggregates: {},
      renderOrder: [],
      fps: 0,
      memoryMb: null,
    }),
}));
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/stores/perfStore.test.ts`
Expected: PASS（4 tests）。

- [ ] **Step 5: 补充 re-render 聚合测试**

Append to `src/stores/perfStore.test.ts`:

```ts
describe('perfStore render aggregates', () => {
  it('相同 id 的 commit 正确累加', () => {
    const store = usePerfStore.getState();
    store.recordRender('MessageList', 5, 6);
    store.recordRender('MessageList', 3, 4);
    store.recordRender('MessageList', 2, 2);
    const top = usePerfStore.getState().getTopRenders(5);
    expect(top).toHaveLength(1);
    expect(top[0].id).toBe('MessageList');
    expect(top[0].commitCount).toBe(3);
    expect(top[0].totalMs).toBe(10);
    expect(top[0].baseTotalMs).toBe(12);
  });

  it('getTopRenders 按 commit 次数降序', () => {
    const store = usePerfStore.getState();
    store.recordRender('A', 1, 1);
    store.recordRender('B', 1, 1);
    store.recordRender('B', 1, 1);
    store.recordRender('B', 1, 1);
    const top = usePerfStore.getState().getTopRenders(5);
    expect(top[0].id).toBe('B');
    expect(top[0].commitCount).toBe(3);
    expect(top[1].id).toBe('A');
  });

  it('render 聚合超过容量时淘汰最旧', () => {
    const store = usePerfStore.getState();
    for (let i = 0; i < RENDER_AGGREGATE_CAP + 2; i++) {
      store.recordRender(`cmp_${i}`, 1, 1);
    }
    const top = usePerfStore.getState().getTopRenders(RENDER_AGGREGATE_CAP + 5);
    expect(top).toHaveLength(RENDER_AGGREGATE_CAP);
  });
});
```

- [ ] **Step 6: 运行全部测试确认通过**

Run: `npx vitest run src/stores/perfStore.test.ts`
Expected: PASS（7 tests）。

- [ ] **Step 7: 提交**

```bash
git add src/stores/perfStore.ts src/stores/perfStore.test.ts
git commit -m "feat(perf): add perfStore for performance signal aggregation"
```

---

## Task 2: invokeLogged DEV 计时埋点

**Files:**
- Modify: `src/lib/tauri.ts`（`invokeLogged`，tauri.ts:123）

所有 IPC 唯一入口加计时，DEV 门控，自动覆盖全部命令。

- [ ] **Step 1: 加 perfStore import 与计时包装**

Modify `src/lib/tauri.ts`. 在顶部 import 区（line 12 之后）加：

```ts
import { usePerfStore } from '../stores/perfStore';
```

替换 `invokeLogged` 函数（tauri.ts:123-150）。原函数体保留 logging 逻辑，在 `invoke` 调用处加 DEV 计时：

```ts
async function invokeLogged<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const isAgentCommand = command.startsWith('agent_') || command.startsWith('ensure_agent') || command.startsWith('start_agent') || command.startsWith('send_agent') || command.startsWith('interrupt_agent') || command.startsWith('reset_agent') || command.startsWith('shutdown_agent') || command.startsWith('rewind_agent');

  if (isAgentCommand) {
    logger.debug('Tauri command invoked', {
      command,
      ...summarizeInvokeArgs(args),
    });
  }

  if (import.meta.env.DEV) {
    const start = performance.now();
    try {
      const result = await invoke<T>(command, args);
      const duration = performance.now() - start;
      usePerfStore.getState().recordIpc(command, duration, false);
      if (isAgentCommand) {
        logger.debug('Tauri command succeeded', {
          command,
          ...summarizeInvokeArgs(args),
          resultType: result !== undefined ? typeof result : 'void',
        });
      }
      return result;
    } catch (error) {
      const duration = performance.now() - start;
      usePerfStore.getState().recordIpc(command, duration, true);
      logger.error(`Tauri command failed: ${serializeError(error)}`, {
        command,
        ...summarizeInvokeArgs(args),
      });
      throw error;
    }
  }

  try {
    const result = await invoke<T>(command, args);
    if (isAgentCommand) {
      logger.debug('Tauri command succeeded', {
        command,
        ...summarizeInvokeArgs(args),
        resultType: result !== undefined ? typeof result : 'void',
      });
    }
    return result;
  } catch (error) {
    logger.error(`Tauri command failed: ${serializeError(error)}`, {
      command,
      ...summarizeInvokeArgs(args),
    });
    throw error;
  }
}
```

- [ ] **Step 2: 类型检查**

Run: `npm run build`
Expected: tsc 通过（`import.meta.env.DEV` 是 Vite 内置类型，无需额外声明）。

- [ ] **Step 3: 提交**

```bash
git add src/lib/tauri.ts
git commit -m "feat(perf): instrument invokeLogged with DEV-gated IPC timing"
```

---

## Task 3: Rust perf 命令 + Cargo features

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/commands/perf.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

新增两个命令 + 两个可选 feature。命令默认可用（无 feature 也能编译），tracing 能力按 feature 启用。

- [ ] **Step 1: Cargo.toml 加 features 与可选依赖**

Modify `src-tauri/Cargo.toml`. 在 `[dependencies]` 段（line 39 `dirs = "5"` 之后）追加可选依赖：

```toml
tracing = { version = "0.1", optional = true }
tracing-subscriber = { version = "0.3", optional = true, features = ["env-filter"] }
console-subscriber = { version = "0.4", optional = true }
```

在文件末尾追加 `[features]` 段（若已有则合并；当前 Cargo.toml 无此段，直接追加）：

```toml

[features]
default = []
tokio-console = ["tokio/tracing", "dep:console-subscriber", "dep:tracing", "dep:tracing-subscriber"]
cmd-tracing = ["dep:tracing", "dep:tracing-subscriber"]
```

- [ ] **Step 2: 创建 perf.rs 命令**

Create `src-tauri/src/commands/perf.rs`:

```rust
use std::fs;
use std::path::PathBuf;
use serde::Serialize;
use tauri::AppHandle;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokioConsoleInfo {
    pub enabled: bool,
    pub addr: String,
}

/// 返回 tokio-console 监听信息。未编译 tokio-console feature 时 enabled=false。
#[tauri::command]
pub fn get_tokio_console_info() -> TokioConsoleInfo {
    #[cfg(feature = "tokio-console")]
    {
        TokioConsoleInfo {
            enabled: true,
            addr: "127.0.0.1:6669".to_string(),
        }
    }
    #[cfg(not(feature = "tokio-console"))]
    {
        TokioConsoleInfo {
            enabled: false,
            addr: String::new(),
        }
    }
}

/// 将性能快照 JSON 写到指定绝对路径（开发期诊断用）。
#[tauri::command]
pub fn export_perf_snapshot(path: String, content: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    fs::write(&target, content)
        .map_err(|e| format!("Failed to write snapshot {}: {}", target.display(), e))
}

/// 条件初始化 tracing subscriber。无 feature 时为空操作。
pub fn init_tracing(_app: &AppHandle) {
    #[cfg(feature = "tokio-console")]
    {
        let _ = console_subscriber::init();
    }
    #[cfg(all(feature = "cmd-tracing", not(feature = "tokio-console")))]
    {
        use tracing_subscriber::EnvFilter;
        let filter = EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("codemux_lib=warn"));
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }
}

#[cfg(test)]
mod tests {
    use super::export_perf_snapshot;

    #[test]
    fn export_perf_snapshot_writes_file() {
        let dir = std::env::temp_dir();
        let target = dir.join(format!("codemux-perf-test-{}.json", std::process::id()));
        let result = export_perf_snapshot(
            target.to_string_lossy().to_string(),
            "{\"fps\":60}".to_string(),
        );
        assert!(result.is_ok());
        let written = std::fs::read_to_string(&target).unwrap();
        assert_eq!(written, "{\"fps\":60}");
        let _ = std::fs::remove_file(&target);
    }

    #[test]
    fn export_perf_snapshot_creates_parent_dirs() {
        let dir = std::env::temp_dir().join(format!("codemux-perf-nested-{}", std::process::id()));
        let target = dir.join("sub").join("snap.json");
        let result = export_perf_snapshot(
            target.to_string_lossy().to_string(),
            "{}".to_string(),
        );
        assert!(result.is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
```

- [ ] **Step 3: 在 commands/mod.rs 声明 perf 模块**

Modify `src-tauri/src/commands/mod.rs`，在文件末尾追加：

```rust
pub mod perf;
```

- [ ] **Step 4: 在 lib.rs 注册命令并初始化 tracing**

Modify `src-tauri/src/lib.rs`.

在 `run()` 函数的 `.setup(|app| {` 块内，`let conn = db::initialize(...)` 之前（约 line 408 前）加：

```rust
            commands::perf::init_tracing(app.handle());
```

在 `.invoke_handler(tauri::generate_handler![...])` 列表末尾（line 552 `skills::commands::get_enabled_skill_names,` 之后、`]` 之前）加两个命令：

```rust
            commands::perf::get_tokio_console_info,
            commands::perf::export_perf_snapshot,
```

- [ ] **Step 5: 编译验证（默认无 feature）**

Run: `cd src-tauri && cargo check --all-targets --all-features`
Expected: 编译通过，无错误。

- [ ] **Step 6: Rust 测试**

Run: `cd src-tauri && cargo test commands::perf`
Expected: 2 tests pass。

- [ ] **Step 7: clippy 验证**

Run: `cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings`
Expected: 无警告。

- [ ] **Step 8: fmt 验证**

Run: `cd src-tauri && cargo fmt --all -- --check`
Expected: 无格式问题（若有，运行 `cargo fmt --all` 后重新检查）。

- [ ] **Step 9: 提交**

```bash
git add src-tauri/Cargo.toml src-tauri/src/commands/perf.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(perf): add rust perf commands and optional tracing features"
```

---

## Task 4: PerfOverlay 性能浮层组件

**Files:**
- Create: `src/components/dev/PerfOverlay.css`
- Create: `src/components/dev/PerfOverlay.tsx`

浮层 UI + FPS/内存采样循环（在组件 effect 中跑）+ 三个动作按钮。订阅 perfStore。

- [ ] **Step 1: 创建浮层样式**

Create `src/components/dev/PerfOverlay.css`:

```css
.perf-overlay {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 9999;
  min-width: 220px;
  max-width: 320px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(15, 17, 21, 0.82);
  color: #e6e6e6;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.5;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(6px);
  user-select: none;
  cursor: move;
}
.perf-overlay.is-light {
  background: rgba(245, 245, 245, 0.92);
  color: #1a1a1a;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
}
.perf-overlay__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  margin-bottom: 4px;
  cursor: move;
}
.perf-overlay__toggle {
  cursor: pointer;
  background: none;
  border: none;
  color: inherit;
  font-size: 12px;
  line-height: 1;
}
.perf-overlay__row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.perf-overlay__row--bad {
  color: #ff6b6b;
}
.perf-overlay__list {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
  max-height: 90px;
  overflow-y: auto;
}
.perf-overlay__list li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.perf-overlay__actions {
  display: flex;
  gap: 4px;
  margin-top: 6px;
}
.perf-overlay__actions button {
  flex: 1;
  padding: 3px 4px;
  font-size: 10px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  cursor: pointer;
}
.perf-overlay.is-light .perf-overlay__actions button {
  border-color: rgba(0, 0, 0, 0.18);
  background: rgba(0, 0, 0, 0.04);
}
.perf-overlay__actions button:hover {
  background: rgba(255, 255, 255, 0.14);
}
.perf-overlay.is-light .perf-overlay__actions button:hover {
  background: rgba(0, 0, 0, 0.08);
}
.perf-overlay__collapsed {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
```

- [ ] **Step 2: 创建浮层组件**

Create `src/components/dev/PerfOverlay.tsx`:

```tsx
import { Gauge } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webview-window';
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../../stores/settingsStore';
import { usePerfStore } from '../../stores/perfStore';
import './PerfOverlay.css';

const STORAGE_KEY = 'codemux.perfOverlay';
const FPS_BAD_THRESHOLD = 30;

interface StoredPosition {
  x: number;
  y: number;
  collapsed: boolean;
}

function loadStored(): StoredPosition {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { x: -1, y: -1, collapsed: false };
    const parsed = JSON.parse(raw) as Partial<StoredPosition>;
    return {
      x: typeof parsed.x === 'number' ? parsed.x : -1,
      y: typeof parsed.y === 'number' ? parsed.y : -1,
      collapsed: Boolean(parsed.collapsed),
    };
  } catch {
    return { x: -1, y: -1, collapsed: false };
  }
}

function PerfRow({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className={`perf-overlay__row${bad ? ' perf-overlay__row--bad' : ''}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export function PerfOverlay() {
  const [pos, setPos] = useState<StoredPosition>(() => loadStored());
  const dragging = useRef<{ offsetX: number; offsetY: number } | null>(null);
  const [isLight, setIsLight] = useState(false);

  const fps = usePerfStore((s) => s.fps);
  const memoryMb = usePerfStore((s) => s.memoryMb);
  const ipcRate = usePerfStore((s) => s.ipcTimestamps.length);
  const slowIpc = usePerfStore((s) => s.slowIpcSamples);
  const topRenders = usePerfStore((s) => s.getTopRenders(5));
  const slowThresholdMs = usePerfStore((s) => s.slowThresholdMs);

  const theme = useSettingsStore((s) => s.config?.theme ?? 'System');

  useEffect(() => {
    const root = document.documentElement;
    const update = () => setIsLight(!root.classList.contains('dark'));
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // FPS + memory sampling loop
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let last = performance.now();
    const setFps = usePerfStore.getState().setFps;
    const setMemoryMb = usePerfStore.getState().setMemoryMb;

    const tick = () => {
      frames++;
      const now = performance.now();
      if (now - last >= 1000) {
        setFps(Math.round((frames * 1000) / (now - last)));
        frames = 0;
        last = now;
        const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
        setMemoryMb(mem?.usedJSHeapSize ? mem.usedJSHeapSize / 1048576 : null);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const persist = useCallback((next: StoredPosition) => {
    setPos(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    dragging.current = { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top };
    el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const x = e.clientX - dragging.current.offsetX;
    const y = e.clientY - dragging.current.offsetY;
    persist({ ...pos, x, y });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragging.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  };

  const toggleCollapsed = () => persist({ ...pos, collapsed: !pos.collapsed });

  const openDevtools = useCallback(async () => {
    try {
      await getCurrentWebviewWindow().openDevtools();
    } catch (error) {
      console.warn('[PerfOverlay] open devtools failed:', error);
    }
  }, []);

  const openConsole = useCallback(async () => {
    try {
      const info = await invoke<{ enabled: boolean; addr: string }>('get_tokio_console_info');
      if (info.enabled) {
        await navigator.clipboard.writeText(info.addr);
        console.info(`[PerfOverlay] tokio-console enabled at ${info.addr} (已复制到剪贴板)`);
      } else {
        console.info('[PerfOverlay] tokio-console 未启用。请用 `npm run tauri dev -- --features tokio-console` 启动');
      }
    } catch (error) {
      console.warn('[PerfOverlay] get_tokio_console_info failed:', error);
    }
  }, []);

  const exportSnapshot = useCallback(async () => {
    try {
      const snap = usePerfStore.getState().snapshot();
      const filePath = await save({
        defaultPath: `codemux-perf-${Date.now()}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!filePath) return;
      await invoke('export_perf_snapshot', { path: filePath, content: JSON.stringify(snap, null, 2) });
      console.info(`[PerfOverlay] snapshot exported to ${filePath}`);
    } catch (error) {
      console.warn('[PerfOverlay] export failed:', error);
    }
  }, []);

  const left = pos.x >= 0 ? pos.x : undefined;
  const top = pos.y >= 0 ? pos.y : undefined;
  const style: React.CSSProperties = left !== undefined ? { left, top, right: 'auto' } : {};

  if (pos.collapsed) {
    return (
      <div
        className={`perf-overlay is-${isLight ? 'light' : 'dark'}`}
        style={style}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <button className="perf-overlay__collapsed" onClick={toggleCollapsed}>
          <Gauge size={12} /> Perf
        </button>
      </div>
    );
  }

  const slowTop5 = [...slowIpc].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);

  return (
    <div
      className={`perf-overlay is-${isLight ? 'light' : 'dark'}`}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="perf-overlay__header">
        <span>Performance</span>
        <button className="perf-overlay__toggle" onClick={toggleCollapsed} title="折叠">–</button>
      </div>
      <PerfRow label="FPS" value={String(fps)} bad={fps > 0 && fps < FPS_BAD_THRESHOLD} />
      <PerfRow label="内存 (MB)" value={memoryMb !== null ? memoryMb.toFixed(1) : 'N/A'} />
      <PerfRow label="IPC/秒" value={String(ipcRate)} />

      <div style={{ marginTop: 4, opacity: 0.8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>慢 IPC Top-5 (&gt;</span>
        <select
          value={slowThresholdMs}
          onChange={(e) => usePerfStore.getState().setSlowThresholdMs(Number(e.target.value))}
          style={{ background: 'transparent', color: 'inherit', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 3, fontSize: 10 }}
        >
          <option value={10}>10ms</option>
          <option value={50}>50ms</option>
          <option value={100}>100ms</option>
          <option value={250}>250ms</option>
        </select>
        <span>)</span>
      </div>
      <ul className="perf-overlay__list">
        {slowTop5.length === 0 ? (
          <li style={{ opacity: 0.5 }}>无</li>
        ) : (
          slowTop5.map((s, i) => (
            <li key={`${s.command}-${i}`} title={s.command}>
              <span>{s.command}</span>
              <span>{s.durationMs.toFixed(0)}ms</span>
            </li>
          ))
        )}
      </ul>

      <div style={{ marginTop: 4, opacity: 0.8 }}>Re-render Top-5</div>
      <ul className="perf-overlay__list">
        {topRenders.length === 0 ? (
          <li style={{ opacity: 0.5 }}>无</li>
        ) : (
          topRenders.map((r) => (
            <li key={r.id} title={r.id}>
              <span>{r.id}</span>
              <span>{r.commitCount}× / {r.totalMs.toFixed(0)}ms</span>
            </li>
          ))
        )}
      </ul>

      <div className="perf-overlay__actions">
        <button onClick={openDevtools}>DevTools</button>
        <button onClick={openConsole}>Console</button>
        <button onClick={exportSnapshot}>快照</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 类型检查**

Run: `npm run build`
Expected: tsc 通过。

> 注意：`@tauri-apps/api/webview-window` 与 `@tauri-apps/plugin-dialog` 已在 package.json 依赖中，无需新增。

- [ ] **Step 4: 提交**

```bash
git add src/components/dev/PerfOverlay.tsx src/components/dev/PerfOverlay.css
git commit -m "feat(perf): add PerfOverlay floating diagnostics panel"
```

---

## Task 5: 挂载浮层 + AgentPanel Profiler 包裹

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/agent/AgentPanel.tsx`（CodeMuxAssistantRuntimeProvider 外层）

把浮层挂到应用根（DEV 门控），给消息树包 React `<Profiler>`。

- [ ] **Step 1: App.tsx 挂载浮层 + 快捷键**

Modify `src/App.tsx`. 文件 line 2 已是 `import { lazy, Suspense, useEffect, useState } from 'react';`，复用即可。

在现有 lazy 声明区（line 31 `const SessionHeader = lazy(...)` 之后）追加 DEV 条件 lazy：

```tsx
const PerfOverlay = import.meta.env.DEV
  ? lazy(async () => ({ default: (await import('./components/dev/PerfOverlay')).PerfOverlay }))
  : null;
```

在 `App` 函数内，`return (` 之前（约 line 137 前）加快捷键 effect。先在函数体顶部 state 区（line 54 `useState` 之后）加浮层可见状态来源：

```tsx
  const [perfOverlayVisible, setPerfOverlayVisible] = useState(true);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault();
        setPerfOverlayVisible((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
```

在 JSX 的 `<TooltipProvider>` 内（line 139 之后、`<MainLayout` 之前）挂载浮层：

```tsx
      <TooltipProvider>
        {PerfOverlay && perfOverlayVisible && (
          <Suspense fallback={null}>
            <PerfOverlay />
          </Suspense>
        )}
        <MainLayout
```

（保持 MainLayout 的其余 props 不变。）

- [ ] **Step 2: AgentPanel 包 Profiler**

Modify `src/components/agent/AgentPanel.tsx`.

在顶部 import 区（line 1）追加 React Profiler：

```tsx
import { Profiler, useCallback, useEffect, useMemo, useRef, useState } from 'react';
```

在 import 区（line 15 `import { useSettingsStore }` 之后）加 perfStore：

```tsx
import { usePerfStore } from '../../stores/perfStore';
```

在 `return (` 的 JSX 中（line 316），把 `<CodeMuxAssistantRuntimeProvider>` 用 `<Profiler>` 包裹。Profiler 的 `onRender` 只在 DEV 下写 store。由于 React Profiler 在生产构建本就 noop，但为避免 perfStore 在 release 被打包，用 DEV 门控选择渲染函数。

替换 line 317-318 的：

```tsx
    <div ref={containerRef} className="flex h-full flex-col">
      <CodeMuxAssistantRuntimeProvider sessionId={sessionId} agentKind={agentKind} onSend={handleSend} onCommand={handleCommand} sendDisabled={!hasUsableProfile}>
```

为：

```tsx
    <div ref={containerRef} className="flex h-full flex-col">
      <Profiler id="MessageList" onRender={handleProfilerRender}>
      <CodeMuxAssistantRuntimeProvider sessionId={sessionId} agentKind={agentKind} onSend={handleSend} onCommand={handleCommand} sendDisabled={!hasUsableProfile}>
```

并在对应闭合处（line 363 `</CodeMuxAssistantRuntimeProvider>` 之后）加 `</Profiler>`：

```tsx
      </CodeMuxAssistantRuntimeProvider>
      </Profiler>
```

在组件函数体内（`return (` 之前，约 line 316 前）加 `handleProfilerRender` 回调：

```tsx
  const handleProfilerRender = useCallback(
    (_id: string, _phase: 'mount' | 'update', actualDuration: number, baseDuration: number) => {
      if (import.meta.env.DEV) {
        usePerfStore.getState().recordRender('MessageList', actualDuration, baseDuration);
      }
    },
    [],
  );
```

- [ ] **Step 3: 类型检查**

Run: `npm run build`
Expected: tsc 通过。

- [ ] **Step 4: 前端测试回归**

Run: `npx vitest run`
Expected: 全绿（含新增 perfStore 测试，无既有测试破坏）。

- [ ] **Step 5: 提交**

```bash
git add src/App.tsx src/components/agent/AgentPanel.tsx
git commit -m "feat(perf): mount PerfOverlay and wrap message tree with Profiler"
```

---

## Task 6: 集成验证

- [ ] **Step 1: Rust 全量检查**

Run: `cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo check --all-targets --all-features`
Expected: 全部通过。

- [ ] **Step 2: 前端全量测试**

Run: `npx vitest run`
Expected: 全绿。

- [ ] **Step 3: 前端 release 构建确认零诊断代码**

Run: `npm run build`
Expected: 构建成功。
验证：在 `dist/` 产物中搜索诊断代码是否被 tree-shake 掉：

```bash
rg -c "PerfOverlay|perfStore|recordIpc" dist/assets/*.js || echo "clean: no perf symbols in release bundle"
```
Expected: 输出 `clean: no perf symbols in release bundle`（或匹配数为 0），证明 DEV 门控生效。

- [ ] **Step 4: 功能手动验证（需启动桌面应用）**

Run: `npm run tauri dev`
逐项验证：
1. 启动后右上角出现性能浮层，FPS/内存数字每秒刷新
2. 发起一次流式对话，观察"IPC/秒"数值随流式事件跳动
3. 观察浮层"Re-render Top-5"出现 "MessageList" 条目，commit 次数随流式增长
4. 按 `Ctrl+Shift+D` 浮层隐藏，再按恢复
5. 点击浮层"DevTools"按钮，Chrome DevTools 窗口打开
6. 点击浮层"快照"按钮，选择路径保存，文件写入成功且含 JSON
7. 拖拽浮层可移动位置，刷新应用后位置保留
8. 点击折叠按钮，浮层缩为小图标，再点恢复

- [ ] **Step 5: 可选 feature 手动验证**

Run: `npm run tauri dev -- --features tokio-console`
验证：
1. 终端看到 console-subscriber 启动输出（监听 127.0.0.1:6669）
2. 另开终端运行 `tokio-console`（需全局安装 `cargo install tokio-console`）能连接
3. 浮层点击"Console"按钮，控制台输出地址并复制到剪贴板

- [ ] **Step 6: 最终提交（如有手动验证产生的微调）**

```bash
git status
# 如有未提交的微调：
git add -A && git commit -m "chore(perf): polish after integration verification"
# 如无改动则跳过
```

---

## 完成标准（对照 spec 验证清单）

1. ✅ `npm run tauri dev` 启动后浮层显示，FPS/内存/IPC 实时刷新 — Task 6 Step 4
2. ✅ 流式对话时浮层能看到 IPC 数 + re-render Top-N 命中 MessageList — Task 6 Step 4
3. ✅ `Ctrl+Shift+D` 切换浮层 — Task 6 Step 4
4. ✅ release 构建不含 perfStore / PerfOverlay 代码 — Task 6 Step 3
5. ✅ `npx vitest run` 全绿；`cargo clippy --all-targets --all-features -- -D warnings` 无警告 — Task 6 Step 1-2
6. ✅ 不带新 feature 时与改动前行为一致（默认 feature 为空） — Task 3 Step 5

## 开发期启用方式（备忘）

- 前端浮层：`npm run tauri dev` 自动可用
- Rust tokio-console：`npm run tauri dev -- --features tokio-console`
- Rust 命令 tracing：`npm run tauri dev -- --features cmd-tracing`
