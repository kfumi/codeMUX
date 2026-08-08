# CodeMUX 对话 Fork 分支功能需求与实现记录

## 1. 文档目的

本文档用于归档 CodeMUX 对话 Fork 分支功能的产品需求、技术方案、实现过程、问题排查和验证结果，便于后续维护、回归测试和继续扩展。

实现日期：2026-08-08

## 2. 最终产品需求

### 2.1 核心目标

用户可以从任意一条已经完成的 AI assistant 消息创建独立的对话分支。

点击消息底部的 Fork 按钮后：

1. 立即创建 provider 子会话。
2. 创建对应的 CodeMUX 子 session。
3. 子 session 继承父 session 截止到所选 assistant 消息的完整对话历史。
4. 自动切换到新创建的子 session。
5. 后续在子 session 中继续对话，不影响父 session。

### 2.2 Fork 点

- 只能从已完成的 assistant 消息 Fork。
- 支持从任意历史 assistant 消息 Fork，不局限于最新消息。
- 选中的 assistant 消息本身必须包含在子会话历史中。
- 如果选择的是最新 assistant 消息，子会话复制完整的当前 provider 历史。

### 2.3 会话和工作区语义

- 子 session 与父 session 建立 lineage 关系。
- 子 session 拥有独立的 provider session/thread。
- 子 session 后续消息独立运行。
- 初版不创建 Git 分支。
- 父子 session 共享当前工作目录。
- 文件工作区隔离不属于本需求范围。

### 2.4 UI

- assistant 消息底部显示 Fork 操作。
- Fork 图标使用 `GitFork`。
- Fork 期间显示加载状态，避免重复点击。
- Fork 成功后自动切换到子 session。
- Fork 失败时由 session store 保留错误信息。

## 3. 整体架构

CodeMUX 使用 Tauri 2 架构：

```text
React assistant-ui
    ↓
Zustand sessionStore / agentStore
    ↓
Tauri command
    ↓
Rust agent commands
    ↓
TypeScript sidecar
    ↓
Provider SDK / app-server
```

Fork 复用统一的 provider session 结果事件：

```text
UI 选择 assistant 消息
    ↓
传递 CodeMUX fork_event_id 和 provider message/turn 标识
    ↓
Rust 向 sidecar 发送 fork_session
    ↓
sidecar 调用 provider Fork API
    ↓
返回新的 provider session/thread ID
    ↓
Rust 原子创建 CodeMUX 子 session、mapping 和 lineage
    ↓
前端切换 activeSessionId
```

## 4. 数据库设计

### 4.1 Session lineage

新增 `session_lineage` 表：

- `child_session_id`：子 CodeMUX session ID。
- `parent_session_id`：父 CodeMUX session ID。
- `fork_event_id`：触发 Fork 的 CodeMUX 事件 ID。
- `fork_provider_message_id`：provider 原生消息 ID。
- `created_at`：创建时间。

同时增加 `parent_session_id` 查询支持，使前端 Session 类型可以展示父子关系。

### 4.2 原子创建

`create_forked_session` 负责在一次数据库事务中完成：

1. 创建子 CodeMUX session。
2. 创建子 session 与 provider session 的 mapping。
3. 写入 `session_lineage`。
4. 保存 Fork 目标信息。

如果 provider Fork 成功但数据库写入失败，应清理 provider 子会话或临时文件，避免产生孤儿会话。

## 5. Claude 实现

### 5.1 Provider 能力

Claude SDK 支持通过 session 继续和 Fork，但任意历史消息 Fork 需要先准备一个截断后的历史。

### 5.2 实现流程

1. Rust 根据目标 assistant 消息定位 Claude JSONL。
2. 读取并解析历史事件。
3. 找到目标已完成 assistant turn 的结束位置。
4. 复制并截断到目标消息。
5. 替换临时历史中的 session ID。
6. 使用临时 session ID 调用 Claude SDK Fork。
7. 将新 provider session ID 写入 CodeMUX 子 session。
8. 清理临时 Claude 历史文件。

### 5.3 完成判定

Claude 历史中可能没有显式 `turn_finished` 事件，因此 assistant 消息的终止 `stop_reason` 也会被视为完成信号，包括：

- `end_turn`
- `stop_sequence`
- `max_tokens`
- `refusal`

### 5.4 关键问题

早期实现使用 CodeMUX 生成的 `event_id` 作为 Fork 目标，导致前端和 Claude provider 使用的消息 ID 不一致。

最终统一使用：

```text
provider_message_id ?? event_id
```

前端优先传递 Claude 原生 assistant message ID。

## 6. Codex 实现

### 6.1 Provider 能力

Codex TypeScript SDK 没有直接暴露 Fork API，但 Codex app-server 支持：

```text
thread/fork
```

该方法可以接收：

- `threadId`
- 可选的 `lastTurnId`

### 6.2 实现流程

1. sidecar 启动独立 Codex app-server 子进程。
2. 发送 `initialize` 和 `initialized`。
3. 如果已有真实 provider turn ID，直接调用 `thread/fork`。
4. 如果实时 SDK 事件没有暴露 turn ID，则传递前端 turn ordinal。
5. 使用 `thread/turns/list` 查询对应的真实 provider turn ID。
6. 将真实 turn ID 作为 `lastTurnId` 调用 `thread/fork`。
7. 返回新的 Codex thread ID。

### 6.3 实时 turn ID 问题

`@openai/codex-sdk@0.146.1` 的实时 `turn.started` 事件没有可靠的 `turn_id`。

此前误把类似 `item_0` 的 item ID 当成 turn ID，导致：

```text
Codex Fork target is missing its completed provider turn ID
```

最终方案：

- 前端传递 CodeMUX turn ordinal。
- sidecar 调用 Codex app-server 的 `thread/turns/list`。
- `initialize` 时启用：

```json
{
  "capabilities": {
    "experimentalApi": true
  }
}
```

### 6.4 最新 turn

如果 Fork 目标没有 turn ID 和 turn ordinal，Codex sidecar 不传 `lastTurnId`，由 app-server Fork 当前完整 thread。

## 7. OpenCode 实现

### 7.1 Provider 能力确认

检查托管 OpenCode Runtime `1.18.14` 后确认，官方 SDK 已提供：

```text
session.fork
```

请求支持：

- source session ID
- `messageID`

因此不需要直接复制 OpenCode SQLite，也不需要修改 OpenCode 二进制。

### 7.2 OpenCode 原生消息 ID

OpenCode assistant 消息的原生 ID 来自事件中的：

```text
part.messageID
```

sidecar 在生成 `assistant_message` 时写入：

```text
provider_message_id
```

这样前端 Fork 目标不会使用 CodeMUX 自己生成的事件 ID。

### 7.3 OpenCode Fork 边界语义

OpenCode 的 `session.fork({ messageID })` 语义是：

```text
复制 messageID 之前的消息
```

也就是说，直接传入被点击的 assistant message ID，会把该 assistant 排除在子会话之外。

最终实现：

1. 通过 OpenCode `session.messages` 查询 provider 消息列表。
2. 定位用户点击的 assistant message。
3. 找到它的下一条 provider message。
4. 将下一条 message ID 作为 Fork 边界。
5. 这样选中的 assistant 会被完整复制。
6. 如果选中消息是最新消息，则不传边界，复制完整历史。

该查询发生在 provider SDK 层，不直接读取 CodeMUX 或 OpenCode JSONL/SQLite。

### 7.4 OpenCode session 流程

```text
OpenCode assistant provider_message_id
    ↓
Rust fork_opencode_session
    ↓
sidecar OpenCodeRuntime.forkSession
    ↓
session.messages 查询下一条消息
    ↓
session.fork
    ↓
新的 OpenCode session ID
```

## 8. 前端实现

### 8.1 消息元数据

assistant 消息携带：

- `sourceUuid`
- `sourceProviderTurnId`
- provider message ID

Fork 按照当前 session 的 `agent_kind` 选择对应 API。

### 8.2 Provider 分流

```text
agent_kind === claude_code → forkClaude
agent_kind === codex       → forkCodex
agent_kind === opencode    → forkOpenCode
```

OpenCode 不能 fallback 到 Claude Fork。

### 8.3 turn 和消息可用性

Fork 按钮只在以下条件满足时显示：

- assistant 消息已完成。
- 当前 session 没有运行中的 turn。
- 消息存在 provider 侧可定位的 ID。
- 消息不是系统消息。

## 9. 历史问题与修复记录

### 9.1 没有完成 assistant 消息

错误：

```text
The session has no completed assistant message to fork
```

原因是旧逻辑只识别 `turn_finished(outcome=completed)`，而 Claude 历史只有 assistant 的 `stop_reason=end_turn`。

修复：将终止 `stop_reason` 作为完成信号。

### 9.2 只能 Fork 最新消息

错误：

```text
Only the latest completed assistant message can be forked
```

原因是前端传递 CodeMUX `event_id`，后端比较的是 provider message ID。

修复：统一优先使用 `provider_message_id`，并实现任意历史 assistant turn 截断。

### 9.3 Codex turn ID 缺失

错误：

```text
Codex Fork target is missing its completed provider turn ID
```

原因是 item ID 被误当作 turn ID，且 Codex SDK 实时事件没有暴露真实 turn ID。

修复：使用 turn ordinal 查询 Codex app-server 的真实 turn ID。

### 9.4 OpenCode 不支持 Fork

错误：

```text
This provider runtime does not support session fork
```

原因是 OpenCodeRuntime 已实现 Fork，但 `createOpenCodeSidecarRuntime()` 返回的 runtime 对象遗漏了 `forkSession` 方法。

修复：把 OpenCodeRuntime.forkSession 正确暴露给 sidecar dispatcher，并重新构建 sidecar。

### 9.5 OpenCode 子会话缺少目标 assistant

现象：Fork 后子会话只显示目标 assistant 之前的用户消息。

原因：OpenCode `session.fork(messageID)` 不包含传入的目标消息。

修复：查询目标消息的下一条消息，将下一条消息 ID 作为 Fork 边界。

## 10. 关键文件

### Rust

- `src-tauri/src/agent/commands.rs`
- `src-tauri/src/agent/history_events.rs`
- `src-tauri/src/db/operations.rs`
- `src-tauri/src/db/schema.rs`
- `src-tauri/src/lib.rs`

### Sidecar

- `src-tauri/sidecar/src/types.ts`
- `src-tauri/sidecar/src/index.ts`
- `src-tauri/sidecar/src/claudeRuntime.ts`
- `src-tauri/sidecar/src/codexRuntime.ts`
- `src-tauri/sidecar/src/codexFork.ts`
- `src-tauri/sidecar/src/opencodeRuntime.ts`
- `src-tauri/sidecar/src/opencodeSdk.ts`
- `src-tauri/sidecar/src/opencodeEvents.ts`
- `src-tauri/sidecar/src/turnEventNormalizer.ts`

### 前端

- `src/components/agent/assistant-ui/CodeMuxThread.tsx`
- `src/components/assistant-ui/message-footer.tsx`
- `src/components/agent/assistant-ui/convertAgentEvents.ts`
- `src/lib/tauri.ts`
- `src/lib/codeMuxProtocol.ts`
- `src/stores/sessionStore.ts`
- `src/stores/agentEventParsing.ts`
- `src/types/agent.ts`
- `src/types/session.ts`

## 11. 测试与验证

已覆盖：

- Claude 任意历史 turn 截断和 session Fork。
- Codex app-server Fork。
- Codex turn ordinal 到 provider turn ID 的传递。
- OpenCode provider message ID 传递。
- OpenCode SDK `session.fork` 调用。
- OpenCode Fork 边界消息解析。
- OpenCode 运行中禁止 Fork。
- Sidecar 三种 provider 路由。
- session store 三种 provider 分流。
- session lineage 和独立 mapping。

已执行验证：

- Sidecar TypeScript 构建通过。
- Sidecar OpenCode/Codex/dispatcher 测试通过。
- 前端 Fork 相关测试通过。
- 前端生产构建通过。
- Rust `cargo check --all-targets` 通过。
- 修改文件 Linter 无新增错误。

说明：Sidecar 全量测试曾有 3 项 Codex 兼容代理测试因本机端口 `127.0.0.1:15722` 被占用而失败，该问题与 Fork 逻辑无关；相关 Fork 定向测试均通过。

## 12. 后续可选工作

- 增加完整 UI 集成测试，验证点击指定 assistant 后子会话展示完整历史。
- 在 session 列表中可视化父子 lineage。
- 增加“从当前消息 Fork”快捷键。
- 支持 provider 工作区隔离或 Git branch。
- 对 OpenCode 和 Codex provider Fork 增加真实 Runtime 集成测试。
- 增加 provider Fork 失败后的孤儿 session 清理任务。
