# 基于历史文件的上下文统计展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Claude Code 和 Codex 的上下文统计展示改为只读取智能体历史 JSONL 文件的最后一条有效 usage，实时成功结束和历史加载共用同一刷新链路。

**Architecture:** Rust/Tauri agent 层新增统一历史 usage 查询命令，按 agent kind 使用 Claude/Codex 两个解析策略。前端 store 只通过该命令刷新 `tokenUsageBySession`，composer 和消息 footer 只消费这份 session 快照；旧的 result/assistant usage、`/context`、`context_window`、事件扫描推断都不再参与最终展示。

**Tech Stack:** Tauri 2、Rust、React、Zustand、TypeScript、Vitest、Cargo test。

---

## 文件结构

- Create: `src-tauri/src/agent/context_usage.rs`
  - 负责 `ThreadTokenUsageSnapshot` 数据结构、Claude/Codex JSONL usage 解析、纯函数测试。
- Modify: `src-tauri/src/agent/mod.rs`
  - 导出 `context_usage` 模块。
- Modify: `src-tauri/src/agent/commands.rs`
  - 新增 `load_agent_latest_token_usage` Tauri 命令，复用现有 session mapping 和 JSONL 定位函数。
- Modify: `src-tauri/src/lib.rs`
  - 注册新 Tauri 命令。
- Modify: `src/lib/tauri.ts`
  - agent API 增加 `loadLatestTokenUsage(appSessionId, agentKind)`。
- Modify: `src/components/agent/contextUsage.ts`
  - 收敛为历史 usage 快照归一化和 view model 构建；删除事件扫描 fallback。
- Modify: `src/stores/agentStore.ts`
  - 增加 `refreshLatestTokenUsage` 和刷新 request id；成功 result、历史加载后触发刷新；删除旧 usage 写入链路。
- Modify: `src/components/agent/assistant-ui/CodeMuxComposer.tsx`
  - 只从 `tokenUsageBySession` 构建上下文显示，无 usage 时不渲染。
- Modify: `src/components/agent/assistant-ui/CodeMuxThread.tsx`
  - footer token stats 从 session usage 派生，不再从 result/synthetic result usage 派生。
- Modify: `src/components/assistant-ui/message-footer.tsx`
  - 保持输入、缓存、输出展示能力；不展示 reasoning。
- Modify: `src/stores/agentStore.test.ts`
  - 覆盖实时成功刷新、历史加载刷新、syncing、不覆盖最新请求、无历史不展示。
- Modify: `src/components/agent/AgentPanel.test.ts`
  - 替换旧事件扫描测试为纯 view model 测试。
- Modify/Delete: `src-tauri/sidecar/src/claudeContextUsage.ts`, `src-tauri/sidecar/src/claudeContextUsage.test.ts`
  - 删除上一轮 `/context` 探测实现和测试。
- Modify: `src-tauri/sidecar/src/index.ts`, `src-tauri/sidecar/src/runtimeEvents.ts`
  - 移除为展示 usage 服务的 `/context`、`context_window`、`token_usage_update` 集成；保留与 agent 正常运行无关的逻辑不动。
- Modify: `src/stores/agentEventParsing.ts`, `src/types/agent.ts`, `src/sidecarSessionHelpers.test.ts`
  - 移除旧 `token_usage_update` 展示通道相关类型和测试。

---

### Task 1: Rust 历史 usage 解析模块

**Files:**
- Create: `src-tauri/src/agent/context_usage.rs`
- Modify: `src-tauri/src/agent/mod.rs`

- [ ] **Step 1: 写失败测试**

Create `src-tauri/src/agent/context_usage.rs` with the tests first:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageBreakdown {
    pub total_tokens: u64,
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTokenUsageSnapshot {
    pub total: TokenUsageBreakdown,
    pub last: TokenUsageBreakdown,
    pub model_context_window: Option<u64>,
    pub context_usage_source: String,
    pub context_usage_freshness: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_uses_latest_assistant_message_usage_and_counts_input_plus_cache() {
        let values = vec![
            json!({
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "usage": {
                        "input_tokens": 100,
                        "cache_read_input_tokens": 20,
                        "output_tokens": 9
                    }
                }
            }),
            json!({
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "usage": {
                        "input_tokens": 352,
                        "cache_read_input_tokens": 25088,
                        "output_tokens": 152
                    }
                }
            })
        ];

        let snapshot = latest_claude_usage_from_values(&values, "restored")
            .expect("latest Claude usage should be found");

        assert_eq!(snapshot.last.input_tokens, 352);
        assert_eq!(snapshot.last.cached_input_tokens, 25_088);
        assert_eq!(snapshot.last.output_tokens, 152);
        assert_eq!(snapshot.last.total_tokens, 25_440);
        assert_eq!(snapshot.context_usage_source, "history_file");
        assert_eq!(snapshot.context_usage_freshness, "restored");
    }

    #[test]
    fn claude_ignores_sidechain_and_non_assistant_usage() {
        let values = vec![
            json!({
                "type": "assistant",
                "isSidechain": true,
                "message": {
                    "role": "assistant",
                    "usage": {
                        "input_tokens": 900,
                        "cache_read_input_tokens": 900,
                        "output_tokens": 900
                    }
                }
            }),
            json!({
                "type": "user",
                "message": {
                    "role": "user",
                    "usage": {
                        "input_tokens": 1,
                        "cache_read_input_tokens": 1,
                        "output_tokens": 1
                    }
                }
            })
        ];

        assert_eq!(latest_claude_usage_from_values(&values, "restored"), None);
    }

    #[test]
    fn codex_uses_latest_token_count_total_tokens_and_cache_detail() {
        let values = vec![
            json!({
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "last_token_usage": {
                            "input_tokens": 100,
                            "cached_input_tokens": 80,
                            "output_tokens": 10,
                            "reasoning_output_tokens": 999,
                            "total_tokens": 110
                        },
                        "model_context_window": 258400
                    }
                }
            }),
            json!({
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "last_token_usage": {
                            "input_tokens": 154933,
                            "cached_input_tokens": 148864,
                            "output_tokens": 1128,
                            "reasoning_output_tokens": 666,
                            "total_tokens": 156061
                        },
                        "model_context_window": 258400
                    }
                }
            })
        ];

        let snapshot = latest_codex_usage_from_values(&values, "live_synced")
            .expect("latest Codex usage should be found");

        assert_eq!(snapshot.last.input_tokens, 154_933);
        assert_eq!(snapshot.last.cached_input_tokens, 148_864);
        assert_eq!(snapshot.last.output_tokens, 1_128);
        assert_eq!(snapshot.last.reasoning_output_tokens, 0);
        assert_eq!(snapshot.last.total_tokens, 156_061);
        assert_eq!(snapshot.model_context_window, Some(258_400));
        assert_eq!(snapshot.context_usage_source, "history_file");
        assert_eq!(snapshot.context_usage_freshness, "live_synced");
    }

    #[test]
    fn codex_falls_back_to_input_plus_output_when_total_tokens_is_missing() {
        let values = vec![json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "last_token_usage": {
                        "input_tokens": 20,
                        "cached_input_tokens": 7,
                        "output_tokens": 5,
                        "reasoning_output_tokens": 999
                    }
                }
            }
        })];

        let snapshot = latest_codex_usage_from_values(&values, "restored")
            .expect("fallback Codex usage should be found");

        assert_eq!(snapshot.last.total_tokens, 25);
        assert_eq!(snapshot.last.reasoning_output_tokens, 0);
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd src-tauri
cargo test agent::context_usage --lib
```

Expected: FAIL because `latest_claude_usage_from_values` and `latest_codex_usage_from_values` are not implemented or module is not exported.

- [ ] **Step 3: 导出模块**

Modify `src-tauri/src/agent/mod.rs`:

```rust
pub mod commands;
pub mod context_usage;
```

- [ ] **Step 4: 实现解析函数**

Append this implementation above the test module in `src-tauri/src/agent/context_usage.rs`:

```rust
pub fn latest_claude_usage_from_values(
    values: &[serde_json::Value],
    freshness: &str,
) -> Option<ThreadTokenUsageSnapshot> {
    for value in values.iter().rev() {
        if value
            .get("isSidechain")
            .and_then(|entry| entry.as_bool())
            .unwrap_or(false)
        {
            continue;
        }
        if value.get("type").and_then(|entry| entry.as_str()) != Some("assistant") {
            continue;
        }
        let message = value.get("message")?;
        if message.get("role").and_then(|entry| entry.as_str()) != Some("assistant") {
            continue;
        }
        let Some(usage) = message.get("usage") else {
            continue;
        };
        let input = read_u64(usage.get("input_tokens"));
        let cached = read_u64(usage.get("cache_read_input_tokens"));
        let output = read_u64(usage.get("output_tokens"));
        if input == 0 && cached == 0 && output == 0 {
            continue;
        }
        let total = input.saturating_add(cached);
        return Some(snapshot(
            total,
            input,
            cached,
            output,
            None,
            freshness,
        ));
    }
    None
}

pub fn latest_codex_usage_from_values(
    values: &[serde_json::Value],
    freshness: &str,
) -> Option<ThreadTokenUsageSnapshot> {
    for value in values.iter().rev() {
        if value.get("type").and_then(|entry| entry.as_str()) != Some("event_msg") {
            continue;
        }
        let Some(payload) = value.get("payload") else {
            continue;
        };
        if payload.get("type").and_then(|entry| entry.as_str()) != Some("token_count") {
            continue;
        }
        let Some(info) = payload.get("info") else {
            continue;
        };
        let Some(usage) = info.get("last_token_usage") else {
            continue;
        };
        let input = read_u64(usage.get("input_tokens"));
        let cached = read_u64(usage.get("cached_input_tokens"));
        let output = read_u64(usage.get("output_tokens"));
        let total = read_u64(usage.get("total_tokens"));
        let resolved_total = if total > 0 {
            total
        } else {
            input.saturating_add(output)
        };
        if resolved_total == 0 && cached == 0 {
            continue;
        }
        let model_context_window = read_u64(info.get("model_context_window"));
        return Some(snapshot(
            resolved_total,
            input,
            cached,
            output,
            (model_context_window > 0).then_some(model_context_window),
            freshness,
        ));
    }
    None
}

fn snapshot(
    total_tokens: u64,
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    model_context_window: Option<u64>,
    freshness: &str,
) -> ThreadTokenUsageSnapshot {
    let breakdown = TokenUsageBreakdown {
        total_tokens,
        input_tokens,
        cached_input_tokens,
        output_tokens,
        reasoning_output_tokens: 0,
    };
    ThreadTokenUsageSnapshot {
        total: breakdown.clone(),
        last: breakdown,
        model_context_window,
        context_usage_source: "history_file".to_string(),
        context_usage_freshness: freshness.to_string(),
    }
}

fn read_u64(value: Option<&serde_json::Value>) -> u64 {
    match value {
        Some(serde_json::Value::Number(number)) => number.as_u64().unwrap_or(0),
        Some(serde_json::Value::String(text)) => text.parse::<u64>().unwrap_or(0),
        _ => 0,
    }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run:

```bash
cd src-tauri
cargo test agent::context_usage --lib
```

Expected: PASS.

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/agent/mod.rs src-tauri/src/agent/context_usage.rs
git commit -m "feat(agent): 增加历史文件上下文统计解析"
```

---

### Task 2: Tauri 统一 usage 查询命令

**Files:**
- Modify: `src-tauri/src/agent/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 写失败测试**

In `src-tauri/src/agent/commands.rs`, inside the existing `#[cfg(test)] mod tests`, add:

```rust
#[test]
fn loads_latest_claude_token_usage_from_agent_session_file() {
    let temp = tempfile::tempdir().expect("tempdir");
    let home = temp.path();
    let project_dir = home.join(".claude").join("projects").join("d--project");
    std::fs::create_dir_all(&project_dir).expect("project dir");
    let session_file = project_dir.join("claude-session-1.jsonl");
    std::fs::write(
        &session_file,
        r#"{"type":"assistant","message":{"role":"assistant","usage":{"input_tokens":10,"cache_read_input_tokens":20,"output_tokens":3}}}
{"type":"assistant","message":{"role":"assistant","usage":{"input_tokens":30,"cache_read_input_tokens":40,"output_tokens":5}}}
"#,
    )
    .expect("write session file");

    let usage = load_latest_token_usage_for_agent_session(
        home,
        AgentKind::ClaudeCode,
        "claude-session-1",
        "restored",
    )
    .expect("load should not fail")
    .expect("usage should exist");

    assert_eq!(usage.last.total_tokens, 70);
    assert_eq!(usage.last.input_tokens, 30);
    assert_eq!(usage.last.cached_input_tokens, 40);
    assert_eq!(usage.last.output_tokens, 5);
}

#[test]
fn loads_latest_codex_token_usage_from_agent_session_file() {
    let temp = tempfile::tempdir().expect("tempdir");
    let home = temp.path();
    let sessions_dir = home.join(".codex").join("sessions").join("2026").join("07").join("11");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let session_file = sessions_dir.join("rollout.jsonl");
    std::fs::write(
        &session_file,
        r#"{"type":"session_meta","payload":{"id":"codex-session-1"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":20,"cached_input_tokens":7,"output_tokens":5},"model_context_window":258400}}}
"#,
    )
    .expect("write session file");

    let usage = load_latest_token_usage_for_agent_session(
        home,
        AgentKind::Codex,
        "codex-session-1",
        "live_synced",
    )
    .expect("load should not fail")
    .expect("usage should exist");

    assert_eq!(usage.last.total_tokens, 25);
    assert_eq!(usage.last.cached_input_tokens, 7);
    assert_eq!(usage.model_context_window, Some(258_400));
}
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd src-tauri
cargo test agent::commands::tests::loads_latest --lib
```

Expected: FAIL because `load_latest_token_usage_for_agent_session` does not exist.

- [ ] **Step 3: 在 commands.rs 接入解析模块**

Near the top of `src-tauri/src/agent/commands.rs`, add:

```rust
use super::context_usage::{
    latest_claude_usage_from_values, latest_codex_usage_from_values, ThreadTokenUsageSnapshot,
};
```

Add this helper near `load_codex_session_events`:

```rust
fn load_latest_token_usage_for_agent_session(
    home: &Path,
    agent_kind: AgentKind,
    agent_session_id: &str,
    freshness: &str,
) -> Result<Option<ThreadTokenUsageSnapshot>, String> {
    let history_path = match agent_kind {
        AgentKind::ClaudeCode => {
            find_claude_session_jsonl(&home.join(".claude"), agent_session_id)
        }
        AgentKind::Codex => {
            find_codex_session_jsonl(&home.join(".codex").join("sessions"), agent_session_id)
        }
        AgentKind::GeminiCli | AgentKind::Opencode => None,
    };
    let Some(history_path) = history_path else {
        return Ok(None);
    };

    let values = read_json_stream_values(&history_path)?;
    let snapshot = match agent_kind {
        AgentKind::ClaudeCode => latest_claude_usage_from_values(&values, freshness),
        AgentKind::Codex => latest_codex_usage_from_values(&values, freshness),
        AgentKind::GeminiCli | AgentKind::Opencode => None,
    };
    Ok(snapshot)
}
```

Add the Tauri command:

```rust
#[tauri::command]
pub async fn load_agent_latest_token_usage(
    state: State<'_, crate::AppState>,
    app_session_id: String,
    agent_kind: String,
    freshness: Option<String>,
) -> Result<Option<ThreadTokenUsageSnapshot>, String> {
    let agent_kind = AgentKind::from_str(&agent_kind)?;
    let Some(agent_session_id) = get_agent_session_id(state.inner(), &app_session_id, agent_kind)? else {
        return Ok(None);
    };
    let home = home_dir()?;
    let freshness = freshness.unwrap_or_else(|| "restored".to_string());

    tokio::task::spawn_blocking(move || {
        load_latest_token_usage_for_agent_session(
            &home,
            agent_kind,
            &agent_session_id,
            &freshness,
        )
    })
    .await
    .map_err(|err| format!("Failed to join token usage loader: {}", err))?
}
```

- [ ] **Step 4: 注册 Tauri 命令**

Modify `src-tauri/src/lib.rs` command list to include:

```rust
agent::commands::load_agent_latest_token_usage,
```

Place it next to `load_claude_session_events` and `load_codex_session_events`.

- [ ] **Step 5: 运行测试确认通过**

Run:

```bash
cd src-tauri
cargo test agent::commands::tests::loads_latest --lib
```

Expected: PASS.

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/agent/commands.rs src-tauri/src/lib.rs
git commit -m "feat(agent): 暴露历史文件上下文统计查询命令"
```

---

### Task 3: 前端 API 与上下文 view model 收敛

**Files:**
- Modify: `src/lib/tauri.ts`
- Modify: `src/components/agent/contextUsage.ts`
- Modify: `src/components/agent/AgentPanel.test.ts`

- [ ] **Step 1: 写失败测试**

Replace event-scanning focused tests in `src/components/agent/AgentPanel.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';

import { buildContextUsageViewModel, normalizeThreadTokenUsage } from './contextUsage';

describe('history-file context usage view model', () => {
  it('uses snapshot totalTokens as used tokens and keeps cache as detail', () => {
    const tokenUsage = normalizeThreadTokenUsage({
      total: {
        totalTokens: 25_440,
        inputTokens: 352,
        cachedInputTokens: 25_088,
        outputTokens: 152,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: 25_440,
        inputTokens: 352,
        cachedInputTokens: 25_088,
        outputTokens: 152,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 258_400,
      contextUsageSource: 'history_file',
      contextUsageFreshness: 'restored',
    });

    expect(buildContextUsageViewModel({
      tokenUsage,
      model: 'claude-sonnet-4-20250514',
      sessionProviderUsesLargeContext: false,
      activeProviderUsesLargeContext: false,
    })).toEqual({
      usedTokens: 25_440,
      totalTokens: 258_400,
      inputTokens: 352,
      cachedTokens: 25_088,
      outputTokens: 152,
    });
  });

  it('returns null when no history-file snapshot exists', () => {
    expect(buildContextUsageViewModel({
      tokenUsage: null,
      model: 'claude-sonnet-4-20250514',
      sessionProviderUsesLargeContext: false,
      activeProviderUsesLargeContext: false,
    })).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
npx vitest run src/components/agent/AgentPanel.test.ts
```

Expected: FAIL because `buildContextUsageViewModel` still requires `events` and falls back to event scanning.

- [ ] **Step 3: 增加 Tauri API**

In `src/lib/tauri.ts`, add the agent API method:

```ts
loadLatestTokenUsage: (
  appSessionId: string,
  agentKind: AgentKind,
  freshness?: string,
): Promise<Record<string, unknown> | null> =>
  invokeLogged('load_agent_latest_token_usage', { appSessionId, agentKind, freshness }),
```

Place it near `loadClaudeSessionEvents` and `loadCodexSessionEvents`.

- [ ] **Step 4: 收敛 contextUsage.ts**

Replace `buildContextUsageViewModel` with this signature and behavior:

```ts
export function buildContextUsageViewModel({
  tokenUsage,
  model,
  sessionProviderUsesLargeContext,
  activeProviderUsesLargeContext,
}: {
  tokenUsage?: ThreadTokenUsage | null;
  model?: string | null;
  sessionProviderUsesLargeContext: boolean;
  activeProviderUsesLargeContext: boolean;
}): ContextUsage | null {
  if (!tokenUsage) {
    return null;
  }

  const inputTokens = Math.max(tokenUsage.last.inputTokens, 0);
  const cachedTokens = Math.max(tokenUsage.last.cachedInputTokens, 0);
  const outputTokens = Math.max(tokenUsage.last.outputTokens, 0);
  const usedTokens = Math.max(tokenUsage.last.totalTokens, 0);
  const modelContextWindow = tokenUsage.modelContextWindow ?? undefined;
  const totalTokens = getSessionContextLimit({
    model,
    sessionProviderUsesLargeContext,
    activeProviderUsesLargeContext,
    modelContextWindow,
  });

  if (usedTokens <= 0 || totalTokens <= 0) {
    return null;
  }

  return {
    usedTokens,
    totalTokens,
    inputTokens,
    cachedTokens,
    outputTokens,
  };
}
```

Delete runtime exports and helpers that only support event scanning:

```ts
extractThreadTokenUsageFromEvent
resolveLatestThreadTokenUsageFromEvents
computeContextUsageFromEvents
findLastResultIndex
findPreviousResultIndex
readResultUsage
findLastClaudeAssistantUsage
findLastMessageWithUsage
readTokenUsage
hasThinkingContentOnly
```

Keep `normalizeThreadTokenUsage`, `ThreadTokenUsage`, `ContextUsage`, `TokenUsageBreakdown`, and `getSessionContextLimit`.

- [ ] **Step 5: 运行测试确认通过**

Run:

```bash
npx vitest run src/components/agent/AgentPanel.test.ts
```

Expected: PASS.

- [ ] **Step 6: 提交**

```bash
git add src/lib/tauri.ts src/components/agent/contextUsage.ts src/components/agent/AgentPanel.test.ts
git commit -m "refactor(agent): 收敛上下文统计视图模型"
```

---

### Task 4: Store 刷新链路与旧写入链路删除

**Files:**
- Modify: `src/stores/agentStore.ts`
- Modify: `src/stores/agentStore.test.ts`

- [ ] **Step 1: 更新 mock 并写失败测试**

In `src/stores/agentStore.test.ts`, add this mock:

```ts
const loadLatestTokenUsageMock = vi.fn<
  (appSessionId: string, agentKind: string, freshness?: string) => Promise<Record<string, unknown> | null>
>();
```

Add it to `agentApi`:

```ts
loadLatestTokenUsage: loadLatestTokenUsageMock,
```

Add tests:

```ts
it('refreshes Claude usage from history after a successful result and ignores result usage', async () => {
  loadLatestTokenUsageMock.mockResolvedValueOnce({
    total: { totalTokens: 25_440, inputTokens: 352, cachedInputTokens: 25_088, outputTokens: 152, reasoningOutputTokens: 0 },
    last: { totalTokens: 25_440, inputTokens: 352, cachedInputTokens: 25_088, outputTokens: 152, reasoningOutputTokens: 0 },
    modelContextWindow: 258_400,
    contextUsageSource: 'history_file',
    contextUsageFreshness: 'live_synced',
  });
  startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
    onEvent(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      uuid: 'result-with-wrong-usage',
      session_id: sessionId,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result: '',
      usage: { input_tokens: 999_999, cache_read_input_tokens: 0, output_tokens: 1 },
    }));
  });

  const { useAgentStore } = await import('./agentStore');
  const session = await primeSession('claude_code');

  await useAgentStore.getState().startQuery(session.id, 'hello', 'D:\\project\\ai-code\\codeMUX');
  await vi.waitFor(() => {
    expect(loadLatestTokenUsageMock).toHaveBeenCalledWith(session.id, 'claude_code', 'live_synced');
  });

  expect(useAgentStore.getState().tokenUsageBySession[session.id]).toMatchObject({
    last: { totalTokens: 25_440, inputTokens: 352, cachedInputTokens: 25_088, outputTokens: 152 },
    contextUsageSource: 'history_file',
    contextUsageFreshness: 'live_synced',
  });
});

it('does not refresh usage for failed results', async () => {
  startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
    onEvent(JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      uuid: 'failed-result',
      session_id: sessionId,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result: 'failed',
    }));
  });

  const { useAgentStore } = await import('./agentStore');
  const session = await primeSession('claude_code');

  await useAgentStore.getState().startQuery(session.id, 'hello', 'D:\\project\\ai-code\\codeMUX');

  expect(loadLatestTokenUsageMock).not.toHaveBeenCalled();
  expect(useAgentStore.getState().tokenUsageBySession[session.id]).toBeUndefined();
});

it('keeps existing usage while syncing and ignores stale refresh responses', async () => {
  let resolveFirst: (value: Record<string, unknown> | null) => void = () => {};
  let resolveSecond: (value: Record<string, unknown> | null) => void = () => {};
  loadLatestTokenUsageMock
    .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
    .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve; }));

  const { useAgentStore } = await import('./agentStore');
  const session = await primeSession('codex');
  useAgentStore.getState().setSessionTokenUsage(session.id, {
    total: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 0 },
    last: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 0 },
    modelContextWindow: 258_400,
    contextUsageSource: 'history_file',
    contextUsageFreshness: 'restored',
  });

  const first = useAgentStore.getState().refreshLatestTokenUsage(session.id, 'live_synced');
  const second = useAgentStore.getState().refreshLatestTokenUsage(session.id, 'live_synced');

  expect(useAgentStore.getState().tokenUsageBySession[session.id]).toMatchObject({
    last: { totalTokens: 100 },
    contextUsageFreshness: 'syncing',
  });

  resolveSecond({
    total: { totalTokens: 200, inputTokens: 180, cachedInputTokens: 70, outputTokens: 20, reasoningOutputTokens: 0 },
    last: { totalTokens: 200, inputTokens: 180, cachedInputTokens: 70, outputTokens: 20, reasoningOutputTokens: 0 },
    modelContextWindow: 258_400,
    contextUsageSource: 'history_file',
    contextUsageFreshness: 'live_synced',
  });
  await second;

  resolveFirst({
    total: { totalTokens: 150, inputTokens: 140, cachedInputTokens: 60, outputTokens: 10, reasoningOutputTokens: 0 },
    last: { totalTokens: 150, inputTokens: 140, cachedInputTokens: 60, outputTokens: 10, reasoningOutputTokens: 0 },
    modelContextWindow: 258_400,
    contextUsageSource: 'history_file',
    contextUsageFreshness: 'live_synced',
  });
  await first;

  expect(useAgentStore.getState().tokenUsageBySession[session.id]).toMatchObject({
    last: { totalTokens: 200 },
  });
});

it('refreshes usage after loading historical messages', async () => {
  loadClaudeSessionEventsMock.mockResolvedValueOnce([
    { type: 'assistant', timestamp: '2026-07-11T00:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'history' }] } },
  ]);
  loadLatestTokenUsageMock.mockResolvedValueOnce({
    total: { totalTokens: 90, inputTokens: 40, cachedInputTokens: 50, outputTokens: 5, reasoningOutputTokens: 0 },
    last: { totalTokens: 90, inputTokens: 40, cachedInputTokens: 50, outputTokens: 5, reasoningOutputTokens: 0 },
    modelContextWindow: 258_400,
    contextUsageSource: 'history_file',
    contextUsageFreshness: 'restored',
  });

  const { useAgentStore } = await import('./agentStore');
  const session = await primeSession('claude_code');

  await useAgentStore.getState().loadSessionMessages(session.id);

  expect(loadLatestTokenUsageMock).toHaveBeenCalledWith(session.id, 'claude_code', 'restored');
  expect(useAgentStore.getState().tokenUsageBySession[session.id]).toMatchObject({
    last: { totalTokens: 90 },
    contextUsageFreshness: 'restored',
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
npx vitest run src/stores/agentStore.test.ts --testNamePattern "usage|syncing|historical"
```

Expected: FAIL because `refreshLatestTokenUsage` is not implemented and old result usage still writes into state.

- [ ] **Step 3: 扩展 AgentState**

In `src/stores/agentStore.ts`, add state and action:

```ts
tokenUsageRefreshRequests: Record<string, number>;
refreshLatestTokenUsage: (sessionId: string, freshness: 'live_synced' | 'restored') => Promise<void>;
```

Initialize:

```ts
tokenUsageRefreshRequests: {},
```

Clear it in `clearEvents` and session reset paths alongside `tokenUsageBySession`.

- [ ] **Step 4: 实现 refreshLatestTokenUsage**

Add this action in the store:

```ts
refreshLatestTokenUsage: async (sessionId, freshness) => {
  const agentKind = getSessionAgentKind(sessionId) ?? 'claude_code';
  const requestId = Date.now() + Math.random();

  set((state) => {
    const existing = state.tokenUsageBySession[sessionId] ?? null;
    return {
      tokenUsageRefreshRequests: {
        ...state.tokenUsageRefreshRequests,
        [sessionId]: requestId,
      },
      tokenUsageBySession: existing
        ? {
            ...state.tokenUsageBySession,
            [sessionId]: {
              ...existing,
              contextUsageFreshness: 'syncing',
            },
          }
        : state.tokenUsageBySession,
    };
  });

  try {
    const rawUsage = await agentApi.loadLatestTokenUsage(sessionId, agentKind, freshness);
    const normalized = rawUsage ? normalizeThreadTokenUsage(rawUsage) : null;
    set((state) => {
      if (state.tokenUsageRefreshRequests[sessionId] !== requestId) {
        return {};
      }
      return {
        tokenUsageBySession: {
          ...state.tokenUsageBySession,
          [sessionId]: normalized,
        },
      };
    });
  } catch (error) {
    logger.warn('Failed to refresh latest token usage from history file', {
      sessionId,
      agentKind,
      freshness,
    }, serializeError(error));
  }
},
```

- [ ] **Step 5: 接入实时成功 result**

In the terminal event handling block, after a successful non-error `result` has been processed and running state is cleared, call:

```ts
if (event.kind === 'result' && !event.data?.is_error) {
  void get().refreshLatestTokenUsage(sessionId, 'live_synced');
}
```

Remove the `eventTokenUsage` extraction and this old write:

```ts
tokenUsageBySession: {
  ...s.tokenUsageBySession,
  [sessionId]: eventTokenUsage ?? null,
}
```

Remove token usage update handling that writes `tokenUsageBySession` from `event.kind === 'token_usage'`.

- [ ] **Step 6: 接入历史加载**

After `loadSessionMessages` sets `events` and `eventTimestamps`, call:

```ts
await get().refreshLatestTokenUsage(sessionId, 'restored');
```

Remove `resolveLatestThreadTokenUsageFromEvents(events, 'restored')` and its write to `tokenUsageBySession`.

- [ ] **Step 7: 运行测试确认通过**

Run:

```bash
npx vitest run src/stores/agentStore.test.ts
```

Expected: PASS.

- [ ] **Step 8: 提交**

```bash
git add src/stores/agentStore.ts src/stores/agentStore.test.ts
git commit -m "refactor(agent): 统一从历史文件刷新上下文统计"
```

---

### Task 5: Composer 与 footer 只消费 session usage

**Files:**
- Modify: `src/components/agent/assistant-ui/CodeMuxComposer.tsx`
- Modify: `src/components/agent/assistant-ui/CodeMuxThread.tsx`
- Modify: `src/components/assistant-ui/message-footer.tsx`

- [ ] **Step 1: 写失败测试或组件断言**

If existing component tests do not mount these components directly, add focused pure helper tests in `src/components/agent/AgentPanel.test.ts`:

```ts
import { buildFooterStatsFromTokenUsage } from './assistant-ui/CodeMuxThread';

it('builds footer stats from session token usage without reasoning', () => {
  expect(buildFooterStatsFromTokenUsage({
    total: { totalTokens: 156_061, inputTokens: 154_933, cachedInputTokens: 148_864, outputTokens: 1_128, reasoningOutputTokens: 0 },
    last: { totalTokens: 156_061, inputTokens: 154_933, cachedInputTokens: 148_864, outputTokens: 1_128, reasoningOutputTokens: 0 },
    modelContextWindow: 258_400,
    contextUsageSource: 'history_file',
    contextUsageFreshness: 'live_synced',
  })).toMatchObject({
    inputTokens: 154_933,
    cacheReadTokens: 148_864,
    outputTokens: 1_128,
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
npx vitest run src/components/agent/AgentPanel.test.ts --testNamePattern "footer stats"
```

Expected: FAIL because `buildFooterStatsFromTokenUsage` is not exported.

- [ ] **Step 3: Composer 不再传 events fallback**

In `CodeMuxComposer.tsx`, call:

```tsx
const contextUsage = useMemo(() => buildContextUsageViewModel({
  tokenUsage,
  model: modelName,
  sessionProviderUsesLargeContext: false,
  activeProviderUsesLargeContext: false,
}), [tokenUsage, modelName]);
```

Render `ContextDisplay` only when `contextUsage` is not null:

```tsx
{contextUsage ? (
  <ContextDisplay
    usedTokens={contextUsage.usedTokens}
    totalTokens={contextUsage.totalTokens}
    modelName={modelName}
    inputTokens={contextUsage.inputTokens}
    cachedTokens={contextUsage.cachedTokens}
    outputTokens={contextUsage.outputTokens}
  />
) : null}
```

- [ ] **Step 4: Footer 从 session usage 派生**

In `CodeMuxThread.tsx`, select usage:

```ts
const tokenUsage = useAgentStore((state) => state.tokenUsageBySession[sessionId] ?? null);
```

Export this helper:

```ts
export function buildFooterStatsFromTokenUsage(tokenUsage: ThreadTokenUsage | null | undefined): MessageFooterStats | undefined {
  if (!tokenUsage) {
    return undefined;
  }
  return {
    inputTokens: Math.max(tokenUsage.last.inputTokens, 0),
    outputTokens: Math.max(tokenUsage.last.outputTokens, 0),
    cacheReadTokens: Math.max(tokenUsage.last.cachedInputTokens, 0),
    cacheCreationTokens: 0,
  };
}
```

Import `ThreadTokenUsage` from `../contextUsage` or the correct relative path:

```ts
import type { ThreadTokenUsage } from '../contextUsage';
```

Replace `resultStatsByAssistantIndex` memo logic with a session snapshot mapping:

```ts
const resultStatsByAssistantIndex = useMemo(() => {
  const latestAssistantIndex = findLatestAssistantIndex(events);
  const stats = buildFooterStatsFromTokenUsage(tokenUsage);
  return latestAssistantIndex >= 0 && stats
    ? { [latestAssistantIndex]: stats }
    : {};
}, [events, tokenUsage]);
```

Add helper:

```ts
function findLatestAssistantIndex(events: AgentMessage[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].kind === 'assistant') {
      return index;
    }
  }
  return -1;
}
```

Delete `incrementAssistantResultStatsMap` and `buildAssistantResultStatsMap`.

- [ ] **Step 5: MessageFooter 不展示 reasoning**

No reasoning prop exists today. Keep `MessageFooterStats` as:

```ts
export type MessageFooterStats = {
  durationMs?: number;
  numTurns?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};
```

Do not add reasoning display.

- [ ] **Step 6: 运行测试确认通过**

Run:

```bash
npx vitest run src/components/agent/AgentPanel.test.ts
```

Expected: PASS.

- [ ] **Step 7: 提交**

```bash
git add src/components/agent/assistant-ui/CodeMuxComposer.tsx src/components/agent/assistant-ui/CodeMuxThread.tsx src/components/assistant-ui/message-footer.tsx src/components/agent/AgentPanel.test.ts
git commit -m "refactor(ui): 统一上下文统计展示来源"
```

---

### Task 6: 删除旧实时 usage 展示通道

**Files:**
- Modify: `src-tauri/sidecar/src/index.ts`
- Modify: `src-tauri/sidecar/src/runtimeEvents.ts`
- Delete: `src-tauri/sidecar/src/claudeContextUsage.ts`
- Delete: `src-tauri/sidecar/src/claudeContextUsage.test.ts`
- Modify: `src/stores/agentEventParsing.ts`
- Modify: `src/types/agent.ts`
- Modify: `src/sidecarSessionHelpers.test.ts`

- [ ] **Step 1: 写失败扫描测试**

Add a test in `src/sidecarSessionHelpers.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

it('does not keep legacy Claude context display probes in sidecar runtime', () => {
  const sidecarDir = join(process.cwd(), 'src-tauri', 'sidecar', 'src');
  const index = readFileSync(join(sidecarDir, 'index.ts'), 'utf8');
  const runtimeEvents = readFileSync(join(sidecarDir, 'runtimeEvents.ts'), 'utf8');

  expect(index).not.toContain('fetchClaudeContextCommandUsageSnapshot');
  expect(index).not.toContain('buildClaudeTokenUsageUpdateEvent');
  expect(runtimeEvents).not.toContain('buildClaudeTokenUsageUpdateEvent');
  expect(runtimeEvents).not.toContain('extractClaudeContextUsageSnapshot');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
npx vitest run src/sidecarSessionHelpers.test.ts --testNamePattern "legacy Claude context"
```

Expected: FAIL while old `/context` display probe code still exists.

- [ ] **Step 3: 删除 sidecar `/context` 展示代码**

Delete files:

```bash
git rm src-tauri/sidecar/src/claudeContextUsage.ts src-tauri/sidecar/src/claudeContextUsage.test.ts
```

In `src-tauri/sidecar/src/index.ts`, remove imports and usage of:

```ts
buildClaudeTokenUsageUpdateEvent
extractClaudeContextUsageSnapshot
ClaudeContextUsageSnapshot
fetchClaudeContextCommandUsageSnapshot
lastContextUsageSnapshot
hasAuthoritativeLiveContextUsage
emitContextCommandUsageUpdate
```

Keep assistant usage fallback only if it is needed to normalize the result event shape for chat history, but do not emit `token_usage_update`.

In `src-tauri/sidecar/src/runtimeEvents.ts`, remove:

```ts
ClaudeContextUsageSnapshot
ThreadTokenUsageSnapshot
buildClaudeTokenUsageUpdateEvent
extractClaudeContextUsageSnapshot
normalizeClaudeContextUsageFallback
buildClaudeTokenUsageSnapshot
emptyClaudeUsage
```

Make `normalizeClaudeResultEvent` return only the result event usage needed for existing chat result compatibility, without `token_usage`.

- [ ] **Step 4: 删除前端 token_usage_update 展示类型**

In `src/stores/agentEventParsing.ts`, remove `token_usage` from `ParsedStoreEvent` and remove the `msgType === 'token_usage_update'` branch.

In `src/types/agent.ts`, remove fields that were only added for the old display snapshot:

```ts
token_usage?: Record<string, unknown>;
tokenUsage?: Record<string, unknown>;
model_context_window?: number;
modelContextWindow?: number;
```

Keep these fields only if another non-display runtime path still needs them; if kept, add a code comment in `AgentResultMessage` saying they are not used for context display.

- [ ] **Step 5: 运行测试确认通过**

Run:

```bash
npx vitest run src/sidecarSessionHelpers.test.ts
cd src-tauri/sidecar && npx vitest run
```

Expected: sidecar tests pass except any pre-existing unrelated `codexCollaborationPolicy` failure already known in the workspace. If that known failure appears, record it and continue; do not change Codex collaboration policy in this task.

- [ ] **Step 6: 提交**

```bash
git add src-tauri/sidecar/src/index.ts src-tauri/sidecar/src/runtimeEvents.ts src/stores/agentEventParsing.ts src/types/agent.ts src/sidecarSessionHelpers.test.ts
git add -u src-tauri/sidecar/src/claudeContextUsage.ts src-tauri/sidecar/src/claudeContextUsage.test.ts
git commit -m "refactor(agent): 移除旧上下文统计展示通道"
```

---

### Task 7: 全链路回归与清理

**Files:**
- Modify only files touched by failing tests.

- [ ] **Step 1: 运行前端重点回归**

Run:

```bash
npx vitest run src/components/agent/AgentPanel.test.ts src/stores/agentStore.test.ts src/sidecarSessionHelpers.test.ts
```

Expected: PASS.

- [ ] **Step 2: 运行 Rust agent 测试**

Run:

```bash
cd src-tauri
cargo test agent --lib
```

Expected: PASS.

- [ ] **Step 3: 运行 TypeScript build**

Run:

```bash
npm run build
```

Expected: PASS. Vite chunk-size warnings are acceptable if there are no TypeScript errors.

- [ ] **Step 4: 运行 sidecar build**

Run:

```bash
cd src-tauri/sidecar
npm run build
```

Expected: PASS.

- [ ] **Step 5: 检查旧展示入口是否消失**

Run:

```bash
rg -n "computeContextUsageFromEvents|token_usage_update|fetchClaudeContextCommandUsageSnapshot|context_window.*tokenUsageBySession|buildClaudeTokenUsageUpdateEvent" src src-tauri/sidecar/src
```

Expected: no matches in runtime display code. Matches in archived docs or committed design docs are acceptable; matches in tests are acceptable only if the test asserts the string is absent.

- [ ] **Step 6: 空白检查**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 7: 最终提交**

If previous tasks were committed separately and this task only fixes test fallout:

```bash
git add <files fixed during regression>
git commit -m "fix(agent): 完成历史文件上下文统计回归"
```

If no files changed during this task, do not create an empty commit.

---

## 自审清单

- Spec 覆盖：Task 1-2 覆盖历史文件事实源和两种 agent 策略；Task 3-5 覆盖前端唯一展示来源；Task 6 删除旧 fallback；Task 7 覆盖验收命令。
- 口径一致：Claude 使用 `input_tokens + cache_read_input_tokens`；Codex 优先 `total_tokens`，缺失时 `input_tokens + output_tokens`；reasoning 不展示、不计算。
- 无旧 fallback：计划明确删除 result/assistant usage、`/context`、`context_window`、事件扫描对最终展示的影响。
- 性能策略：后端异步命令读取 JSONL，第一版全文件扫描保留最后有效 usage，后续可尾读优化。
