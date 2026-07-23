# 开发期全栈性能诊断集成设计

- 日期：2026-07-23
- 状态：已确认，待实施
- 方案：C（混合方案 — 薄自研浮层 + 原生工具一键拉起）

## 目标

为 CodeMUX 提供一套开发期专用的性能诊断能力，解决"卡顿来自前端、Rust 后端还是 IPC"无法快速定位的问题。

## 范围与非目标

**在范围内：**
- 前端性能浮层（FPS、内存、IPC 计数、慢调用、re-render Top-N）
- IPC 全量计时（自动覆盖所有 Tauri 命令）
- React Profiler 对消息树的包裹统计
- Tauri DevTools 在 dev 构建可用
- Rust 后端 tokio-console 与命令 tracing 的可选 feature
- 快照导出（JSON）

**非目标：**
- 生产构建的诊断能力（release 完全移除，零开销）
- 自动性能回归测试 / CI 性能门禁
- 远程性能上报 / APM
- Node sidecar 的独立 profiling（可通过 tokio-console 或 `--cpu-prof` 间接覆盖，本次不单独集成）

## 核心设计原则

1. **编译期门控，release 零开销**：所有诊断代码用 `import.meta.env.DEV`（前端）和 Cargo feature / `cfg(debug_assertions)`（Rust）包裹。release 构建中这些代码完全不存在，不引入运行时分支成本。
2. **单一埋点点**：IPC 计时只改 `src/lib/tauri.ts` 的 `invokeLogged` 一处，所有命令自动覆盖；re-render 计数只包消息渲染树，不逐组件埋点。
3. **薄自研 + 强原生**：浮层只做信号聚合和"一眼定位是哪层"，深度分析交给 React Profiler / Chrome DevTools / tokio-console。
4. **零侵入业务逻辑**：不改动任何现有 store 命令、Rust 命令签名或业务数据结构。

## 架构概览

```
┌─────────────────────────────────────────────────────────┐
│  性能浮层 PerfOverlay（React，dev 挂载在 App.tsx 根）     │
│  FPS · 内存 · IPC 调用数/慢调用 · 组件 re-render Top-N   │
│  [按钮] 打开 DevTools / 启动 tokio-console / 导出快照     │
└────────────┬──────────────────────────────┬─────────────┘
             │ 订阅                          │ 触发
┌────────────▼────────────┐   ┌─────────────▼─────────────┐
│ perfStore (Zustand)      │   │ 原生下钻工具（一键拉起）   │
│ · IPC 计时环形缓冲        │   │ · Chrome DevTools         │
│ · re-render 计数          │   │ · React Profiler          │
│ · FPS/内存采样            │   │ · tokio-console           │
└────────────┬─────────────┘   └───────────────────────────┘
             │ 采集
┌────────────▼────────────────────────────────────────────┐
│ 埋点位置（仅 DEV 编译）                                   │
│ · invokeLogged() 包裹 → 自动测所有 IPC 耗时              │
│ · <Profiler> 包裹消息树 → re-render 计数                  │
│ · Rust: tracing span 包裹命令 → 慢命令日志 + 导出         │
└─────────────────────────────────────────────────────────┘
```

## 详细设计

### 1. 前端性能浮层组件（PerfOverlay）

固定在右上角的半透明浮窗，开发期挂载。

**显示指标：**

| 指标 | 采集方式 | 显示形式 |
|---|---|---|
| FPS | `requestAnimationFrame` 循环，每秒算帧数 | 数字，<30 标红 |
| 内存 | `performance.memory.usedJSHeapSize`（Chromium 系，不可用时隐藏） | MB，含增长趋势 |
| IPC 调用数/秒 | `invokeLogged` 累加，每秒重置 | 数字 |
| 慢 IPC Top-5 | 环形缓冲（容量 50），记录 >阈值 的调用 | 列表：命令名 + 耗时 |
| Re-render Top-5 | `<Profiler>` 统计提交，按 commit 次数聚合 | 列表：组件名 + 次数 + 累计耗时 |

**慢 IPC 阈值：** 默认 50ms，浮层内可调（10/50/100/250ms）。

**交互：**
- 可拖拽移动位置
- 可折叠为一个小图标（避免遮挡）
- 快捷键 `Ctrl+Shift+D` 切换显示/隐藏
- 状态持久化到 `localStorage`（仅位置和折叠态）

**底部按钮：**
- 打开 DevTools：调用 Tauri `open_devtools`（dev 构建可用）
- 启动 tokio-console：调用 Rust 命令返回连接地址并复制到剪贴板
- 导出快照：把 `perfStore` 当前数据序列化为 JSON，通过 `dialog` 插件落盘

### 2. perfStore（Zustand）

新增 `src/stores/perfStore.ts`，职责：

- **`ipcSamples`**：环形缓冲，每条 `{ command, durationMs, timestamp }`，容量 50（慢调用）+ 最近 1 秒计数窗口
- **`renderSamples`**：环形缓冲，每条 `{ componentId, commitCount, totalMs }`，容量 50
- **`fps`** / **`memoryMb`**：最近采样值
- **`overlayVisible`**：浮层开关，默认 `true`（dev 下默认可见）
- **`slowThresholdMs`**：可配置阈值

**采集与 UI 解耦**：浮层组件用 `requestAnimationFrame` 自采样 FPS/内存，并通过订阅 store 渲染 IPC/render 数据。store 只负责数据，不负责采样循环（采样循环在浮层 effect 中跑，卸载即停）。

### 3. 前端埋点（两处改动）

**3.1 `src/lib/tauri.ts` 的 `invokeLogged`（tauri.ts:123）**

所有 IPC 的唯一入口。开发期在 `invoke` 前后用 `performance.now()` 计时：

```ts
async function invokeLogged<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  // ...现有 logging 逻辑保留...

  if (import.meta.env.DEV) {
    const start = performance.now();
    try {
      const result = await invoke<T>(command, args);
      const duration = performance.now() - start;
      recordIpcSample(command, duration); // 写入 perfStore
      return result;
    } catch (error) {
      const duration = performance.now() - start;
      recordIpcSample(command, duration, true); // 标记失败
      throw error;
    }
  }
  // release 分支保持原逻辑
  return invoke<T>(command, args);
}
```

门控方式：`import.meta.env.DEV` 是 Vite 编译期常量，release 构建中 false 分支的代码会被 dead-code elimination 移除。

**3.2 `AgentPanel` 消息树包裹 `<Profiler>`**

在 `AgentPanel` 渲染消息列表的外层包**一个** React `<Profiler name="MessageList">`，`onRender` 回调将 commit 信息（actualDuration、baseDuration、commit 次数）写入 perfStore。

设计取舍：采用单 Profiler 包整个消息树，而非给每个子组件分别套 Profiler。理由：(1) 只需改 AgentPanel 一处，改动面最小；(2) 流式卡顿的首要信号是"消息树整体在频繁 commit"，单 Profiler 即可捕获；(3) 多 Profiler 会放大 Profiler 自身开销并污染测量结果。若后续需要下钻到具体子组件，再在 React DevTools Profiler 面板里用原生工具分析。

因此 "Re-render Top-N" 在初期实际显示为 "MessageList" 这一个聚合条目（commit 次数 + 累计耗时）。Top-N 的结构保留，便于将来加入更多 Profiler 节点时直接填充。

### 4. Rust 后端埋点

**4.1 Cargo.toml 变更**

```toml
[features]
default = []
tokio-console = ["tokio/tracing", "dep:console-subscriber", "dep:tracing", "dep:tracing-subscriber"]
cmd-tracing = ["dep:tracing", "dep:tracing-subscriber"]

[dependencies]
tracing = { version = "0.1", optional = true }
tracing-subscriber = { version = "0.3", optional = true, features = ["env-filter"] }
console-subscriber = { version = "0.4", optional = true }
```

Tauri DevTools：Tauri 2 的 debug 构建默认携带 DevTools，`npm run tauri dev` 下右键即可打开，无需额外 Cargo feature 或配置。release 构建（`npm run tauri build`）不携带，符合"开发期专用"要求。因此本次不在 `Cargo.toml` 为 `tauri` 添加 `devtools` feature。

**4.2 lib.rs 条件初始化**

```rust
fn init_tracing() {
    #[cfg(feature = "tokio-console")]
    {
        console_subscriber::init();
    }
    #[cfg(all(feature = "cmd-tracing", not(feature = "tokio-console")))]
    {
        tracing_subscriber::fmt()
            .with_env_filter(tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("codemux_lib=warn".parse().unwrap()))
            .init();
    }
}
```

慢命令：cmd-tracing feature 下，关键命令手动加 `#[tracing::instrument]`（优先 agent、git、db 命令），慢于阈值的 span 由 tracing-subscriber 的 fmt 层输出 WARN。不追求全量覆盖，先覆盖嫌疑大的命令。

**4.3 快照导出命令**

新增 `src-tauri/src/commands/perf.rs`，提供：
- `get_tokio_console_addr`：返回 console-subscriber 监听地址（feature 门控，非 feature 时返回提示字符串）
- `export_perf_snapshot`：把传入的 JSON 写到用户选定路径（复用 dialog 插件）

在 `lib.rs` 的 `invoke_handler` 注册这两个命令。

### 5. 挂载与开关

- `src/App.tsx`：在根节点条件挂载 `PerfOverlay`，门控 `import.meta.env.DEV`；注册 `Ctrl+Shift+D` 全局快捷键（dev only）
- 设置页"常规"区域加一个只读说明项："性能诊断浮层（开发期）— Ctrl+Shift+D 切换"，不提供 UI 开关（避免污染生产设置面板）

### 6. Re-render Top-N 的组件标识

React `<Profiler>` 的 `onRender(id, phase, actualDuration, ...)` 中 `id` 是 `<Profiler>` 的 name prop。

初期方案（见 3.2）：单 `<Profiler name="MessageList">` 包裹整个消息树，Top-N 表显示一条 "MessageList" 聚合记录（commit 次数 + 累计 actualDuration）。Top-N 的数据结构与渲染逻辑按多条目设计，便于将来无痛扩展。

若初版上线后发现需要下钻到具体子组件，按以下方式扩展（非本次范围）：在 `MessageItem`、`ToolCallCard`、`DiffView` 等热组件外层各套 `<Profiler name="...">`，perfStore 按 name 聚合，Top-N 自动显示多条。扩展时仅需改动对应子组件文件，perfStore 和浮层无需改动。

## 测试计划

遵循项目 Vitest + Testing Library 约定，测试文件 colocate：

- **`src/stores/perfStore.test.ts`**
  - 环形缓冲在超过容量时正确淘汰旧数据
  - 阈值过滤：只记录 >阈值 的慢调用
  - re-render 聚合：相同 componentId 的 commit 正确累加
  - IPC 计数窗口每秒重置
- **`invokeLogged` 计时包装**：mock `performance.now()` 和 `invoke`，验证 DEV 分支正确记录、release 分支不记录
- Rust 侧：`cargo test` 覆盖 `export_perf_snapshot` 的路径拼接与错误处理；feature 门控逻辑用 `cfg` 测试

不写浮层 UI 的快照测试（易碎，收益低）。

## 文件清单

**新增：**
```
src/stores/perfStore.ts                         # 性能数据 store
src/stores/perfStore.test.ts                    # store 测试
src/components/dev/PerfOverlay.tsx              # 浮层组件
src/components/dev/PerfOverlay.css              # 浮层样式
src-tauri/src/commands/perf.rs                  # Rust 性能命令（快照导出、console 地址）
```

**改动：**
```
src/lib/tauri.ts                                # invokeLogged 加 DEV 计时
src/App.tsx                                     # dev 挂载浮层 + 快捷键
src/components/agent/AgentPanel.tsx             # 包 <Profiler>
src-tauri/Cargo.toml                            # 加可选 feature + 可选依赖
src-tauri/src/lib.rs                            # 条件初始化 tracing + 注册 perf 命令
src-tauri/src/commands/mod.rs                   # 声明 perf 子模块
```

## 验证标准

1. `npm run tauri dev` 启动后，右上角出现性能浮层，FPS/内存/IPC 数实时刷新
2. 触发一次流式对话，浮层能看到 IPC 数飙升 + re-render Top-N 命中消息组件
3. `Ctrl+Shift+D` 能隐藏/显示浮层
4. `npm run build`（release）构建产物中不含 perfStore / PerfOverlay 代码（通过 bundle 分析确认 dead-code 已移除）
5. `npx vitest run` 全绿；`cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings` 无警告
6. `cargo build` 不带新 feature 时与改动前行为完全一致

## 开发期启用方式

- 前端浮层：`npm run tauri dev` 自动可用
- Rust tokio-console：`npm run tauri dev -- --features tokio-console`，然后另开终端 `tokio-console`
- Rust 命令 tracing：`npm run tauri dev -- --features cmd-tracing`，慢命令在终端输出 WARN

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| `<Profiler>` 自身有开销，影响测量准确性 | 初期仅单 Profiler 包消息树，开销可控；如需多 Profiler 下钻用原生 React DevTools |
| `performance.memory` 仅 Chromium 可用 | 不可用时隐藏内存指标，不报错 |
| tokio-console 改变 tokio runtime 行为 | 作为可选 feature，默认关闭，仅诊断时手动启用 |
| 浮层遮挡 UI 影响开发 | 可拖拽、可折叠、快捷键切换 |
