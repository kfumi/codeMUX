# OpenCode 会话产物汇总展示

## 摘要

OpenCode 在每轮对话结束后，会向其 SQLite `message` 表写入一条 summary 消息（`role: "user"`，`summary: { diffs: [...] }`），包含本轮改动的文件列表、patch、增删行数和状态。目前 CodeMUX 在加载历史消息时会**丢弃**这条消息（因为 content 为空且 role 为 user，命中 `opencode_history.rs:770` 的 `continue`）。

本计划将该 summary 消息转换为一个新的 `session_summary` 系统事件，并在前端 AI 消息末尾渲染一个可展开的「文件改动汇总」卡片。

## 现状分析

### Summary 消息格式（OpenCode 写入 SQLite）

```json
{
  "role": "user",
  "agent": "build",
  "model": { "providerID": "opencode", "modelID": "..." },
  "time": { "created": 1784364417681 },
  "summary": {
    "diffs": [{
      "file": "src/types/agentRegistry.ts",
      "patch": "Index: ...\n--- ...\n+++ ...\n@@ ...",
      "additions": 1,
      "deletions": 1,
      "status": "modified"
    }]
  }
}
```

### 当前数据流

1. **Rust** `load_opencode_events_from_connection`（[opencode\_history.rs:624](file:///d:/project/ai-code/codeMUX/src-tauri/src/agent/opencode_history.rs#L624)）读取 SQLite `message` 表
2. summary 消息 role 为 `"user"`，通过 line 656 的 role 检查
3. 但无 text part → `content` 为空 → 命中 line 770 `if content.is_empty() && role == "user" { continue; }` → **被丢弃**
4. 前端永远看不到这条消息

### 现有 compact 事件模式（参考）

compact 事件是类似的 system 事件，完整端到端流程：

1. Rust 发出 `{ type: "system", subtype: "compact_boundary", ... }`
2. [agentEventParsing.ts:354](file:///d:/project/ai-code/codeMUX/src/stores/agentEventParsing.ts#L354) `mapCompactBoundary` → `{ kind: 'compact', data }`
3. [convertAgentEvents.ts:262](file:///d:/project/ai-code/codeMUX/src/components/agent/assistant-ui/convertAgentEvents.ts#L262) `isVisibleEventKind` → `data-codemux-event` part
4. [CodeMuxMessageParts.tsx:403](file:///d:/project/ai-code/codeMUX/src/components/agent/assistant-ui/CodeMuxMessageParts.tsx#L403) `isCompactData` → 渲染分隔线

## 改动方案

### 1. Rust：检测 summary 消息并发出新事件

**文件**: [src-tauri/src/agent/opencode\_history.rs](file:///d:/project/ai-code/codeMUX/src-tauri/src/agent/opencode_history.rs)

在 `load_opencode_events_from_connection` 函数中，**在 line 770 的** **`if content.is_empty() && role == "user" { continue; }`** **之前**，插入 summary 检测逻辑：

```rust
// 在 content 为空且 role == "user" 的 continue 之前检测 summary 消息
if role == "user" && content.is_empty() {
    // 检测 OpenCode 的 session summary 消息（summary 字段为对象且包含 diffs 数组）
    if let Some(summary_obj) = message.get("summary") {
        if summary_obj.is_object() {
            if let Some(diffs) = summary_obj.get("diffs").and_then(Value::as_array) {
                if !diffs.is_empty() {
                    flush_pending_opencode_result(&mut events, &mut pending_success_result);
                    events.push(serde_json::json!({
                        "type": "system",
                        "subtype": "session_summary",
                        "diffs": diffs,
                        "uuid": format!("{}-summary", message_id),
                        "session_id": session_id,
                        "timestamp": timestamp_string(time_created),
                    }));
                }
                continue;
            }
        }
    }
    continue;
}
```

**注意**：这段逻辑替换原来的 `if content.is_empty() && role == "user" { continue; }`，在 continue 前先检测 summary。这样既处理了 summary 消息，又保留了原来跳过空 user 消息的行为。

### 2. 前端类型：新增 `session_summary` kind

**文件**: [src/stores/agentStore.ts](file:///d:/project/ai-code/codeMUX/src/stores/agentStore.ts) (line 66-87)

在 `AgentMessage` 联合类型中新增：

```typescript
| { kind: 'session_summary'; data: SessionSummaryEvent }
```

新增类型定义（放在文件中合适位置）：

```typescript
export type SessionSummaryDiff = {
  file: string;
  patch?: string;
  additions?: number;
  deletions?: number;
  status?: string; // "modified" | "added" | "deleted" | ...
};

export type SessionSummaryEvent = {
  type: string;
  subtype: string;
  diffs: SessionSummaryDiff[];
  session_id?: string;
  uuid?: string;
  timestamp?: string;
};
```

**文件**: [src/stores/agentEventParsing.ts](file:///d:/project/ai-code/codeMUX/src/stores/agentEventParsing.ts) (line 15-21)

在 `ParsedStoreEvent` 联合类型中新增：

```typescript
| { kind: 'session_summary'; data: SessionSummaryEvent }
```

（从 agentStore 导入 `SessionSummaryEvent` 类型）

### 3. 前端映射：新增 `mapSessionSummary`

**文件**: [src/stores/agentEventParsing.ts](file:///d:/project/ai-code/codeMUX/src/stores/agentEventParsing.ts)

在 `mapCompactBoundary` 函数附近新增：

```typescript
function mapSessionSummary(raw: Record<string, unknown>): ParsedStoreEvent | null {
  if (raw.type !== 'system' || raw.subtype !== 'session_summary') {
    return null;
  }
  const diffs = Array.isArray(raw.diffs) ? raw.diffs : [];
  if (diffs.length === 0) return null;
  return {
    kind: 'session_summary',
    data: raw as unknown as SessionSummaryEvent,
  };
}
```

在 `mapPersistedClaudeMessage`（line 410+）中，在 `mapCompactBoundary` 调用之后、`if (msgType === 'assistant')` 之前，插入：

```typescript
const sessionSummaryEvent = mapSessionSummary(raw);
if (sessionSummaryEvent) {
  return sessionSummaryEvent;
}
```

### 4. 前端转换：将 `session_summary` 加入可见事件

**文件**: [src/components/agent/assistant-ui/convertAgentEvents.ts](file:///d:/project/ai-code/codeMUX/src/components/agent/assistant-ui/convertAgentEvents.ts)

* line 10 `CodeMuxVisibleEventKind`：加入 `'session_summary'`

* line 48 `visibleEventKinds`：加入 `'session_summary'`

```typescript
type CodeMuxVisibleEventKind = Extract<AgentMessage['kind'], 'api_retry' | 'compact' | 'error' | 'stream_status' | 'session_summary'>;

const visibleEventKinds = ['api_retry', 'compact', 'error', 'stream_status', 'session_summary'] as const satisfies readonly CodeMuxVisibleEventKind[];
```

这样 `session_summary` 事件会被 `convertAgentEventsToAssistantMessages`（line 262）转为 `data-codemux-event` part，作为一条 `system` role 消息插入时间线，出现在 AI 消息之后、下一条 user 消息之前。

### 5. 前端渲染：文件改动汇总卡片

**文件**: [src/components/agent/assistant-ui/CodeMuxMessageParts.tsx](file:///d:/project/ai-code/codeMUX/src/components/agent/assistant-ui/CodeMuxMessageParts.tsx)

新增类型守卫和渲染组件：

```typescript
function isSessionSummaryData(value: unknown): value is { eventKind: string; event: Extract<AgentMessage, { kind: 'session_summary' }> } {
  return (
    isRecord(value) &&
    value.eventKind === 'session_summary' &&
    isRecord(value.event) &&
    value.event.kind === 'session_summary'
  );
}
```

在 `CodeMuxDataMessagePart` 函数中，在 `isCompactData` 检查之后加入 `isSessionSummaryData` 分支：

```typescript
if (isSessionSummaryData(data)) {
  return <SessionSummaryCard event={data.event} />;
}
```

新增 `SessionSummaryCard` 组件（放在同文件或新建 `SessionSummaryCard.tsx`）：

**UI 设计**（遵循用户偏好：极简、无装饰边框、通过间距和排版建立层级、绿色增/红色删）：

* **折叠态**：一行内联文本 `「3 个文件改动 · +12 −4」`，带 ChevronRight 图标

* **展开态**：文件列表，每行显示文件名（truncate）、状态标签、+增 −删

* 默认折叠

* 使用 `FileCode` 图标

* 无粗边框，用 `border-border/30` 或 `bg-muted/30` 的轻量分隔

```tsx
function SessionSummaryCard({ event }: { event: Extract<AgentMessage, { kind: 'session_summary' }> }) {
  const [expanded, setExpanded] = useState(false);
  const diffs = event.data.diffs;
  const totalAdditions = diffs.reduce((sum, d) => sum + (d.additions ?? 0), 0);
  const totalDeletions = diffs.reduce((sum, d) => sum + (d.deletions ?? 0), 0);

  return (
    <div className="my-2 rounded-lg border border-border/30 bg-muted/20 overflow-hidden">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-xs hover:bg-muted/40 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <FileCode className="h-3.5 w-3.5 text-muted-foreground/60" />
        <span className="font-medium">{diffs.length} 个文件改动</span>
        <span className="text-green-600 dark:text-green-400 tabular-nums">+{totalAdditions}</span>
        <span className="text-red-600 dark:text-red-400 tabular-nums">−{totalDeletions}</span>
      </button>
      {expanded && (
        <div className="border-t border-border/20 divide-y divide-border/10">
          {diffs.map((diff, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-xs">
              <span className="flex-1 truncate font-mono text-muted-foreground/80">{getFileName(diff.file)}</span>
              <TooltipHint content={diff.file}>
                <span className="text-muted-foreground/40 text-[10px] truncate max-w-[40%]">{diff.file}</span>
              </TooltipHint>
              {diff.status && (
                <span className="rounded border border-border/30 px-1 py-0.5 text-[10px] uppercase text-muted-foreground/60">
                  {diff.status}
                </span>
              )}
              <span className="text-green-600 dark:text-green-400 tabular-nums w-10 text-right">+{diff.additions ?? 0}</span>
              <span className="text-red-600 dark:text-red-400 tabular-nums w-10 text-right">−{diff.deletions ?? 0}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

（`getFileName` 可复用 `ToolCodeDiff.tsx` 中的实现，或从 `lib/diffStats` 中提取。）

### 6. 测试

**Rust 测试**（[opencode\_history.rs](file:///d:/project/ai-code/codeMUX/src-tauri/src/agent/opencode_history.rs) 测试区块）：
新增测试 `emits_session_summary_event_from_opencode_summary_message`：

* 插入一条 assistant 消息 + 一条 summary 消息（`role: "user"`, `summary: { diffs: [...] }`）

* 验证 events 中包含 `{ type: "system", subtype: "session_summary", diffs: [...] }`

* 验证 summary 消息本身不再产生空 user 事件

**前端测试**：

* `agentEventParsing.test.ts`：测试 `mapPersistedClaudeMessage` 对 `{ type: "system", subtype: "session_summary", diffs: [...] }` 返回 `{ kind: 'session_summary', ... }`

* `convertAgentEvents.test.ts`：测试 `session_summary` 事件被转为 `data-codemux-event` part

* `CodeMuxMessageParts.test.tsx`：测试 `SessionSummaryCard` 折叠/展开行为

## 假设与决策

1. **仅历史加载**：此功能仅在加载历史消息时生效。sidecar 不会在实时会话中转发 OpenCode 的 summary 消息（已确认 sidecar 代码中无此逻辑）。如果未来 sidecar 转发此类事件，前端渲染逻辑可复用。
2. **OpenCode 专属**：summary 消息由 OpenCode 运行时写入其 SQLite DB。Claude Code 和 Codex 无此格式。Rust 检测逻辑放在 `load_opencode_events_from_connection` 中，仅影响 OpenCode 会话。
3. **默认折叠**：卡片默认折叠，避免在多轮对话中占用过多纵向空间。用户点击展开查看文件列表。
4. **不展示 patch 内容**：展开态仅显示文件列表（路径、状态、增删数），不展示完整 patch diff（避免信息过载，且已有 ToolCodeDiff 展示单文件 diff）。
5. **位置**：summary 卡片作为独立 system 消息，出现在 AI 消息之后、下一条 user 消息之前。视觉上即是「AI 消息末尾的产物汇总」。
6. **空 diffs 跳过**：如果 `diffs` 数组为空，不发出事件（避免空卡片）。

## 验证步骤

1. `cd src-tauri && cargo test opencode_history` — 验证 Rust 测试通过
2. `cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings` — 验证 Rust 格式和 lint
3. `npx vitest run` — 验证前端测试通过
4. `npm run build` — 验证 TypeScript 编译
5. 手动验证：用 OpenCode 创建一轮有文件改动的对话，切换到其他会话再切回来（触发历史加载），确认 AI 消息末尾出现文件改动汇总卡片，可展开查看文件列表

