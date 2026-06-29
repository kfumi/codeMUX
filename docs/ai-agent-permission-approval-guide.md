# AI Agent 权限审批功能实现总结与指导

## 概述

本项目实现了一套完整的 AI Agent 权限审批系统，涵盖 Claude Code 和 Codex 两个引擎的权限控制。核心设计理念是**变更前确认**，确保用户对 AI 的文件操作和命令执行有完全的控制权。

---

## 一、权限模式体系

### 1.1 三种核心权限模式

| 模式 | CLI 参数 | 审批策略 | 安全级别 |
|------|----------|----------|----------|
| `full-access` | `--dangerously-skip-permissions` | `never`（跳过所有审批） | 最低 |
| `read-only` | `--permission-mode plan` | `on-request`（只读，不允许写入） | 最高 |
| `default` | 无 | `on-request`（变更前需审批） | 中等 |

### 1.2 权限模式与执行策略映射

后端通过 `resolve_execution_policy` 函数（`src-tauri/src/shared/codex_core.rs:86`）实现模式到策略的映射：

```rust
fn resolve_execution_policy(
    access_mode: &str,
    workspace_path: &str,
    custom_spec_root: Option<&str>,
    effective_mode: &str,
    mode_enforcement_enabled: bool,
) -> (Value, &'static str, Option<&'static str>) {
    let mut sandbox_policy = match access_mode {
        "full-access" => json!({ "type": "dangerFullAccess" }),
        "read-only" => json!({ "type": "readOnly" }),
        _ => {
            let writable_roots = build_writable_roots(workspace_path, custom_spec_root);
            json!({
                "type": "workspaceWrite",
                "writableRoots": writable_roots,
                "networkAccess": true
            })
        }
    };

    let mut approval_policy = if access_mode == "full-access" {
        "never"
    } else {
        "on-request"
    };

    if mode_enforcement_enabled && effective_mode == "plan" {
        sandbox_policy = json!({ "type": "readOnly" });
        approval_policy = "on-request";
        return (sandbox_policy, approval_policy, Some("plan_readonly_violation"));
    }

    (sandbox_policy, approval_policy, None)
}
```

---

## 二、Claude Code 权限审批架构

### 2.1 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        用户界面 (Frontend)                          │
│  ┌──────────────────┐  ┌──────────────────────────────────────────┐│
│  │ ApprovalToasts   │  │ useThreadApprovals (审批状态管理)          ││
│  │ (审批弹窗组件)    │  │ - handleApprovalDecision                  ││
│  │ - 逐条审批       │  │ - handleApprovalBatchAccept               ││
│  │ - 批量审批       │  │ - handleApprovalRemember                  ││
│  │ - 记住规则       │  └──────────────────────────────────────────┘│
│  └────────┬─────────┘                                              │
│           │ Tauri IPC invoke                                       │
└───────────┼────────────────────────────────────────────────────────┘
            │
┌───────────▼────────────────────────────────────────────────────────┐
│                     后端 (Rust Tauri)                              │
│  ┌───────────────────────────────────────────────────────────────┐│
│  │ src-tauri/src/engine/claude/approval.rs                       ││
│  │ ┌─────────────────────────────────────────────────────────┐   ││
│  │ │ 权限拒绝识别                                              │   ││
│  │ │ - looks_like_claude_permission_denial_message()          │   ││
│  │ │ - classify_claude_mode_blocked_tool()                     │   ││
│  │ └─────────────────────────────────────────────────────────┘   ││
│  │ ┌─────────────────────────────────────────────────────────┐   ││
│  │ │ 本地文件变更应用                                           │   ││
│  │ │ - write_claude_approved_workspace_file()                 │   ││
│  │ │ - edit_claude_approved_workspace_file()                  │   ││
│  │ │ - apply_claude_structured_edits_to_workspace_file()      │   ││
│  │ │ - delete_claude_approved_workspace_path()                │   ││
│  │ └─────────────────────────────────────────────────────────┘   ││
│  │ ┌─────────────────────────────────────────────────────────┐   ││
│  │ │ 审批状态管理                                               │   ││
│  │ │ - respond_to_approval_request()                          │   ││
│  │ │ - push_synthetic_approval_summary()                      │   ││
│  │ │ - finalize_synthetic_approval_turn()                     │   ││
│  │ └─────────────────────────────────────────────────────────┘   ││
│  └───────────────────────────────────────────────────────────────┘│
│                              │                                    │
│                              ▼                                    │
│  ┌───────────────────────────────────────────────────────────────┐│
│  │ Claude Code CLI (claude -p)                                   ││
│  │ - 文件权限阻塞 → 生成 synthetic approval request               ││
│  │ - 审批后 resume → 继续执行会话                                  ││
│  └───────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 核心数据结构

**ApprovalRequest 类型**（`src/types.ts:1229`）：

```typescript
export type ApprovalRequest = {
  workspace_id: string;
  request_id: number | string;
  method: string;           // "fileChange" | "commandExecution" | ...
  params: Record<string, unknown>;  // 工具输入参数
};
```

**ClaudeModeBlockedKind**（`src-tauri/src/engine/claude/approval.rs:22`）：

```rust
enum ClaudeModeBlockedKind {
    RequestUserInput,     // AskUserQuestion
    FileChange,           // Write/Edit/Delete 等文件操作
    CommandExecution,     // Bash/Shell/NativeCommand 等命令执行
}
```

### 2.3 审批触发流程

#### 步骤 1：权限拒绝识别

后端通过 `looks_like_claude_permission_denial_message()` 函数（`src-tauri/src/engine/claude/approval.rs:131`）检测 Claude CLI 输出中的权限拒绝消息：

```rust
fn looks_like_claude_permission_denial_message(message: &str) -> bool {
    let normalized_message = message.trim().to_ascii_lowercase();
    normalized_message.contains("requires approval")
        || normalized_message.contains("requested permissions")
        || normalized_message.contains("haven't granted it yet")
        || normalized_message.contains("permission denied")
        || normalized_message.contains("blocked for security")
        || normalized_message.contains("allowed working directories")
        || normalized_message.contains("may only write to files")
}
```

#### 步骤 2：工具分类

通过 `classify_claude_mode_blocked_tool()` 函数（`src-tauri/src/engine/claude/approval.rs:156`）识别被阻塞的工具类型：

```rust
fn classify_claude_mode_blocked_tool(tool_name: &str) -> Option<ClaudeModeBlockedKind> {
    let normalized = normalize_claude_tool_name_for_blocked_classification(tool_name);
    
    if normalized == "askuserquestion" {
        return Some(ClaudeModeBlockedKind::RequestUserInput);
    }
    
    if normalized.contains("bash") || normalized.contains("exec") || normalized.contains("command") {
        return Some(ClaudeModeBlockedKind::CommandExecution);
    }
    
    if normalized == "edit" || normalized == "multiedit" || normalized == "write" {
        return Some(ClaudeModeBlockedKind::FileChange);
    }
    
    None
}
```

#### 步骤 3：生成 Synthetic Approval Request

当检测到文件变更权限拒绝时，后端生成 synthetic approval request 并发送到前端：

```rust
// 发送 EngineEvent::ApprovalRequest 到前端
EngineEvent::ApprovalRequest {
    request_id,
    tool_name,
    input,
    message,
    workspace_id,
    thread_id,
    turn_id,
}
```

#### 步骤 4：前端审批交互

前端 `ApprovalToasts` 组件（`src/features/app/components/ApprovalToasts.tsx`）展示审批弹窗，提供以下操作：

| 操作 | 说明 |
|------|------|
| **Approve** | 批准当前变更 |
| **Decline** | 拒绝当前变更 |
| **Approve All** | 批量批准同一 turn 中的所有文件变更 |
| **Always Allow** | 记住命令前缀，后续自动批准 |

#### 步骤 5：本地文件变更应用

用户批准后，后端通过 `respond_to_approval_request()` 函数（`src-tauri/src/engine/claude/approval.rs:1029`）处理审批结果：

```rust
pub async fn respond_to_approval_request(
    &self,
    request_id: Value,
    result: Value,
) -> Result<(), String> {
    // 1. 解析审批决策 (accept/decline)
    // 2. 验证请求 ID 和 turn ID
    // 3. 识别是否为文件变更操作
    // 4. 如果是文件变更，本地应用变更
    // 5. 发送工具完成事件
    // 6. 推送审批摘要
    // 7. 如果所有审批完成，构造 resume message 继续会话
}
```

#### 步骤 6：会话恢复

审批完成后，后端构造 resume message 并发送给 Claude CLI，继续执行原会话：

```rust
pub(super) fn format_synthetic_approval_resume_message(
    entries: &[SyntheticApprovalSummaryEntry],
) -> String {
    let summary = format_synthetic_approval_completion_text(entries)
        .unwrap_or_else(|| "Approval handling finished.".to_string());
    match format_synthetic_approval_resume_marker(entries) {
        Some(marker) => format!(
            "{marker}\n{summary}\nPlease continue from the current workspace state and finish the original task."
        ),
        None => format!(
            "{}\nPlease continue from the current workspace state and finish the original task.",
            summary
        ),
    }
}
```

---

## 三、支持的文件变更类型

### 3.1 结构化文件工具

| 工具名 | 操作类型 | 实现函数 |
|--------|----------|----------|
| `Write` / `CreateFile` | 创建或覆盖文件 | `write_claude_approved_workspace_file()` |
| `Edit` | 单处文本替换 | `edit_claude_approved_workspace_file()` |
| `MultiEdit` | 多处文本替换 | `apply_claude_structured_edits_to_workspace_file()` |
| `Delete` / `Remove` | 删除文件或目录 | `delete_claude_approved_workspace_path()` |
| `CreateDirectory` | 创建目录 | `create_claude_approved_workspace_directory()` |
| `Rewrite` | 重写文件 | `write_claude_approved_workspace_file()` |

### 3.2 安全单路径命令

通过 `command_can_apply_as_local_file_action()` 函数（`src-tauri/src/engine/claude/approval.rs:348`）识别可安全执行的命令：

```rust
fn parse_single_path_file_command(command: &str) -> Option<LocalClaudeFileCommand> {
    // 1. 检查是否包含 shell 控制字符 (; | & > < ` $( ${)
    // 2. 解析命令参数
    // 3. 只允许单路径操作
    // 4. 返回 LocalClaudeFileCommand::Remove / MakeDirectory / Touch
}
```

支持的命令：
- `mkdir [-p] <path>` - 创建目录
- `rm [-rf] <path>` - 删除文件/目录
- `touch <path>` - 创建空文件

---

## 四、安全防护机制

### 4.1 工作空间边界检查

所有文件操作必须在工作空间根目录内进行（`src-tauri/src/engine/claude/approval.rs:457`）：

```rust
fn ensure_workspace_path_within_root(
    candidate: &Path,
    canonical_root: &Path,
) -> Result<(), String> {
    if !candidate.starts_with(canonical_root) {
        return Err("Invalid path outside workspace root.".to_string());
    }
    Ok(())
}
```

### 4.2 路径规范化

- 去除 `..` 和 `.` 路径组件
- 统一路径分隔符（Windows `\` → `/`）
- 解析绝对路径并转换为工作空间相对路径

```rust
pub(super) fn normalize_claude_workspace_relative_path(path: &Path) -> Result<String, String> {
    let mut segments = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(segment) => {
                let value = segment.to_string_lossy().trim().to_string();
                if value.is_empty() {
                    return Err("Claude approval path is invalid.".to_string());
                }
                segments.push(value);
            }
            Component::CurDir | Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("Claude approval path is invalid.".to_string());
            }
        }
    }
    // ...
}
```

### 4.3 符号链接防护

不允许修改符号链接指向的目标文件（`src-tauri/src/engine/claude/approval.rs:473`）：

```rust
if metadata.file_type().is_symlink() {
    return Err("Claude approval preview cannot modify symlink targets.".to_string());
}
```

### 4.4 `.git` 目录保护

禁止写入 `.git` 目录（`src-tauri/src/engine/claude/approval.rs:446`）：

```rust
if normalized == ".git"
    || normalized.starts_with(".git/")
    || normalized.contains("/.git/")
    || normalized.ends_with("/.git")
{
    return Err("Cannot write inside .git directory.".to_string());
}
```

### 4.5 文件大小限制

单文件最大 400KB（`src-tauri/src/engine/claude/approval.rs:6`）：

```rust
const MAX_CLAUDE_APPROVAL_FILE_BYTES: usize = 400_000;
```

---

## 五、多文件批处理机制

### 5.1 批量审批逻辑

前端 `handleApprovalBatchAccept` 函数（`src/features/threads/hooks/useThreadApprovals.ts:182`）实现批量审批：

```typescript
const handleApprovalBatchAccept = useCallback(
    async (batch: ApprovalRequest[]) => {
        const seenRequestKeys = new Set<string>();
        const uniqueFileBatch = batch.filter((approval) => {
            if (!isFileChangeApprovalRequest(approval)) {
                return false;
            }
            const requestKey = buildApprovalRequestKey(approval);
            if (seenRequestKeys.has(requestKey)) {
                return false;
            }
            seenRequestKeys.add(requestKey);
            return true;
        });

        for (const approval of uniqueFileBatch) {
            markApprovalAsApplying(approval);
            await respondToServerRequest(
                approval.workspace_id,
                approval.request_id,
                "accept",
            );
            dispatch({ type: "removeApproval", ... });
        }
    },
    [dispatch, markApprovalAsApplying],
);
```

### 5.2 Turn Finalization 策略

后端只在同一 turn 的所有审批请求都完成后才 finalize turn（`src-tauri/src/engine/claude/approval.rs:1091`）：

```rust
if self.pending_approval_request_count_for_turn(&turn_id) == 0 {
    let approval_entries = self.take_synthetic_approval_entries(&turn_id);
    // 构造 resume message 并继续会话
}
```

---

## 六、历史去噪与恢复

### 6.1 Resume Marker 机制

使用 `<ccgui-approval-resume>...</ccgui-approval-resume>` marker 在 resume 时回灌批准结果，避免历史噪音：

```rust
pub(super) const SYNTHETIC_APPROVAL_RESUME_MARKER_PREFIX: &str = "<ccgui-approval-resume>";
pub(super) const SYNTHETIC_APPROVAL_RESUME_MARKER_SUFFIX: &str = "</ccgui-approval-resume>";
```

### 6.2 历史恢复处理

历史 loader 会把 marker 剥离成结构化 `File changes` 卡片，避免历史噪音：

- `ConversationItem` 类型中包含 `kind: "tool"` + `toolType: "fileChange"` 的条目
- 展示变更路径、操作类型等信息

---

## 七、命令记忆机制

### 7.1 批准规则记忆

用户可以选择"Always Allow"记住特定命令前缀，后续自动批准：

```typescript
const handleApprovalRemember = useCallback(
    async (request: ApprovalRequest, command: string[]) => {
        await rememberApprovalRule(request.workspace_id, command);
        rememberApprovalPrefix(request.workspace_id, command);
        markApprovalAsApplying(request);
        await respondToServerRequest(request.workspace_id, request.request_id, "accept");
        dispatch({ type: "removeApproval", ... });
    },
    [dispatch, markApprovalAsApplying, onDebug, rememberApprovalPrefix],
);
```

### 7.2 命令前缀匹配

通过 `matchesCommandPrefix` 函数（`src/utils/approvalRules.ts:128`）实现前缀匹配：

```typescript
export function matchesCommandPrefix(
    command: string[],
    allowlist: string[][],
): boolean {
    const normalized = normalizeCommandTokens(command);
    if (!normalized.length) {
        return false;
    }
    return allowlist.some((prefix) => {
        if (!prefix.length || prefix.length > normalized.length) {
            return false;
        }
        for (let i = 0; i < prefix.length; i += 1) {
            if (prefix[i] !== normalized[i]) {
                return false;
            }
        }
        return true;
    });
}
```

---

## 八、ModeBlocked 诊断机制

### 8.1 非文件工具阻塞处理

当 Claude 遇到非文件工具权限阻塞时（如命令执行），系统生成 `modeBlocked` 诊断信号：

```typescript
export type CollaborationModeBlockedParams = {
    thread_id: string;
    blocked_method: string;  // "item/commandExecution/requestApproval"
    effective_mode: string;
    reason_code?: string;    // "claude_command_execution_permission_denied"
    reason: string;
    suggestion?: string;
    request_id?: number | string | null;
};
```

### 8.2 恢复建议

系统提供明确的恢复方向：
- 切换到 `full-access` 模式
- 改写为受支持的文件工具操作

---

## 九、实现指导

### 9.1 后端实现步骤

1. **识别权限拒绝消息**：实现 `looks_like_permission_denial()` 函数
2. **分类工具类型**：实现 `classify_blocked_tool()` 函数
3. **生成 Approval Request**：发送结构化审批请求到前端
4. **本地变更应用**：实现安全的文件操作函数（含边界检查）
5. **会话恢复**：构造 resume message 继续执行

### 9.2 前端实现步骤

1. **审批状态管理**：使用 reducer 管理审批列表
2. **审批弹窗组件**：展示审批详情和操作按钮
3. **批量审批支持**：实现批量批准逻辑
4. **命令记忆**：实现命令前缀记忆和自动批准

### 9.3 安全检查清单

- [ ] 工作空间边界检查
- [ ] 路径规范化（去除 `..`）
- [ ] 符号链接防护
- [ ] `.git` 目录保护
- [ ] 文件大小限制
- [ ] Shell 控制字符过滤
- [ ] 单路径命令限制

### 9.4 代码复用建议

以下文件是核心实现，可作为参考：

| 层级 | 文件路径 | 职责 |
|------|----------|------|
| 后端 | `src-tauri/src/engine/claude/approval.rs` | Claude 审批核心逻辑 |
| 后端 | `src-tauri/src/shared/codex_core.rs` | Codex 权限策略 |
| 前端 | `src/features/threads/hooks/useThreadApprovals.ts` | 审批状态管理 |
| 前端 | `src/features/app/components/ApprovalToasts.tsx` | 审批 UI 组件 |
| 前端 | `src/utils/approvalRules.ts` | 命令解析和匹配 |
| 前端 | `src/utils/approvalBatching.ts` | 审批批处理工具 |
| 类型 | `src/types.ts` | ApprovalRequest 等类型定义 |

---

## 十、Codex 权限审批架构

### 10.1 架构总览

Codex 的权限审批机制与 Claude Code 有显著不同，它通过 SDK 原生的审批策略和协作模式系统实现权限控制：

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           Codex 审批策略完整流程                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────┐    ┌──────────────────┐    ┌──────────────────────────┐   │
│  │ 用户发送消息 │───▶│ 计算协作策略      │───▶│ 注入 turn payload       │   │
│  │             │    │ resolve_policy() │    │ apply_policy_to_...()   │   │
│  └─────────────┘    └──────────────────┘    └──────────────────────────┘   │
│                          │                              │                    │
│                          │                              ▼                    │
│                          │                    ┌──────────────────┐          │
│                          │                    │ 发送 turn/start  │          │
│                          │                    │ 到 Codex CLI     │          │
│                          │                    └────────┬─────────┘          │
│                          │                             │                     │
│                          │                             ▼                     │
│                          │                    ┌──────────────────┐          │
│                          │                    │ CLI 执行并返回   │          │
│                          │                    │ 事件流           │          │
│                          │                    └────────┬─────────┘          │
│                          │                             │                     │
│                          │                             ▼                     │
│                          │                    ┌──────────────────┐          │
│                          │                    │ 后端事件拦截      │          │
│                          │                    │ intercept_...()  │          │
│                          │                    └────────┬─────────┘          │
│                          │                             │                     │
│                          │              ┌──────────────┼──────────────┐      │
│                          │              ▼              ▼              ▼      │
│                          │     ┌─────────────┐  ┌─────────────┐  ┌──────────┐│
│                          │     │ 允许通过    │  │ 阻断并发送  │  │ 检测仓库 ││
│                          │     │ (继续传递)  │  │ modeBlocked │  │ 变更阻断 ││
│                          │     └──────┬──────┘  └──────┬──────┘  └────┬─────┘│
│                          │            │                │              │      │
│                          │            ▼                ▼              ▼      │
│                          │     ┌──────────────────────────────────────────┐   │
│                          │     │              发送事件到前端               │   │
│                          │     └─────────────────────┬────────────────────┘   │
│                          │                           │                       │
│                          │                           ▼                       │
│                          │     ┌──────────────────────────────────────────┐   │
│                          │     │              useAppServerEvents          │   │
│                          │     │              事件路由分发                  │   │
│                          │     └─────────────────────┬────────────────────┘   │
│                          │                           │                       │
│                          │              ┌────────────┼────────────┐          │
│                          │              ▼            ▼            ▼          │
│                          │     ┌─────────────┐ ┌─────────────┐ ┌───────────┐ │
│                          │     │ modeBlocked │ │userInputReq│ │ 其他事件  │ │
│                          │     │ (模式阻断)  │ │(审批请求)   │ │(正常渲染) │ │
│                          │     └──────┬──────┘ └──────┬──────┘ └─────┬─────┘ │
│                          │            │               │               │      │
│                          │            ▼               ▼               ▼      │
│                          │     ┌─────────────┐ ┌─────────────┐ ┌───────────┐ │
│                          │     │ 显示模式     │ │ 显示审批    │ │ 消息/工具 │ │
│                          │     │ 切换提示     │ │ 弹窗组件    │ │ 正常渲染  │ │
│                          │     └─────────────┘ └─────────────┘ └───────────┘ │
│                          │                                                   │
│                          ▼                                                   │
│                    ┌─────────────┐                                           │
│                    │ 用户决策    │                                           │
│                    │ (接受/拒绝) │                                           │
│                    └──────┬──────┘                                           │
│                           │                                                  │
│                           ▼                                                  │
│                    ┌─────────────┐                                           │
│                    │ 发送决策到  │                                           │
│                    │ 后端        │                                           │
│                    └─────────────┘                                           │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 10.2 核心数据结构

**CodexCollaborationPolicy**（`src-tauri/src/codex/collaboration_policy.rs:13`）：

```rust
pub struct CodexCollaborationPolicy {
    pub selected_mode: Cow<'static, str>,           // 用户选择的模式
    pub effective_mode: Cow<'static, str>,          // 实际生效的模式
    pub profile: Cow<'static, str>,                 // 协作配置文件
    pub request_user_input_policy: Cow<'static, str>, // 用户输入策略
    pub policy_version: u64,                        // 策略版本号
    pub fallback_reason: Option<Cow<'static, str>>, // 回退原因
}
```

**RequestUserInputParams**（`src/types.ts`）：

```typescript
export type RequestUserInputParams = {
  thread_id: string;
  turn_id: string;
  request_id: number | string;
  prompt?: string;
  type?: "text" | "boolean" | "list" | "json" | "enum";
  options?: string[];
  metadata?: Record<string, unknown>;
};
```

**CollaborationModeBlockedParams**（`src/types.ts`）：

```typescript
export type CollaborationModeBlockedParams = {
  thread_id: string;
  blocked_method: string;
  effective_mode: string;
  reason_code?: string;
  reason: string;
  suggestion?: string;
  request_id?: number | string | null;
};
```

### 10.3 策略计算层

Codex 通过 `resolve_execution_policy()` 函数（`src-tauri/src/shared/codex_core.rs:86`）计算执行策略：

```rust
fn resolve_execution_policy(
    access_mode: &str,
    workspace_path: &str,
    custom_spec_root: Option<&str>,
    effective_mode: &str,
    mode_enforcement_enabled: bool,
) -> (Value, &'static str, Option<&'static str>) {
    // 1. 计算 sandbox_policy（沙箱策略）
    let mut sandbox_policy = match access_mode {
        "full-access" => json!({ "type": "dangerFullAccess" }),
        "read-only" => json!({ "type": "readOnly" }),
        _ => {
            let writable_roots = build_writable_roots(workspace_path, custom_spec_root);
            json!({
                "type": "workspaceWrite",
                "writableRoots": writable_roots,
                "networkAccess": true
            })
        }
    };

    // 2. 计算 approval_policy（审批策略）
    let mut approval_policy = if access_mode == "full-access" {
        "never"
    } else {
        "on-request"
    };

    // 3. Plan 模式强制只读约束
    if mode_enforcement_enabled && effective_mode == "plan" {
        sandbox_policy = json!({ "type": "readOnly" });
        approval_policy = "on-request";
        return (sandbox_policy, approval_policy, Some("plan_readonly_violation"));
    }

    (sandbox_policy, approval_policy, None)
}
```

**策略映射表**：

| access_mode | sandbox_policy | approval_policy | 违反原因 |
|-------------|---------------|-----------------|----------|
| `full-access` | `dangerFullAccess` | `never` | 无 |
| `read-only` | `readOnly` | `on-request` | 无 |
| `default` + effective_mode=`plan` | `readOnly` | `on-request` | `plan_readonly_violation` |
| `default` | `workspaceWrite` | `on-request` | 无 |

### 10.4 协作策略注入

通过 `apply_policy_to_collaboration_mode()` 函数（`src-tauri/src/codex/collaboration_policy.rs:67`）将策略注入到 turn payload：

```rust
pub(crate) fn apply_policy_to_collaboration_mode(
    payload: Option<Value>,
    policy: &CodexCollaborationPolicy,
) -> Value {
    let mut root = payload.and_then(|value| value.as_object().cloned()).unwrap_or_default();
    let mut settings = root.get("settings").and_then(Value::as_object).cloned().unwrap_or_default();
    
    // 1. 注入 developer_instructions（包含模式指令）
    let directives = build_policy_directives(policy);
    if let Some(existing_instructions) = settings.get("developer_instructions") {
        if let Some(merged) = merge_developer_instructions(existing_instructions, &directives) {
            settings.insert("developer_instructions".to_string(), Value::String(merged));
        }
    }
    
    // 2. 注入运行时元数据（可观测字段）
    settings.insert(
        "_mossx_runtime".to_string(),
        json!({
            "selected_mode": policy.selected_mode,
            "effective_mode": policy.effective_mode,
            "collaboration_profile": policy.profile.as_str(),
            "policy_version": policy.policy_version,
            "request_user_input_policy": policy.request_user_input_policy.as_str(),
        }),
    );
    
    // 3. 设置 wire mode（Codex App Server 协议）
    let wire_mode = if policy.effective_mode == "plan" { "plan" } else { "default" };
    root.insert("mode".to_string(), Value::String(wire_mode));
    
    root.insert("settings".to_string(), Value::Object(settings));
    Value::Object(root)
}
```

**策略指令示例**（`build_policy_directives()`）：

| 模式 | Profile | 指令内容 |
|------|---------|----------|
| `plan` | 任意 | 只读检查，遇到阻塞必须调用 `requestUserInput`，禁止纯文本追问 |
| `code` | `official-compatible` | 默认自主执行，但允许关键信息缺失时调用 `requestUserInput` |
| `code` | `strict-local` | 保持自主执行，禁止 `requestUserInput`，缺失细节时做最小合理假设 |

### 10.5 策略传递到 Codex CLI

在 turn/start 请求时，将计算好的策略作为 `collaborationMode` 参数传递给 Codex CLI：

```
用户消息 → 计算策略 → 注入到 turn payload → 发送给 Codex CLI → CLI 执行时遵循策略
```

### 10.6 后端事件拦截

通过 `src-tauri/src/backend/app_server_plan_enforcement.rs` 实现事件拦截：

#### 10.6.1 RequestUserInput 拦截

`intercept_request_user_input_if_needed()` 函数（`src-tauri/src/backend/app_server_plan_enforcement.rs:89`）：

```rust
pub(super) async fn intercept_request_user_input_if_needed(
    &self,
    value: &Value,
) -> Option<Value> {
    let method = extract_event_method(value)?;
    if method != "item/tool/requestUserInput" {
        return None;
    }
    
    let thread_id = extract_thread_id(value)?;
    let effective_mode = self.get_thread_effective_mode(&thread_id).await;
    let strict_local_profile = strict_local_collaboration_profile_enabled();
    
    // 判断是否需要阻断
    let block = should_block_request_user_input(
        method,
        effective_mode.as_deref(),
        self.mode_enforcement_enabled(),
        strict_local_profile,
    );
    
    if !block {
        return None;  // 允许通过
    }
    
    // 阻断：发送空响应 + 生成 modeBlocked 事件
    self.send_response(id, json!({ "answers": {} })).await;
    
    Some(build_mode_blocked_event(
        &thread_id,
        method,
        "code",
        MODE_BLOCKED_REASON_CODE_REQUEST_USER_INPUT,
        MODE_BLOCKED_REASON,
        MODE_BLOCKED_SUGGESTION,
        request_id,
    ))
}
```

**阻断条件**（`should_block_request_user_input()`）：

```rust
fn should_block_request_user_input(
    method: &str,
    effective_mode: Option<&str>,
    enforcement_enabled: bool,
    strict_local_profile: bool,
) -> bool {
    enforcement_enabled
        && strict_local_profile
        && method == "item/tool/requestUserInput"
        && effective_mode == Some("code")
}
```

#### 10.6.2 Plan 模式仓库变更阻断

`intercept_plan_repo_mutation_if_needed()` 函数（`src-tauri/src/backend/app_server_plan_enforcement.rs:169`）：

```rust
pub(super) async fn intercept_plan_repo_mutation_if_needed(
    &self,
    value: &Value,
) -> Option<Value> {
    if !self.mode_enforcement_enabled() || !strict_local_collaboration_profile_enabled() {
        return None;
    }
    
    let thread_id = extract_thread_id(value)?;
    let effective_mode = self.get_thread_effective_mode(&thread_id).await;
    
    if effective_mode.as_deref() != Some("plan") {
        return None;
    }
    
    // 检测是否为仓库变更操作
    let blocked_method = detect_repo_mutating_blocked_method(value)?;
    
    // 设置阻断状态
    {
        let mut states = self.plan_turn_state.lock().await;
        let state = states.entry(thread_id.clone()).or_default();
        state.synthetic_block_active = true;
    }
    
    Some(build_mode_blocked_event(
        &thread_id,
        &blocked_method,
        "plan",
        MODE_BLOCKED_REASON_CODE_PLAN_READONLY,
        MODE_BLOCKED_PLAN_REASON,
        MODE_BLOCKED_PLAN_SUGGESTION,
        None,
    ))
}
```

**仓库变更检测**（`detect_repo_mutating_blocked_method()`）：

| 方法 | 检测规则 |
|------|----------|
| `item/.../requestApproval` | 直接判定为需要审批 |
| `item/started` / `item/updated` | 检查 item_type 是否为 `filechange` / `apply_patch` / `commandexecution` |
| Git 命令 | 检测命令 tokens 是否包含 `git add/commit/push/pull/merge/rebase` 等 |

### 10.7 前端事件消费

#### 10.7.1 事件路由

`useAppServerEvents.ts` 中的事件处理（`src/features/app/hooks/useAppServerEvents.ts`）：

```typescript
function handleCodexRawEvent(params: Record<string, unknown>) {
    const method = asString(params.method ?? params.type ?? "");
    
    // 处理 modeBlocked 事件
    if (method === "collaboration/modeBlocked") {
        dispatch({
            type: "modeBlocked",
            params: params.params as CollaborationModeBlockedParams,
        });
        return;
    }
    
    // 处理 requestUserInput 事件
    if (method === "item/tool/requestUserInput") {
        handleRequestUserInput({
            workspace_id: params.workspace_id as string,
            params: params.params as RequestUserInputParams,
        });
        return;
    }
    
    // 其他事件路由到 normalized realtime 适配器
    const normalized = codexRealtimeAdapter.mapEvent(params);
    routeNormalizedRealtimeEvent(normalized);
}
```

#### 10.7.2 UserInput 事件处理

`useThreadUserInputEvents.ts` 中的去重和状态管理（`src/features/threads/hooks/useThreadUserInputEvents.ts`）：

```typescript
export function useThreadUserInputEvents({ dispatch }: UseThreadUserInputEventsOptions) {
    const completedRequestKeysRef = useRef<Set<string>>(new Set());

    return useCallback((request: RequestUserInputRequest) => {
        const requestKey = `${request.workspace_id}:${String(request.request_id)}`;
        
        // completed=true 时移除请求
        if (request.params.completed === true) {
            completedRequestKeysRef.current.add(requestKey);
            dispatch({
                type: "removeUserInputRequest",
                requestId: request.request_id,
                workspaceId: request.workspace_id,
            });
            return;
        }
        
        // 去重：已完成的请求不再处理
        if (completedRequestKeysRef.current.has(requestKey)) {
            return;
        }
        
        // 添加到待处理请求列表
        dispatch({ type: "addUserInputRequest", request: normalizedRequest });
    }, [dispatch]);
}
```

#### 10.7.3 Reducer 状态更新

`useThreadsReducer.ts` 中的状态管理：

```typescript
case "addUserInputRequest":
    return {
        ...state,
        userInputRequests: [...state.userInputRequests, action.request],
    };

case "removeUserInputRequest":
    return {
        ...state,
        userInputRequests: state.userInputRequests.filter(
            (r) => r.request_id !== action.requestId
        ),
    };
```

#### 10.7.4 UI 渲染

`ApprovalToasts.tsx` 中的审批弹窗渲染：

```tsx
function ApprovalToasts({ approvals, onDecision, onApproveBatch, onRemember }) {
    const primaryRequest = approvals[approvals.length - 1];
    
    return (
        <div className="approval-toasts" role="region" aria-live="assertive">
            {[primaryRequest].map((request) => (
                <div key={`${request.workspace_id}-${request.request_id}`} className="approval-toast">
                    {/* 审批类型图标和标签 */}
                    <div className="approval-toast-kind">
                        <span className={getApprovalKindIcon(request.method)} />
                        <span>{getToolLabel(request.method, t)}</span>
                    </div>
                    
                    {/* 文件路径或命令预览 */}
                    {approvalPath && (
                        <div className="approval-toast-detail-spotlight">
                            <span className="codicon codicon-file" />
                            <span>{approvalPath}</span>
                        </div>
                    )}
                    
                    {/* 操作按钮 */}
                    <div className="approval-toast-actions">
                        <button onClick={() => onDecision(request, "decline")}>
                            {t("approval.decline")}
                        </button>
                        <button onClick={() => onDecision(request, "accept")}>
                            {t("approval.approveEnter")}
                        </button>
                    </div>
                </div>
            ))}
        </div>
    );
}
```

### 10.8 关键差异：Codex vs Claude Code

| 维度 | Codex | Claude Code |
|------|-------|-------------|
| **策略注入** | 通过 turn payload 的 `collaborationMode` 参数 | 通过 CLI 参数 `--dangerously-skip-permissions` / `--permission-mode` |
| **审批机制** | SDK 原生审批策略 + 本地事件拦截 | Synthetic Approval（合成审批桥） |
| **文件操作** | CLI 直接执行（受 sandbox_policy 控制） | 本地应用变更后 Resume 会话 |
| **事件阻断** | `requestUserInput` / 仓库变更拦截 | 权限拒绝消息检测 + 本地执行 |
| **恢复机制** | SDK 自动处理 | `<ccgui-approval-resume>` marker |
| **协作模式** | 支持 plan/code 模式切换 | 支持权限模式切换 |
| **策略指令** | 通过 `developer_instructions` 传递 | 通过 CLI 参数控制 |
| **可观测性** | `_mossx_runtime` 元数据注入 | 无元数据注入 |

### 10.9 Codex 实现要点总结

#### 后端实现步骤

1. **策略计算**：实现 `resolve_execution_policy()` 计算 sandbox 和 approval 策略
2. **策略注入**：通过 `apply_policy_to_collaboration_mode()` 将策略注入到 turn payload
3. **事件拦截**：
   - 实现 `intercept_request_user_input_if_needed()` 拦截用户输入请求
   - 实现 `intercept_plan_repo_mutation_if_needed()` 拦截 plan 模式下的仓库变更
4. **事件构造**：实现 `build_mode_blocked_event()` 构造模式阻断事件
5. **状态管理**：维护线程级别的 effective_mode 和阻断状态

#### 前端实现步骤

1. **事件路由**：在 `useAppServerEvents.ts` 中实现事件分发
2. **状态管理**：使用 reducer 维护 `userInputRequests` 列表
3. **去重处理**：使用 `useThreadUserInputEvents.ts` 实现请求去重
4. **UI 渲染**：使用 `ApprovalToasts.tsx` 展示审批弹窗
5. **用户决策**：实现 `onDecision` 处理用户接受/拒绝操作

#### Codex 特有的安全考虑

- [ ] Plan 模式强制只读约束
- [ ] Strict-local profile 禁止 `requestUserInput`
- [ ] 仓库变更操作检测和阻断
- [ ] Thread 级别的 effective_mode 管理
- [ ] 策略版本控制和可观测性

### 10.10 Codex 审批流程图

```
用户消息
    │
    ▼
resolve_policy() ───────► selected_mode, effective_mode, profile
    │
    ▼
apply_policy_to_collaboration_mode()
    │
    ▼
发送 turn/start 到 Codex CLI（包含 collaborationMode）
    │
    ▼
Codex CLI 执行并返回事件流
    │
    ▼
intercept_request_user_input_if_needed() ──► 阻断？ ──是──▶ 发送 modeBlocked 事件
    │ 否                                         │
    ▼                                           ▼
intercept_plan_repo_mutation_if_needed() ──► 阻断？ ──是──▶ 发送 modeBlocked 事件
    │ 否                                         │
    ▼                                           ▼
继续传递事件 ─────────────────────────────────┘
    │
    ▼
useAppServerEvents 事件路由
    │
    ├─────────────────► modeBlocked ──► 更新 thread state ──► 显示模式切换提示
    │
    ├─────────────────► requestUserInput ──► useThreadUserInputEvents ──► 显示审批弹窗
    │
    └─────────────────► 其他事件 ──► 正常渲染
```

---

## 十一、统一最佳实践

### 11.1 权限审批核心原则

1. **变更前确认**：所有危险操作（文件写入、命令执行、网络请求）必须用户确认
2. **边界保护**：严格限制工作空间边界，防止路径遍历攻击
3. **模式隔离**：plan 模式强制只读，code 模式允许自主执行
4. **可追溯性**：所有审批操作记录到历史，便于审计
5. **用户体验**：批量审批、命令记忆、去重处理优化交互

### 11.2 通用实现模式

#### 后端模式

```rust
// 1. 策略计算
fn resolve_execution_policy(...) -> (sandbox_policy, approval_policy, violation_reason)

// 2. 策略注入
fn apply_policy_to_collaboration_mode(payload, policy) -> Value

// 3. 事件拦截
fn intercept_event_if_needed(event) -> Option<block_event>

// 4. 事件构造
fn build_approval_or_blocked_event(...) -> Value
```

#### 前端模式

```typescript
// 1. 事件路由
function handleRawEvent(event) {
  switch (event.method) {
    case "approval": dispatchApprovalEvent(event);
    case "modeBlocked": dispatchModeBlockedEvent(event);
    case "requestUserInput": dispatchUserInputEvent(event);
  }
}

// 2. 状态管理
interface ApprovalState {
  requests: ApprovalRequest[];
  userInputRequests: UserInputRequest[];
}

// 3. UI 渲染
<ApprovalToasts approvals={state.requests} onDecision={handleDecision} />
```

### 11.3 安全检查清单

- [ ] 工作空间边界检查
- [ ] 路径规范化（去除 `..` 和 `.`）
- [ ] 符号链接防护
- [ ] `.git` 目录保护
- [ ] 文件大小限制
- [ ] Shell 控制字符过滤
- [ ] 单路径命令限制
- [ ] Plan 模式只读约束
- [ ] Strict-local profile 禁止用户输入
- [ ] 仓库变更操作检测

### 11.4 性能优化建议

1. **批量审批**：同一 turn 的多个文件变更可以批量批准
2. **去重处理**：使用 Set 或 Map 存储已处理请求的 key
3. **懒加载**：大型文件变更预览懒加载
4. **防抖节流**：高频事件处理使用防抖节流
5. **内存清理**：定期清理已完成的请求缓存

---

## 十二、核心文件参考

| 层级 | 文件路径 | 职责 |
|------|----------|------|
| 后端 | `src-tauri/src/engine/claude/approval.rs` | Claude 审批核心逻辑 |
| 后端 | `src-tauri/src/shared/codex_core.rs` | Codex 权限策略计算 |
| 后端 | `src-tauri/src/codex/collaboration_policy.rs` | Codex 协作策略注入 |
| 后端 | `src-tauri/src/backend/app_server_plan_enforcement.rs` | Plan 模式强制执行 |
| 前端 | `src/features/threads/hooks/useThreadApprovals.ts` | Claude 审批状态管理 |
| 前端 | `src/features/threads/hooks/useThreadUserInputEvents.ts` | Codex 用户输入事件 |
| 前端 | `src/features/app/hooks/useAppServerEvents.ts` | 事件路由分发 |
| 前端 | `src/features/app/components/ApprovalToasts.tsx` | 审批 UI 组件 |
| 前端 | `src/utils/approvalRules.ts` | 命令解析和匹配 |
| 前端 | `src/utils/approvalBatching.ts` | 审批批处理工具 |
| 类型 | `src/types.ts` | ApprovalRequest 等类型定义 |

---

## 十三、测试建议

### 13.1 单元测试覆盖

参考 `src-tauri/src/engine/claude/tests_path_approval.rs`：

- 路径规范化测试
- 工作空间边界测试
- 符号链接防护测试
- 嵌套目录创建测试
- 绝对路径解析测试

### 13.2 端到端测试场景

| 场景 | 预期结果 |
|------|----------|
| 默认模式下修改文件 | 弹出审批弹窗 |
| 批准文件修改 | 文件被修改，会话继续 |
| 拒绝文件修改 | 文件不变，会话结束 |
| 批量批准多个文件 | 所有文件被修改 |
| 跨工作空间路径 | 拒绝并提示越界 |
| `.git` 目录写入 | 拒绝并提示保护 |
| 符号链接目标修改 | 拒绝并提示安全限制 |
| Plan 模式下执行 git commit | 阻断并发送 modeBlocked 事件 |
| Code 模式下请求用户输入（strict-local） | 阻断并发送 modeBlocked 事件 |

### 13.3 Codex 特有测试场景

| 场景 | 预期结果 |
|------|----------|
| Plan 模式下写入文件 | 阻断并发送 modeBlocked 事件 |
| Code 模式 + strict-local profile 请求用户输入 | 阻断并发送 modeBlocked 事件 |
| 策略注入到 turn payload | CLI 正确识别并遵循策略 |
| Plan 模式下执行 git add | 阻断并发送 modeBlocked 事件 |
| 用户接受 requestUserInput | 请求从列表中移除 |
| 重复的 requestUserInput | 被去重处理 |

---

## 总结

本项目的权限审批系统具有以下特点：

1. **分层架构**：后端处理权限识别和本地应用，前端处理用户交互和状态管理
2. **安全优先**：多层安全防护确保 AI 操作在受控范围内
3. **用户体验**：支持逐条审批、批量审批、命令记忆等便捷操作
4. **会话连续性**：审批后自动恢复会话，不中断工作流
5. **历史去噪**：结构化展示审批结果，避免历史污染

这些设计原则和实现模式可以直接应用到其他 AI Agent 桌面应用中，确保用户对 AI 操作的完全控制权。