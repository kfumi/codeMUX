# CodeMUX 软件更新机制设计

## 背景

codeMUX 是 Tauri 2 桌面应用，当前发布链路已将安装包发布到本仓库 `kfumi/codeMUX` 的 GitHub Releases，但应用内尚未接入更新检测、下载和安装流程。参考项目已经验证了基于 Tauri Updater Plugin 的分层设计：Tauri 配置负责签名校验和更新端点，前端 Hook 负责状态机，UI 负责用户反馈。

本设计将该机制适配到 CodeMUX 现有结构：React/Vite 前端、Tauri 2 后端、自定义标题栏、设置页中的“关于”页面，以及现有 `sonner` 全局通知体系。

## 目标

- 应用启动后在生产环境静默检查更新。
- 用户可以在“设置 > 关于”中手动检查更新。
- 检测到新版本后展示全局更新提示，用户可选择稍后或立即更新。
- 支持下载进度、安装中、重启中、失败重试、已是最新等反馈。
- 使用 Tauri updater 的签名校验能力，为正式发布保留安全边界。
- 文档说明占位公钥如何替换为真实公钥，以及私钥如何放入 GitHub Secrets。

## 非目标

- 不新增原生应用菜单。当前 CodeMUX 使用自定义标题栏和托盘菜单，手动入口放在“关于”页即可覆盖需求。
- 不实现发布说明弹窗。后续可单独基于 `CHANGELOG.md` 增加版本说明展示。
- 不在开发环境自动检查更新，避免本地调试时频繁访问发布端点。
- 不把真实私钥写入仓库。

## 推荐方案

采用“全局更新状态机 + 关于页手动入口 + Tauri updater 配置”的方案。

### 方案取舍

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| 原生菜单触发检查 | 与参考项目接近 | CodeMUX 没有完整原生菜单，改动面偏大 | 不采用 |
| 仅关于页手动检查 | 实现最小 | 不满足启动自动检测 | 不采用 |
| 全局状态机与关于页入口 | 贴合现有架构，覆盖自动和手动流程 | 需要新增 Hook、UI 和测试 | 采用 |

## 架构

### Tauri 层

Tauri 层负责启用 updater 插件并配置更新源：

- `src-tauri/Cargo.toml` 增加 `tauri-plugin-updater`。
- `package.json` 增加 `@tauri-apps/plugin-updater`。
- `src-tauri/src/lib.rs` 注册 updater 插件。
- `src-tauri/tauri.conf.json` 增加 `plugins.updater`，endpoint 指向公开下载仓库的 `latest.json`。
- `src-tauri/tauri.conf.json` 的 `bundle.createUpdaterArtifacts` 设置为 `true`。
- `src-tauri/capabilities/default.json` 增加 updater 权限。

`pubkey` 先使用明确标注的占位公钥。占位公钥只能用于完成结构接入，正式发布前必须替换为真实公钥，否则安装更新会因为签名校验失败而不可用。

### 前端逻辑层

新增 `src/features/update/hooks/useUpdater.ts`，负责更新状态机。

状态类型：

```typescript
type UpdateStage =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'restarting'
  | 'latest'
  | 'error';
```

核心状态：

- `stage`：当前阶段。
- `version`：检测到的新版本号。
- `progress`：下载总量与已下载字节数。
- `error`：失败信息。
- `checkForUpdates(options)`：检查更新。
- `startUpdate()`：下载并安装更新。
- `resetToIdle()`：关闭当前提示并清理临时状态。

检查模式：

| 场景 | 行为 |
| --- | --- |
| 启动静默检查 | 生产环境、Tauri 环境下自动触发；失败和无更新都不打扰用户 |
| 手动检查 | 展示检查中；无更新显示“已是最新”；失败显示错误并允许重试 |
| 检测到更新 | 展示可用版本和更新按钮 |

并发保护：

`useUpdater` 使用递增请求 ID 实现“最新请求获胜”。如果用户快速连续触发检查，旧请求的结果不得覆盖新请求已经写入的状态。

资源清理：

组件卸载或用户关闭提示时，需要清除“已是最新”自动消失定时器，并使仍在进行的检查结果失效。

### 前端 UI 层

新增 `src/features/update/components/UpdateToast.tsx`。

展示规则：

| 阶段 | UI |
| --- | --- |
| `checking` | 显示“正在检查更新” |
| `available` | 显示新版本号，提供“稍后”和“立即更新” |
| `latest` | 显示“当前已是最新版本”，短暂展示后自动关闭 |
| `downloading` | 显示下载进度条与大小 |
| `installing` | 显示“正在安装更新” |
| `restarting` | 显示“正在重启应用” |
| `error` | 显示失败原因，提供“关闭”和“重试” |

`App.tsx` 在全局挂载更新控制器和 `UpdateToast`。现有 `Toaster` 继续用于普通 toast，更新提示使用专用组件，避免下载进度被普通 toast 生命周期干扰。

### 手动入口

`src/components/settings/AboutSettings.tsx` 增加“检查更新”按钮。

按钮行为：

- 点击后调用全局更新控制器的 `checkForUpdates({ interactive: true, announceNoUpdate: true })`。
- 检查中禁用按钮或显示加载态。
- 在非 Tauri 环境或开发环境中不执行真实检查，并给出温和反馈，避免浏览器测试报错。

为了让“关于”页和全局 toast 共享同一份更新状态，新增轻量级上下文：

- `UpdaterProvider` 挂载在 `App.tsx`。
- `useUpdaterContext()` 供 `AboutSettings` 和 `UpdateToast` 使用。

## 数据流

### 启动自动检查

```text
App 挂载
  -> UpdaterProvider 初始化 useUpdater
  -> 生产 Tauri 环境自动调用 checkForUpdates()
  -> 无更新或失败：回到 idle
  -> 有更新：进入 available，展示 UpdateToast
```

### 手动检查

```text
用户进入 设置 > 关于
  -> 点击“检查更新”
  -> AboutSettings 调用 checkForUpdates({ interactive: true, announceNoUpdate: true })
  -> 检查中展示 checking
  -> 无更新展示 latest
  -> 有更新展示 available
  -> 失败展示 error
```

### 下载和安装

```text
用户点击“立即更新”
  -> startUpdate()
  -> downloadAndInstall 监听下载事件
  -> Progress 更新 downloadedBytes
  -> Finished 进入 installing
  -> 安装成功进入 restarting
  -> relaunch() 重启应用
```

## 错误处理

- 启动静默检查失败：记录日志，回到 `idle`，不展示错误。
- 手动检查失败：进入 `error`，显示简洁错误信息，允许重试。
- 下载或安装失败：进入 `error`，保留重试按钮。
- 非 Tauri 或开发环境：手动检查展示“当前环境不支持更新检查”或等价提示，不调用 updater API。
- updater 未配置真实公钥时：正式安装会失败，文档明确这是占位配置的预期限制。

## 测试计划

新增或更新以下测试：

- `useUpdater.test.ts`：覆盖静默检查、手动检查、无更新、发现更新、错误、并发请求覆盖、下载进度、重置清理。
- `UpdateToast.test.tsx`：覆盖各阶段渲染、按钮回调、进度显示、错误重试。
- `AboutSettings.test.tsx`：覆盖“检查更新”按钮、加载态、上下文调用。
- 现有构建检查：`npm run build`。

Rust 侧改动仅注册插件和配置依赖，执行：

- `cd src-tauri && cargo check --all-targets --all-features`
- `cd src-tauri && cargo fmt --all -- --check`

## 发布配置与密钥

占位阶段：

- `tauri.conf.json` 中写入占位 `pubkey`。
- 文档明确占位公钥不能用于正式安装。

正式发布前：

- 使用 Tauri CLI 生成 updater 密钥对。
- 将公钥写入 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。
- 将私钥和私钥密码配置到 GitHub Secrets。
- 发布 workflow 在构建时通过环境变量提供签名私钥。
- 确认 GitHub Release 附件包含 `latest.json` 和对应平台更新包。

## 验收标准

- 生产 Tauri 环境启动后会静默检查公开下载仓库的最新版本。
- “设置 > 关于”显示手动检查更新按钮。
- 手动检查无更新时有明确反馈。
- 检测到更新时展示新版本并可触发下载和安装。
- 下载期间显示进度，安装完成后重启应用。
- 静默检查失败不打扰用户，手动检查失败可重试。
- 更新相关文档说明真实密钥的生成和配置步骤。
