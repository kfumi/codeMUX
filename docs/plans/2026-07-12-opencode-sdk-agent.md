# OpenCode SDK Agent 接入实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 执行本计划。所有步骤使用复选框跟踪。

**目标：** 通过 OpenCode 官方 TypeScript SDK 将 OpenCode 接入 CodeMUX，使其具备与 Codex/Claude 同级的独立 Server、持久会话、流式事件、原生权限审批、中断和跨平台运行时能力。

**架构：** 在现有 TypeScript sidecar 中新增 `OpenCodeSessionRuntime` 和事件转换层；sidecar 为每个 Agent 运行实例启动独立 OpenCode Server，并通过 SDK Client 创建或恢复 Session。Rust 继续复用现有 sidecar 命令和 Tauri 事件桥接，前端继续消费统一 Agent 事件，不直接依赖 OpenCode SDK 类型。

**技术栈：** Tauri 2、Rust、TypeScript、Node.js sidecar、OpenCode 官方 SDK `@opencode-ai/sdk`、Vitest、现有 Agent Store/assistant-ui。

---

## 文件边界

- 修改：`src-tauri/sidecar/package.json`，加入锁定的 OpenCode 官方 SDK 依赖。
- 创建：`src-tauri/sidecar/src/opencodeRuntime.ts`，负责独立 Server、Client、Session 生命周期、Prompt、恢复、中断和清理。
- 创建：`src-tauri/sidecar/src/opencodeEvents.ts`，负责 OpenCode SDK 事件到 CodeMUX Agent 事件的纯函数转换。
- 创建：`src-tauri/sidecar/src/opencodePermissions.ts`，负责原生 permission request 的状态跟踪与响应转换。
- 创建：`src-tauri/sidecar/src/opencodeRuntime.test.ts`，使用 SDK mock 测试 runtime 生命周期。
- 创建：`src-tauri/sidecar/src/opencodeEvents.test.ts`，测试文本、工具、状态、完成、错误和未知事件。
- 创建：`src-tauri/sidecar/src/opencodePermissions.test.ts`，测试批准、拒绝、超时、重复响应和取消。
- 修改：`src-tauri/sidecar/src/types.ts`，加入 OpenCode 启动参数、Session 映射和统一事件所需的字段。
- 修改：`src-tauri/sidecar/src/runtimeEvents.ts`，扩展 runtime flavor 与 OpenCode 用量/结果事件的公共构造逻辑。
- 修改：`src-tauri/sidecar/src/index.ts`，在运行时选择、命令分发、权限响应、重置和关闭流程中注册 OpenCode runtime。
- 修改：`src-tauri/src/agent_runtime/types.rs`，增加 `OpenCode` runtime kind 和映射测试。
- 修改：`src-tauri/src/agent_runtime/factory.rs`，将 `opencode` 映射到 OpenCode Rust runtime 壳层。
- 创建：`src-tauri/src/agent_runtime/opencode.rs`，实现 Rust 侧与 sidecar 命令契约一致的 runtime 壳层。
- 修改：`src-tauri/src/agent_runtime/mod.rs`，导出 OpenCode runtime 模块。
- 修改：`src-tauri/src/agent/commands.rs`，把 OpenCode 的 Agent Session 映射、启动参数和权限响应接入现有命令路径。
- 修改：`src-tauri/src/db/operations.rs` 及其相邻数据库迁移/初始化代码，保存 OpenCode `agent_session_id` 和 runtime 元数据；先复用现有 Agent Session 映射表，只有字段不足时才新增迁移。
- 修改：`src/types/agentRegistry.ts`，声明 OpenCode 的 resume、tools、MCP、context window 等实际能力。
- 修改：`src/lib/agentProvider.ts`、`src/lib/providerModels.ts` 或其对应测试，保证 OpenCode 使用 CodeMUX Provider/模型配置。
- 修改：`src/components/agent/AgentPermissionSelector.tsx` 或对应权限展示入口，确保未知 OpenCode 原生权限类型仍能显示原始描述并完成响应。
- 测试：上述修改对应的 `*.test.ts`、`*.test.tsx`、`src-tauri/src/agent_runtime/*` Rust 单元测试。

## Task 1: 固定 SDK 版本与 runtime 契约

**Files:**
- Modify: `src-tauri/sidecar/package.json`
- Modify: `src-tauri/sidecar/src/types.ts`
- Modify: `src-tauri/sidecar/src/runtimeEvents.ts`
- Test: `src-tauri/sidecar/src/types.test.ts`（如文件不存在则创建）

- [ ] **Step 1: 记录官方 SDK 版本并安装依赖**

在 sidecar 目录执行：

```powershell
npm view @opencode-ai/sdk version
npm install @opencode-ai/sdk@1.17.18
```

预期：`src-tauri/sidecar/package.json` 与 `package-lock.json` 出现 `@opencode-ai/sdk`，安装命令成功。

- [ ] **Step 2: 先写 runtime flavor 失败测试**

新增测试，明确 `getRuntimeFlavor('opencode')` 返回 `opencode`，并定义 sidecar 启动配置中必须包含 `cwd`、CodeMUX `sessionId`、可选 OpenCode `sessionId`、Provider、模型和凭据来源。

```ts
it('识别 OpenCode runtime', () => {
  expect(getRuntimeFlavor('opencode')).toBe('opencode');
});
```

- [ ] **Step 3: 扩展类型并运行定向测试**

将 `RuntimeFlavor` 扩展为 `'claude' | 'codex' | 'opencode'`，新增 `OpenCodeSessionConfig` 与 `OpenCodeSessionMapping`，并让测试通过：

```powershell
cd src-tauri/sidecar
npx vitest run src/types.test.ts
```

预期：新增测试 PASS，现有 sidecar 类型测试不回归。

- [ ] **Step 4: 提交契约变更**

```powershell
git add src-tauri/sidecar/package.json src-tauri/sidecar/package-lock.json src-tauri/sidecar/src/types.ts src-tauri/sidecar/src/runtimeEvents.ts src-tauri/sidecar/src/types.test.ts
git commit -m "feat(sidecar): add OpenCode runtime contract"
```

## Task 2: 实现 OpenCode Server/Session 生命周期

**Files:**
- Create: `src-tauri/sidecar/src/opencodeRuntime.ts`
- Create: `src-tauri/sidecar/src/opencodeRuntime.test.ts`
- Modify: `src-tauri/sidecar/src/types.ts`

- [ ] **Step 1: 写 SDK mock 与失败测试**

在测试中 mock `@opencode-ai/sdk` 的 Server/Client 工厂，覆盖以下行为：启动独立 Server、创建新 Session、使用已有 `sessionId` 恢复、发送 Prompt、调用中断、幂等 `dispose`。每个 mock 调用都通过 `vi.fn()` 记录参数。

```ts
it('启动独立 Server 并恢复已有 OpenCode session', async () => {
  const runtime = new OpenCodeSessionRuntime(config, sdk);
  await runtime.start();
  expect(sdk.createOpencode).toHaveBeenCalledWith(expect.objectContaining({ cwd: config.cwd }));
  expect(sdk.client.session.get).toHaveBeenCalledWith({ path: { id: config.agentSessionId } });
});
```

- [ ] **Step 2: 实现最小 runtime 类**

先定义 SDK 隔离端口和事件输出端口，避免测试与业务代码直接依赖 SDK 模块结构：

```ts
type OpenCodeSdkPort = {
  createOpencode(config: { cwd: string; env?: Record<string, string> }): Promise<{
    client: OpenCodeClientPort;
    close(): Promise<void>;
  }>;
};

type RuntimeEventEmitter = (event: Record<string, unknown>) => void;
```

再实现以下稳定接口，内部保存 `server`、`client`、CodeMUX `sessionId`、OpenCode `sessionId`、事件取消函数和当前请求状态：

```ts
export class OpenCodeSessionRuntime {
  constructor(config: OpenCodeSessionConfig, sdk: OpenCodeSdkPort, emitEvent: RuntimeEventEmitter);
  start(): Promise<OpenCodeSessionMapping>;
  sendInput(prompt: string, inputPayload?: AgentInputPayload): Promise<void>;
  interrupt(): Promise<void>;
  resetSession(): Promise<void>;
  shutdown(): Promise<void>;
  dispose(): Promise<void>;
  respondToPermission(requestId: string, response: unknown): Promise<void>;
}
```

`start()` 必须先启动独立 Server，再创建/恢复 Session；恢复失败返回明确错误，不自动创建新 Session。`dispose()` 使用一次性状态保护，按取消订阅、清理权限、关闭 Session、停止 Server 的顺序执行。

- [ ] **Step 3: 运行 runtime 定向测试**

```powershell
cd src-tauri/sidecar
npx vitest run src/opencodeRuntime.test.ts
```

预期：启动、恢复、Prompt、中断、恢复失败和幂等清理测试 PASS。

- [ ] **Step 4: 提交 runtime 生命周期**

```powershell
git add src-tauri/sidecar/src/opencodeRuntime.ts src-tauri/sidecar/src/opencodeRuntime.test.ts src-tauri/sidecar/src/types.ts
git commit -m "feat(sidecar): add OpenCode session runtime"
```

## Task 3: 实现消息、工具和运行事件转换

**Files:**
- Create: `src-tauri/sidecar/src/opencodeEvents.ts`
- Create: `src-tauri/sidecar/src/opencodeEvents.test.ts`
- Modify: `src-tauri/sidecar/src/runtimeEvents.ts`
- Modify: `src-tauri/sidecar/src/opencodeRuntime.ts`

- [ ] **Step 1: 写事件转换失败测试**

为每种 SDK 事件构造最小 fixture，并断言输出符合现有事件形状：文本增量产生 assistant 内容，工具开始/完成产生 tool use/tool result，任务完成产生 result，断线和 SDK 错误产生 sidecar error；重复事件不重复发出，未知事件只产生诊断事件。

```ts
it('将 OpenCode 文本增量转换为统一 assistant 事件', () => {
  expect(toCodeMuxEvent(textDelta, context)).toEqual(expect.objectContaining({
    type: 'assistant',
    session_id: context.sessionId,
  }));
});
```

- [ ] **Step 2: 实现纯转换函数**

实现 `toCodeMuxEvent(event, context)` 和必要的窄类型读取函数。转换函数不得导入 React、Zustand 或 Tauri API；所有事件补齐 `agentId`、CodeMUX `sessionId`、OpenCode `sessionId` 和单调递增序号。

处理规则固定为：

- 文本增量追加到 assistant 文本流。
- 工具开始保留工具名和参数。
- 工具结果保留原始输出与错误标识。
- 完成事件计算本轮用量并产生统一 result。
- 未知事件返回可记录但不终止流的诊断结果。

- [ ] **Step 3: 接入 runtime 事件订阅**

在 `OpenCodeSessionRuntime.start()` 中建立 SDK 事件订阅，在每个事件上调用 `toCodeMuxEvent` 并通过现有 `emit` 输出；在 `sendInput()` 中只负责调用 SDK，不把 SDK 对象泄漏给上层。

- [ ] **Step 4: 运行事件测试与 sidecar 构建**

```powershell
cd src-tauri/sidecar
npx vitest run src/opencodeEvents.test.ts src/opencodeRuntime.test.ts
npm run build
```

预期：定向测试 PASS，TypeScript 编译成功。

- [ ] **Step 5: 提交事件转换**

```powershell
git add src-tauri/sidecar/src/opencodeEvents.ts src-tauri/sidecar/src/opencodeEvents.test.ts src-tauri/sidecar/src/runtimeEvents.ts src-tauri/sidecar/src/opencodeRuntime.ts
git commit -m "feat(sidecar): normalize OpenCode events"
```

## Task 4: 接入原生权限桥接

**Files:**
- Create: `src-tauri/sidecar/src/opencodePermissions.ts`
- Create: `src-tauri/sidecar/src/opencodePermissions.test.ts`
- Modify: `src-tauri/sidecar/src/opencodeRuntime.ts`
- Modify: `src-tauri/sidecar/src/types.ts`

- [ ] **Step 1: 写权限状态失败测试**

覆盖登记请求、批准、拒绝、超时、重复响应、错误 Session、请求已销毁和 Agent 中断时批量取消。

```ts
it('拒绝重复响应并保留原始 requestId', async () => {
  const pending = new OpenCodePermissionRegistry();
  pending.add({ requestId: 'r1', sessionId: 's1', payload: rawRequest });
  await pending.respond('r1', { approved: true });
  await expect(pending.respond('r1', { approved: false })).rejects.toThrow('permission request is no longer pending');
});
```

- [ ] **Step 2: 实现权限登记与响应注册表**

实现 `OpenCodePermissionRegistry`，保存 `requestId`、OpenCode `sessionId`、CodeMUX `sessionId`、原始权限类型、描述和创建时间。`respond()` 只允许当前 pending 请求响应一次；`cancelAll()` 清理未决请求并返回可发送给 SDK 的取消/拒绝结果。

- [ ] **Step 3: 将权限事件接入 runtime**

OpenCode permission request 到达时，先登记再发送统一 permission 事件；`respondToPermission()` 校验会话和 pending 状态后调用 SDK 原生响应接口。`interrupt()`、`resetSession()`、`dispose()` 必须调用 `cancelAll()`。

- [ ] **Step 4: 运行权限测试**

```powershell
cd src-tauri/sidecar
npx vitest run src/opencodePermissions.test.ts src/opencodeRuntime.test.ts
```

预期：权限测试全部 PASS，重复响应和过期请求不会触发 SDK 二次调用。

- [ ] **Step 5: 提交权限桥接**

```powershell
git add src-tauri/sidecar/src/opencodePermissions.ts src-tauri/sidecar/src/opencodePermissions.test.ts src-tauri/sidecar/src/opencodeRuntime.ts src-tauri/sidecar/src/types.ts
git commit -m "feat(sidecar): bridge OpenCode permissions"
```

## Task 5: 注册 sidecar 命令分发与生命周期

**Files:**
- Modify: `src-tauri/sidecar/src/index.ts`
- Modify: `src-tauri/sidecar/src/types.ts`
- Modify: `src-tauri/sidecar/src/index.test.ts`（如文件不存在则创建）

- [ ] **Step 1: 写命令分发失败测试**

验证 `ensure_session`、`update_permissions`、`send_input`、`reset_session`、`interrupt`、`tool_response`、`shutdown` 在 `agentKind === 'opencode'` 时都路由到 OpenCode runtime；Codex/Claude 路径的已有断言保持不变。

```ts
it('将 OpenCode ensure_session 路由到 OpenCode runtime', async () => {
  await dispatch({ type: 'ensure_session', agentKind: 'opencode', cwd: 'D:\\workspace' });
  expect(opencodeRuntime.start).toHaveBeenCalled();
});
```

- [ ] **Step 2: 实现 runtime 注册与命令分支**

在 sidecar 主入口维护 OpenCode runtime 实例，并扩展 `getRuntimeFlavor()`。每次 `ensure_session` 替换工作区或会话时先幂等清理旧实例；`shutdown` 无论当前 Agent 类型都清理 OpenCode 实例；异常统一输出 `sidecar_error`，中断产生的 abort 不当作错误。

- [ ] **Step 3: 运行 sidecar 回归测试**

```powershell
cd src-tauri/sidecar
npx vitest run
npm run build
```

预期：全部 sidecar 测试 PASS，构建成功。

- [ ] **Step 4: 提交命令分发**

```powershell
git add src-tauri/sidecar/src/index.ts src-tauri/sidecar/src/types.ts src-tauri/sidecar/src/index.test.ts
git commit -m "feat(sidecar): route OpenCode commands"
```

## Task 6: 接入 Rust runtime 工厂与 Session 映射

**Files:**
- Modify: `src-tauri/src/agent_runtime/types.rs`
- Modify: `src-tauri/src/agent_runtime/factory.rs`
- Create: `src-tauri/src/agent_runtime/opencode.rs`
- Modify: `src-tauri/src/agent_runtime/mod.rs`
- Modify: `src-tauri/src/agent/commands.rs`
- Modify: `src-tauri/src/db/operations.rs` 及对应迁移文件

- [ ] **Step 1: 写 Rust 映射失败测试**

增加 `AgentRuntimeKind::OpenCode`、`as_str()`、`from_agent_kind("opencode")` 和 `runtime_for_agent_kind("opencode")` 测试；断言未知 Agent 仍保持当前 Claude fallback 行为。

```rust
#[test]
fn resolves_opencode_runtime_variant() {
    assert_eq!(AgentRuntimeKind::from_agent_kind("opencode"), AgentRuntimeKind::OpenCode);
    assert_eq!(AgentRuntimeKind::OpenCode.as_str(), "opencode");
    assert_eq!(runtime_for_agent_kind("opencode").kind_name(), "opencode");
}
```

- [ ] **Step 2: 实现 Rust runtime 壳层**

在 `opencode.rs` 实现 `AgentRuntime`，使用与现有 runtime 相同的 sidecar 命令通道调用 `ensure_session`、`send_input`、`interrupt`、`reset_session` 和 `shutdown`。Rust 不实现 OpenCode SDK 协议，只传递经过校验的配置和统一事件。

- [ ] **Step 3: 复用现有 Agent Session 映射**

检查 `operations::get_agent_session_mapping` 使用的表和字段；若已有 `agent_kind + agent_session_id` 能表达 OpenCode Session，则只补充命令参数映射。若缺少 runtime 版本/恢复状态字段，新增一次 SQLite 迁移，并为旧记录提供空值默认。

- [ ] **Step 4: 将命令路径纳入 OpenCode**

在 `agent/commands.rs` 的 AgentKind 分支中显式处理 `Opencode`：读取 CodeMUX Provider、模型、工作区和已有 Agent Session；发送 `agentKind: "opencode"`；权限响应按 OpenCode `requestId` 转发；Session 重置和应用退出走统一清理路径。

- [ ] **Step 5: 运行 Rust 定向验证**

```powershell
cd src-tauri
cargo test agent_runtime
cargo fmt --all -- --check
cargo check --all-targets --all-features
```

预期：runtime 映射测试 PASS，格式检查和编译检查成功。

- [ ] **Step 6: 提交 Rust 桥接**

```powershell
git add src-tauri/src/agent_runtime src-tauri/src/agent/commands.rs src-tauri/src/db/operations.rs src-tauri/src/db
git commit -m "feat(agent): bridge OpenCode runtime in Rust"
```

## Task 7: 接入 Provider、模型与 Agent 能力

**Files:**
- Modify: `src/types/agentRegistry.ts`
- Modify: `src/lib/agentProvider.ts`
- Modify: `src/lib/providerModels.ts`
- Modify: `src/components/agent/AgentPermissionSelector.tsx`（仅在现有组件无法显示原生类型时修改）
- Test: 对应 `*.test.ts` 与 `*.test.tsx`

- [ ] **Step 1: 写前端能力与配置失败测试**

验证 OpenCode registry 定义包含 `supports_resume`、`supports_tools`、`supports_mcp`、`supports_context_window`，Provider 配置转换不会把 API key 写入日志，模型选择结果能传给 Agent 启动参数。

- [ ] **Step 2: 更新 OpenCode Agent 能力**

将现有 OpenCode 占位定义改成完整 Agent 定义，保持标签、图标和 Agent kind 不变；只声明已在 runtime 与 UI 验证的能力，未实现能力不加入 registry。

- [ ] **Step 3: 复用现有 Provider/模型选择路径**

让 OpenCode 使用与 Claude/Codex 相同的 Provider 读取和模型选择入口；将 API key、base URL、Provider 名称和模型转换为 sidecar `ensure_session` 参数，日志只输出脱敏后的 Provider 与模型。

- [ ] **Step 4: 处理未知原生权限展示**

若现有权限卡片要求固定枚举，增加一个保留原始类型和描述的 fallback 分支；批准/拒绝仍调用统一 `tool_response`/权限响应命令，不新增 OpenCode 专属审批页面。

- [ ] **Step 5: 运行前端定向测试**

```powershell
npx vitest run src/agentRegistry.test.ts src/lib/agentProvider.test.ts src/lib/providerModels.test.ts src/components/agent/AgentPermissionSelector.test.tsx
npm run build
```

预期：定向测试和前端构建成功。

- [ ] **Step 6: 提交前端配置接入**

```powershell
git add src/types/agentRegistry.ts src/lib/agentProvider.ts src/lib/providerModels.ts src/components/agent/AgentPermissionSelector.tsx src/**/*.test.ts src/**/*.test.tsx
git commit -m "feat(ui): expose OpenCode agent capabilities"
```

## Task 8: 运行时分发与跨平台诊断

**Files:**
- Modify: `src-tauri/sidecar/src/opencodeRuntime.ts`
- Modify: `src-tauri/tauri.conf.json` 或现有 sidecar 打包配置
- Modify: `scripts/prepare-release.mjs`、`scripts/release-local.mjs`（仅在现有发布流程需要扩展时）
- Test: 新增 runtime 可执行性和路径诊断测试

- [ ] **Step 1: 写运行时诊断测试**

覆盖 runtime 缺失、平台架构不匹配、工作区不可访问、启动超时和正常启动；断言错误码稳定且不包含 API key、完整环境变量或敏感路径片段。

- [ ] **Step 2: 实现打包资源定位与启动前检查**

使用 Tauri sidecar 既有资源定位方式查找平台相关 OpenCode runtime，启动前验证文件存在、可执行、版本兼容和工作目录可访问。诊断错误映射为“运行时不可用”“启动失败”“工作区不可访问”等稳定错误。

- [ ] **Step 3: 实现跨平台退出清理**

在 Windows 使用现有进程树清理方式，在 macOS/Linux 使用现有信号与子进程清理方式；所有平台都保证 `shutdown` 和异常退出最终调用 `dispose`。

- [ ] **Step 4: 运行分发与 Rust 检查**

```powershell
cd src-tauri/sidecar
npx vitest run src/opencodeRuntime.test.ts
npm run build
cd ..
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
```

预期：运行时诊断测试、sidecar 构建、Rust 格式检查和 Clippy 成功。

- [ ] **Step 5: 提交分发支持**

```powershell
git add src-tauri/sidecar/src/opencodeRuntime.ts src-tauri/tauri.conf.json scripts
git commit -m "feat(release): bundle OpenCode runtime diagnostics"
```

## Task 9: 全量验证与验收

**Files:**
- Test: 所有本次新增和修改的测试文件
- Verify: `package-lock.json`、`src-tauri/sidecar/package-lock.json`、Tauri 打包配置和 Git 状态

- [ ] **Step 1: 运行根目录前端测试和构建**

```powershell
npx vitest run
npm run build
```

预期：根目录测试和构建成功。

- [ ] **Step 2: 运行 sidecar 全量测试和构建**

```powershell
cd src-tauri/sidecar
npx vitest run
npm run build
```

预期：sidecar 全量测试和构建成功。

- [ ] **Step 3: 运行 Rust 全量验证**

```powershell
cd src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo check --all-targets --all-features
```

预期：格式、Clippy 和编译检查成功。

- [ ] **Step 4: 执行手动验收**

在开发环境验证：选择 OpenCode、指定工作区和模型、发送任务、观察流式文本和工具事件、批准/拒绝权限、中断任务、关闭并重新打开应用恢复同一 Session，并确认启动失败/恢复失败均有明确错误且无残留进程。

- [ ] **Step 5: 检查变更范围并提交最终集成**

```powershell
git status --short
git diff --check
git log -12 --oneline
```

预期：没有生成凭据、日志或机器特定配置；没有未解释的修改；所有测试结果记录在最终交付说明中。

```powershell
git add .
git commit -m "feat(agent): integrate OpenCode official SDK"
```