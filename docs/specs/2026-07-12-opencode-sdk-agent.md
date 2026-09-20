# OpenCode 官方 SDK Agent 接入设计

## 1. 背景与目标

CodeMUX 已具备 Codex 与 Claude Agent 的运行时、统一事件模型、会话管理、权限审批和 assistant-ui 展示能力。项目中已经存在 OpenCode 的 Agent 枚举、品牌图标，以及 MCP/Skills 配置适配器，但尚未接入 OpenCode 的实际执行链。

本设计将 OpenCode 作为与 Codex、Claude 同级的完整 Agent，通过 OpenCode 官方 TypeScript SDK 接入现有 TypeScript sidecar。目标是在不改变其他 Agent 行为的前提下支持：

- 在 CodeMUX 中选择并启动 OpenCode Agent。
- 使用当前 CodeMUX Provider 配置和模型选择。
- 流式展示回答、工具调用、工具结果和运行状态。
- 展示并转发 OpenCode 原生权限请求。
- 中断任务并可靠清理进程。
- 持久化 OpenCode Session，支持应用重启后恢复上下文。
- 在发行包中携带 OpenCode 官方运行时，用户无需单独安装。

## 2. 范围与非目标

### 2.1 本次范围

- 新增 OpenCode sidecar runtime 适配器。
- 使用官方 SDK 启动独立 OpenCode Server，并通过 SDK Client 操作 Session。
- 将 OpenCode 事件转换为 CodeMUX 现有 Agent 事件。
- 复用现有 Agent 选择、模型选择、消息流、工具卡片、权限卡片和会话恢复能力。
- 将 CodeMUX Provider 配置注入 OpenCode runtime。
- 保存并恢复 CodeMUX Session 与 OpenCode `sessionId` 的一对一关系。
- 完成运行时启停、重连、中断、权限响应和异常清理。
- 为 runtime、事件转换、权限桥接、会话恢复和前端回归增加测试。

### 2.2 非目标

- 不复制 OpenCode 专属 UI 或配置编辑器。
- 不强行把 OpenCode 原生权限类型改写成另一套语义；CodeMUX 只负责展示和转发。
- 不修改 Codex 或 Claude runtime 的既有行为。
- 不实现连接用户外部 OpenCode Server 的模式。
- 不在首版中通过临时 Session 替代持久 Session。
- 不把 OpenCode 内部完整历史复制到 CodeMUX 数据库，只保存恢复所需标识和元数据。

## 3. 现有项目边界

CodeMUX 是 Tauri 2 桌面应用，包含 React/Vite 前端、Rust 后端和 TypeScript sidecar。现有 Agent 相关边界如下：

- `src-tauri/sidecar/src/codexRuntime.ts` 与 `claudeRuntime.ts` 承担具体 Agent 运行时。
- `src-tauri/sidecar/src/runtimeEvents.ts`、`types.ts` 和相关转换模块定义 sidecar 事件与输入契约。
- `src-tauri/src/agent_runtime/` 提供 Rust 侧运行时抽象和工厂入口。
- `src-tauri/src/agent/commands.rs` 负责 Agent 命令、事件转发和权限交互。
- `src/stores/agentStore.ts` 管理前端 Agent 会话状态。
- `src/components/agent/` 与 `src/components/agent/assistant-ui/` 展示消息、工具调用、权限请求和运行状态。
- OpenCode 已出现在 Agent 类型、品牌图标、MCP 适配器和 Skills 适配器中，但 sidecar 依赖目前仅包含 Codex 与 Claude SDK。

OpenCode 接入应新增适配器和必要的类型/配置扩展，不应另起一套前端通信协议。

## 4. 方案选择

### 4.1 方案 A：sidecar 原生 SDK 适配器（采用）

在 TypeScript sidecar 中新增 `OpenCodeRuntime`，由官方 SDK 启动独立 Server，并通过 Client 创建或恢复 Session。Rust 继续负责 sidecar 生命周期、Tauri 命令和事件转发，前端继续消费统一 Agent 事件。

优点：与现有 Codex/Claude sidecar 架构一致，官方 SDK 类型和事件能力可以直接使用，事件归一化、权限桥接和测试边界清晰，每个运行实例可以隔离故障。

代价：需要处理官方运行时的跨平台打包，实现 SDK 事件适配层，并验证不同平台的进程退出和中断语义。

### 4.2 方案 B：Rust 直接封装 OpenCode 进程

由 Rust 启动和管理 OpenCode Server，再通过 Tauri 事件桥接前端。该方案进程生命周期集中在 Rust，但官方 SDK 主要在 TypeScript 侧使用，Rust 需要额外重建协议适配，和现有 sidecar 结构不一致，因此不采用。

### 4.3 方案 C：连接外部 OpenCode Server

CodeMUX 只连接用户本机或远程已有 OpenCode Server。该方案安装包更小，但依赖外部安装、端口和版本状态，不符合“随 CodeMUX 分发官方运行时”和“每个 Agent 实例独立隔离”的目标，因此不纳入首版。

## 5. 架构与生命周期

### 5.1 运行时结构

新增 `OpenCodeRuntime`，放在 `src-tauri/sidecar/src/`，与现有 `codexRuntime.ts`、`claudeRuntime.ts` 并列。它对外实现现有 Agent runtime 所需的 `start`、`sendMessage`、`interrupt`、`respondToPermission`、`resume`、`dispose` 接口。

Rust 层继续负责 sidecar 启动、Agent 命令、Tauri 事件和权限响应；前端继续使用 `agentStore` 与 assistant-ui。

### 5.2 启动流程

每个 CodeMUX Agent 运行实例启动时：

1. sidecar 根据工作区、Provider、模型和运行时配置调用官方 SDK。
2. 官方 SDK 启动一个独立 OpenCode Server，并建立对应 Client。
3. runtime 创建或恢复当前 CodeMUX 会话对应的 OpenCode `sessionId`。
4. runtime 建立事件订阅并启动事件归一化。
5. runtime 向 Rust 报告就绪状态，允许前端发送任务。

### 5.3 关闭流程

消息完成、用户中断、会话销毁或 sidecar 退出时，runtime 按顺序停止接收输入、取消事件订阅、处理未决权限、关闭 Session、停止 Server、清理资源并报告最终状态。所有退出路径必须幂等，重复调用 `dispose` 不得产生异常或残留进程。

## 6. 会话与持久化

CodeMUX Session 与 OpenCode Session 采用一对一持久映射。CodeMUX 数据库保存 CodeMUX `sessionId`、OpenCode `sessionId`、Agent 类型、runtime 标识、工作区路径、最近使用的 Provider 和模型、SDK/runtime 版本元数据，以及最近一次运行状态和恢复错误信息。

数据库不复制 OpenCode 的完整内部消息历史。应用重启或 sidecar 重建后，runtime 读取持久 `sessionId` 并尝试恢复原 Session。恢复失败时不得静默创建新 Session，前端应提示用户选择重试恢复或新建上下文。

## 7. 数据流与事件归一化

### 7.1 数据流

```text
前端输入 → Rust Agent 命令 → sidecar OpenCodeRuntime
→ OpenCode Server/SDK → SDK 事件订阅 → sidecar 事件归一化
→ Rust/Tauri 事件 → agentStore → assistant-ui
```

### 7.2 对外接口

OpenCode runtime 不向前端暴露 OpenCode SDK 类型，只暴露 CodeMUX 现有 Agent 输入和事件类型。所有事件至少携带 `agentId`、CodeMUX `sessionId`、OpenCode `sessionId` 和单调递增事件序号，用于多会话并发时的排序、去重和断线恢复。

### 7.3 事件分类

- **消息事件**：文本增量、消息完成、状态更新，转换为现有 assistant 文本流和完成事件。
- **工具事件**：工具开始、参数、输出、错误，转换为现有 ToolCall/ToolResult 事件。
- **交互事件**：permission request 转为现有权限请求事件，并保留原始权限类型、目标资源、描述和扩展元数据。
- **运行事件**：Server 启动失败、Session 不存在、连接断开、用户中断、任务完成和用量统计，统一转换为状态、错误或完成事件。

事件转换层必须独立于 UI，并对重复、乱序、未知事件保持可控行为；未知事件记录诊断信息但不应导致整个事件流崩溃。

## 8. Provider、模型与运行时配置

OpenCode runtime 使用 CodeMUX 现有 Provider 配置和模型选择，避免用户维护两套凭据。

- Provider、模型、工作区、代理设置和运行时路径分别传入，避免把 CodeMUX 私有配置文件直接写成 OpenCode 全量配置。
- 启动时将必要配置转换为 OpenCode SDK 支持的参数或环境变量。
- 默认不覆盖工作区中已有的 `opencode.json`，防止破坏用户配置。
- 仅通过受控扩展点提供 OpenCode 专属配置。
- 记录实际使用的 Provider、模型和 SDK/runtime 版本，便于会话恢复和诊断。

配置缺失或无法转换时，runtime 应在启动阶段返回明确的配置错误，而不是等到首次发送消息时失败。

## 9. 权限处理

首版保留 OpenCode 原生权限语义，CodeMUX 负责展示、审批和响应转发：

1. OpenCode 发出 permission request。
2. runtime 将请求转换为 CodeMUX 权限事件，并保存原始 `requestId` 与会话关联。
3. 前端使用现有权限审批 UI 展示请求。
4. 用户批准、拒绝或超时后，Rust 将响应发送回 sidecar。
5. runtime 使用原始 `requestId` 将响应返回给 OpenCode Session。

重复响应、过期请求、Session 已销毁、请求会话不匹配等情况必须返回可恢复错误。Agent 被中断时，所有未决权限请求自动取消或拒绝，避免悬挂请求。

## 10. 错误、重连与清理

错误应区分运行时缺失、SDK/Server 启动失败、Provider 或模型配置无效、工作区不可访问、端口或 Server 资源冲突、Session 不存在或恢复失败、事件连接断开、权限响应失败和用户主动中断。

事件连接断开后，runtime 先进行有限次数重连。无法恢复时保留 CodeMUX Session 和 OpenCode `sessionId`，允许用户手动重试。

用户中断时优先调用 SDK 的中断能力；超时后再终止当前 Server，最后才执行强制进程清理。Server 启动失败、连接失败和退出清理都必须避免留下孤儿进程。

## 11. 分发与跨平台兼容性

OpenCode 官方 runtime 作为 sidecar 的平台相关依赖随 CodeMUX 分发。runtime 启动前检查可执行文件、平台和架构、版本兼容性、工作目录和权限。

Windows、macOS、Linux 均需验证 Server 启停、中断信号、强制终止、路径编码、特殊字符、工作区读写权限和应用退出时的进程清理。

如果发行流水线暂时不能携带 OpenCode runtime，必须报告明确的“运行时不可用”诊断，不回退到非官方协议实现。

## 12. 测试策略

### 12.1 sidecar 单元测试

覆盖 Server 启动、就绪和失败路径；Session 创建、持久化标识和恢复；Prompt 发送和消息完成；用户中断与超时清理；以及 `dispose` 幂等性。

### 12.2 事件转换测试

覆盖文本增量、工具调用、工具结果、权限请求、完成、错误、断线、重复事件、乱序事件和未知事件。

### 12.3 权限桥接测试

覆盖批准、拒绝、超时、重复响应、错误会话、Session 销毁后的响应，以及中断时未决请求的取消。

### 12.4 集成与前端回归测试

- 使用可控 SDK/Server mock 验证 sidecar 生命周期，不依赖开发机真实 OpenCode 安装。
- 验证 Agent 选择器和模型选择器能选择 OpenCode。
- 验证消息流、工具卡片、权限卡片、中断按钮和错误提示复用现有组件。
- 验证应用重启后会话恢复，恢复失败时不会静默创建新上下文。

## 13. 验收标准

完成后，用户应可以在 CodeMUX 中选择 OpenCode Agent，指定工作区和模型并发送任务，看到流式回答、工具调用和工具结果，完成 OpenCode 原生权限请求的批准或拒绝，中断任务且无残留运行进程，关闭并重新打开应用后继续同一个 OpenCode Session，并在运行时、配置、连接或恢复失败时看到明确错误。

Codex 和 Claude 的既有功能、协议和测试不得因本次接入发生回归。

## 14. 后续实施拆分建议

实施计划应按以下边界拆分：

1. 梳理并固定现有 Agent runtime、事件和数据库接口。
2. 增加 OpenCode 官方 SDK 依赖和 runtime 骨架。
3. 实现独立 Server 生命周期与 Session 创建/恢复。
4. 实现消息、工具、状态和用量事件归一化。
5. 实现原生权限请求桥接、中断和清理。
6. 接入 Agent 工厂、前端选择和模型配置。
7. 增加 sidecar、Rust 桥接和前端回归测试。
8. 验证跨平台 runtime 分发和失败诊断。

该拆分保持模块职责单一：runtime 负责 SDK 生命周期，转换层负责协议适配，Rust 负责进程和命令桥接，前端负责展示和用户交互。