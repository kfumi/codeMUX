# Changelog

本项目所有重要变更将记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

自 0.1.0 以来的主要变更，将在正式开源版本中一并发布。

### Added

#### Agent 运行时
- 接入 `OpenCode` 作为第三个完整可用的 Agent 运行时，基于官方 `@opencode-ai/sdk`
  - 随应用分发独立 OpenCode Server，用户无需单独安装
  - 支持会话持久化与恢复、原生权限请求桥接（`once` / `always` / `reject`）
  - 支持 `plan` / `build` 双 Agent 切换，对应 Plan Mode
  - 支持图片附件输入与 `question.asked` 交互问答
  - 复用 CodeMUX 统一事件模型、工具卡片、权限审批 UI
  - SSE 事件订阅、去重、归一化与异常重连
- `Codex` 增加 Strict Local Plan Mode，会话级保存权限与计划模式
- `Claude Code`、`Codex`、`OpenCode` 三套运行时统一接入 MCP / Skills 适配器

#### 任务与自动化
- 新增工作任务看板（待办 / 进行中 / 等你处理 / 完成四列）：任务按项目配额排队，在 `git worktree` 隔离分支里创建真实会话执行，完成后可合并 / 标记完成 / 重新开始
- 新增定时任务：支持一次性、每日、每周、间隔等时点，到点自动新建会话执行指令，带启停开关、立即执行与运行历史

#### 对话与工作区
- 新增内置浏览器侧边面板：沙箱 webview（独立 partition、可配 CDP），随「设置 → 浏览器控制」开关提供内置 `codemux-browser` MCP，支持选取网页元素加入对话
- 新增对任意用户消息的回退（可同时回滚文件）与从任意回复分叉出新会话
- 整轮 AI 输出折叠为「已处理 + 时长 + 步骤数」，可展开查看思考、工具卡片与子智能体过程
- 新增流式输出速度显示（`xx.x tok/s`）
- 支持导入 Claude Code / Codex / OpenCode 的外部 CLI 会话历史
- 子智能体拥有独立时间线与实时预览面板
- 模型无视觉能力时，可用兜底视觉模型解析图片后注入上下文

#### 外观
- 外观可自定义主题、强调色、界面字体与字号、代码字号、圆角风格与幕布宽度，实时生效并持久化

#### 客户端
- 前端统一为一套构建（`dist-web/`）：桌面 UI、同机浏览器与手机浏览器共用；局域网 / 远程通过扫码配对访问

#### Provider 与模型
- 重构 Provider Profile：按 Claude Code / Codex / OpenCode 分标签管理
- Claude Code 默认供应商直接复用 `~/.claude/settings.json`，切换时自动备份为 `.bak` 并支持回滚
- Claude Code 供应商支持 Sonnet / Opus / Fable 独立 1M 声明
- 新增模型选择器组件，替代原下拉选择，支持品牌图标与 1M 标记
- OpenCode 支持多 AI SDK Adapter（`@ai-sdk/openai`、`@ai-sdk/anthropic`、`@ai-sdk/openai-compatible`、`@ai-sdk/google`、`@ai-sdk/amazon-bedrock`）

#### 使用统计与用量
- 新增使用统计页面：365 天活跃热力图（按 token 消耗着色）
- 每日 token 堆叠柱状图，分输入 / 缓存 / 输出三段
- 按 Agent / 模型分布统计，支持时间窗口（7 / 30 / 90 / 365 天）与 Agent 类型筛选
- 概览卡片：会话总数、累计 token、缓存命中率
- 后端聚合 365 天 token 数据，从各 Agent 原生历史中提取

#### 对话与交互
- 新增 `AskUserQuestion` 交互卡片，支持选项选择与自由文本回答
- 新增图片附件输入与预览（多模态）
- 新增实时上下文使用进度组件，展示 token 占用与上下文窗口占比
- 切换至 `@assistant-ui/react` 作为对话运行时框架

#### 工作区
- Git 分支管理：分支切换、新建分支、AI 辅助生成 Commit Message
- Git Commit / Push 一站式操作（含未暂存改动选项）
- Plan Preview 面板

#### 系统通知与提示音
- 任务完成、权限审批、用户问答时自动触发系统通知
- 内置多种提示音（bell / chime / ding / success / task-complete），支持预览与切换

#### 自动更新
- 启动时检查 GitHub Releases，支持下载、校验、安装并重启的一站式流程
- 侧边栏更新入口展示版本信息与进度

#### Skills
- Skills 以 `~/.codemux/skills/` 作为单一数据源
- Windows 下按 symlink → junction → copy 回退链处理跨卷与权限问题
- 每个 Skill 维护 4 个独立的 per-agent 启用开关（Claude / Codex / Gemini / OpenCode）

#### 开发与诊断
- 开发模式性能诊断覆盖层（FPS、渲染时长等）
- 前端日志按模块前缀输出（`[agentStore]`、`[CodeMuxThread]` 等）
- Sidecar 日志包含会话初始化、输入发送、错误信息，并对大内容智能截断

#### 键盘快捷键
- 新增可改键的快捷键系统：9 条内置命令（后退 / 前进、新建会话、打开设置、搜索、折叠侧边栏 / 侧面板、停止生成、聚焦输入框），每条都能在「设置 → 快捷键」里重绑、禁用或恢复默认
- 键位按物理键（`event.code`）匹配，与键盘布局无关；只允许带修饰键或 F1–F12 的键位，录制时直接拒绝系统保留键位与已占用键位
- 键位覆盖存于 daemon `config.json`（随所有 Daemon Client 一致）；「显式解绑」与「用出厂默认」是两种不同状态
- 搜索对话框新增「命令」分区，搜索结果与按钮提示直接展示当前键位
- 「设置 → 快捷键」分区按分组列出全部命令：点键位即进入录制，行尾图标单独禁用或恢复该命令，标题栏右侧一键恢复全部默认
- 键位提示跟随改键：侧栏「新对话 / 搜索」在该行悬停或键盘聚焦时显示当前键位，标题栏、设置与停止按钮的 tooltip 及 `aria-keyshortcuts` 同步更新
- 决策与取舍见 [ADR 0013](docs/adr/0013-user-configurable-keyboard-shortcuts.md)

### Changed

#### 架构（Daemon 边界）
- 移除 Tauri 壳，发布面切换为 **Electron 桌面壳 + 独立 Rust daemon 进程**（`codemux-daemon`，见 ADR 0011 / 0012）
  - daemon 为权威进程：拥有 SQLite、会话、Agent 编排、Sidecar、MCP、Skills 与定时任务，启动即监听回环并写 `daemon-run-state.json`
  - Electron 壳作为 supervisor 拉起 / 附着 / 重启 daemon（健康检查 + 版本配对仲裁），只承载窗口、托盘、通知、自动更新与 Browser Host
  - 壳崩溃不再影响权威；`src-tauri/` 目录名保留，内容为 daemon crate
  - 前端 `@tauri-apps` 依赖与 invoke 后端全部退役，壳能力改经 contextBridge（`window.codemuxDesktop`）暴露
- 自动更新迁移到 electron-updater（GitHub Releases feed），系统通知改用 Electron AppUserModelID
- 内置 Browser Host 迁移 Chromium：渲染层沙箱 `<webview>`（独立 partition，与应用 IPC 隔离），CDP 经 `webContents.debugger` 可用
- 新增 daemon→壳受控自动化接缝：桌面 UI 事件出口（sessions-changed 等）与浏览器自动化请求队列，均复用既有控制面 WS 通道
- 桌面 UI、移动伴侣（PWA）与本机 CLI 统一为 Daemon Client，共享回环 Companion REST/WS + CodeMUX Event 协议

#### Agent 运行时
- 新增 `pi` 运行时：基于 pi RPC 的极简多供应商编码 Agent，支持会话恢复、工具审批、`AskUserQuestion` 与 steer

#### 界面
- 设置面板改为面板式表单切换，不再使用弹窗 Modal
- 外观设置通过 CSS 变量覆盖（`applyAppearance()`），UI 状态经 localStorage + Zustand 持久化
- 视图切换统一使用 `animate-fade-in-up` 动画
- Claude Code token 用量计算统一使用 `input_tokens + cache_read_input_tokens`，并优先取 `result` 事件的 `last_token_usage`
- Codex 启动统一从 `~/.codex/` 读取配置，保留登录与 vendor 信息

### Fixed

- 修复冷启动白闪：主题真值在 daemon 配置里，之前要等 `fetchConfig()` 往返才给 `<html>` 打上 `.dark`，这段窗口里界面按亮色绘制；现在 `index.html` 在 `<head>` 里用一段同步引导脚本按缓存的主题先行上色，首帧即为目标主题
- 修复启动加载画面底色固定为深色导致浅色主题下「深底 → 浅底」跳色：底色改为跟随主题
- 修复侧边栏会话列表首屏先闪一下「暂无对话」空态再换成真实列表：区分「还没加载」与「确实为空」，加载中改为渲染骨架行
- 修复 Windows 主窗口隐藏到托盘后点击系统通知无法唤醒的问题
- 修复 OpenCode 会话中断后残留孤儿进程的问题
- 修复 Codex 会话历史恢复时上下文丢失的问题
- 修复重复权限请求导致前端重复弹窗的问题

## [0.1.0] - 2026-06-07

### Added
- Agent 对话面板，基于 Claude Agent SDK，支持流式响应
- 流式 Markdown 渲染，支持 GFM 语法高亮、表格、原始 HTML
- 工具调用可视化卡片，展示工具名称、参数和执行结果
- Thinking 思考块（可折叠）
- 终端输出块（终端风格渲染）
- Diff 代码对比块（统一 Diff 格式 + 语法高亮）
- Todo 列表组件，支持进度状态实时更新
- 交互式提问卡片（选项选择 + 自由文本）
- 多提供商配置：Anthropic、OpenAI 兼容端点、DeepSeek
- 每个提供商独立 API Key、Base URL、默认模型配置
- 提供商连通性测试与延迟显示
- 模型列表自动拉取
- Token 用量与费用统计（输入/缓存读取/输出 分别计价）
- MCP 服务器管理：增删改查界面
- MCP 三种传输协议支持：stdio、HTTP Streaming、SSE
- MCP 配置向导（图形化参数填写）
- MCP 启动自动探测连通性，状态指示灯
- MCP 配置双写（SQLite + `~/.claude.json`，兼容 Claude CLI）
- Skills 技能系统：从 GitHub 仓库浏览安装
- 内置技能：`find-skills`、`skill-creator`
- Skills 斜杠命令调用
- Skills 启用/禁用/卸载管理
- 文件预览面板：文件树浏览器、文件内容查看器、统一 Diff 视图
- 会话与项目管理：多会话按项目分组、重命名、删除
- 主题系统：亮色 / 暗色 / 跟随系统
- 上下文窗口进度条
- 斜杠命令系统：内置命令 + 自定义命令 + 技能命令，支持中文别名
- 自定义标题栏（frameless 窗口）
- SQLite 本地数据持久化（会话、消息、MCP、Skills）
- Windows / macOS / Linux 跨平台支持

---

## 版本说明

- **Added** — 新功能
- **Changed** — 已有功能的变更
- **Deprecated** — 即将移除的功能
- **Removed** — 已移除的功能
- **Fixed** — Bug 修复
- **Security** — 安全相关
