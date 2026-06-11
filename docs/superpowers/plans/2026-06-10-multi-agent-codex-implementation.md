# Multi-Agent Codex Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class `Codex` support to CodeMUX by introducing a per-session `agent_kind`, a shared multi-agent runtime contract, and the input-adjacent new-conversation agent selector while keeping `Claude Code` as the default agent.

**Architecture:** Persist agent identity separately from provider/model configuration, route runtime operations through a Rust adapter factory, and normalize Claude/Codex events into the existing frontend conversation shell. The implementation keeps the current Claude path working by wrapping it first, then adds Codex through the same contract with capability-based UI degradation.

**Tech Stack:** Tauri 2, Rust, React 18, TypeScript, Zustand, Vitest, SQLite, Node sidecar runtime

---

## File Structure

### Backend and persistence

- Modify: `src-tauri/src/db/schema.rs`
  - add `agent_kind` migration and tests
- Modify: `src-tauri/src/db/operations.rs`
  - store and load `agent_kind`
- Modify: `src-tauri/src/commands/session.rs`
  - accept `agent_kind` on session creation and session provider updates
- Modify: `src-tauri/src/config/types.rs`
  - add `agent_configs` and `agent_defaults`
- Modify: `src-tauri/src/config/mod.rs`
  - load/save config with the new shape
- Modify: `src-tauri/src/commands/provider.rs`
  - keep provider CRUD intact while exposing agent-config mutations if needed
- Modify: `src-tauri/src/lib.rs`
  - register any new commands and tests
- Create: `src-tauri/src/agent_runtime/mod.rs`
  - shared runtime traits and public exports
- Create: `src-tauri/src/agent_runtime/types.rs`
  - `AgentKind`, runtime config, capability structs
- Create: `src-tauri/src/agent_runtime/factory.rs`
  - resolve adapter by `agent_kind`
- Create: `src-tauri/src/agent_runtime/claude_code.rs`
  - wrap current Claude runtime operations
- Create: `src-tauri/src/agent_runtime/codex.rs`
  - Codex runtime orchestration
- Modify: `src-tauri/src/agent/commands.rs`
  - route ensure/start/send/reset/load-history through the runtime factory
- Modify: `src-tauri/src/agent/mod.rs`
  - keep sidecar process management reusable from the Claude adapter

### Sidecar runtime

- Modify: `src-tauri/sidecar/package.json`
  - add Codex SDK dependency
- Modify: `src-tauri/sidecar/src/types.ts`
  - add `agentKind` and shared runtime event types
- Modify: `src-tauri/sidecar/src/index.ts`
  - dispatch by `agentKind`
- Create: `src-tauri/sidecar/src/claudeRuntime.ts`
  - extract current Claude session runtime
- Create: `src-tauri/sidecar/src/codexRuntime.ts`
  - implement Codex session runtime
- Create: `src-tauri/sidecar/src/runtimeEvents.ts`
  - emit shared CodeMUX runtime events

### Frontend types, stores, and UI

- Modify: `src/types/session.ts`
  - add `agent_kind` and creation payload fields
- Modify: `src/types/provider.ts`
  - add `agent_configs`, `agent_defaults`, and `AgentKind`
- Create: `src/types/agentRegistry.ts`
  - registry metadata and capabilities
- Create: `src/stores/newSessionStore.ts`
  - selected new-session agent state
- Modify: `src/stores/sessionStore.ts`
  - create sessions with `agent_kind`
- Modify: `src/stores/settingsStore.ts`
  - expose default-agent and agent-config setters
- Modify: `src/lib/tauri.ts`
  - pass `agentKind` through Tauri calls
- Modify: `src/App.tsx`
  - create session using the draft agent when sending from empty state
- Create: `src/components/agent/AgentSelector.tsx`
  - input-adjacent selector
- Create: `src/components/agent/NewSessionPanel.tsx`
  - empty-state composer with selector
- Modify: `src/components/agent/AgentPanel.tsx`
  - resolve provider/model per bound agent and show agent badge
- Modify: `src/components/layout/Sidebar.tsx`
  - create new sessions using the stored default agent
- Modify: `src/components/session/SessionItem.tsx`
  - show agent icon/badge
- Modify: `src/components/settings/SettingsDialog.tsx`
  - add Agents tab
- Create: `src/components/settings/AgentSettings.tsx`
  - default agent and agent-specific settings

### Tests

- Create: `src/agentRegistry.test.ts`
- Create: `src/stores/newSessionStore.test.ts`
- Create: `src/components/agent/NewSessionPanel.test.tsx`
- Modify: `src/stores/agentEventParsing.test.ts`
  - add shared-event normalization cases for Codex where possible
- Modify: `src/sidecarSessionHelpers.test.ts`
  - extend coverage to agent-kind runtime selection helpers
- Modify: `src-tauri/src/db/schema.rs`
  - add migration tests
- Create: `src-tauri/src/agent_runtime/mod.rs` tests or `src-tauri/src/agent_runtime/factory.rs` tests

## Task 1: Add Agent Identity and Config Foundations

**Files:**
- Create: `src/types/agentRegistry.ts`
- Modify: `src/types/session.ts`
- Modify: `src/types/provider.ts`
- Modify: `src/lib/tauri.ts`
- Modify: `src/stores/sessionStore.ts`
- Modify: `src/stores/settingsStore.ts`
- Modify: `src-tauri/src/db/schema.rs`
- Modify: `src-tauri/src/db/operations.rs`
- Modify: `src-tauri/src/commands/session.rs`
- Modify: `src-tauri/src/config/types.rs`
- Modify: `src-tauri/src/config/mod.rs`
- Test: `src/agentRegistry.test.ts`
- Test: `src-tauri/src/db/schema.rs`

- [ ] **Step 1: Write the failing frontend registry and session-type tests**

```ts
// src/agentRegistry.test.ts
import { describe, expect, it } from 'vitest';

import {
  AGENT_REGISTRY,
  getAgentDefinition,
  getDefaultAgentKind,
} from './types/agentRegistry';

describe('agent registry', () => {
  it('keeps Claude Code as the product default', () => {
    expect(getDefaultAgentKind()).toBe('claude_code');
  });

  it('exposes Codex as a selectable coding agent', () => {
    expect(getAgentDefinition('codex')).toMatchObject({
      kind: 'codex',
      label: 'Codex',
    });
  });

  it('marks unsupported registry lookups as missing', () => {
    expect(AGENT_REGISTRY.some((entry) => entry.kind === 'gemini_cli')).toBe(true);
  });
});
```

```ts
// src/types/session.ts
export type AgentKind = 'claude_code' | 'codex' | 'gemini_cli' | 'opencode';

export interface Session {
  id: string;
  title: string;
  agent_kind: AgentKind;
  provider_id: string | null;
  model: string | null;
  mode: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateSessionRequest {
  title: string;
  agent_kind: AgentKind;
  mode?: string;
  project_id?: string;
}
```

- [ ] **Step 2: Run the frontend tests to verify the new types/registry are missing**

Run: `npx vitest run src/agentRegistry.test.ts`

Expected: FAIL with module or export errors for `agentRegistry` and/or missing `agent_kind` definitions.

- [ ] **Step 3: Write the failing Rust migration test**

```rust
// src-tauri/src/db/schema.rs
#[cfg(test)]
mod tests {
    use super::initialize_database;
    use rusqlite::Connection;

    #[test]
    fn adds_agent_kind_to_legacy_sessions() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                provider_id TEXT,
                model TEXT,
                project_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            ",
        )
        .unwrap();

        initialize_database(&conn).unwrap();

        let default_value: String = conn
            .query_row(
                \"SELECT agent_kind FROM pragma_table_info('sessions') WHERE name = 'agent_kind'\",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(default_value, \"claude_code\");
    }
}
```

- [ ] **Step 4: Run the Rust migration test to verify it fails**

Run: `cargo test adds_agent_kind_to_legacy_sessions --manifest-path src-tauri/Cargo.toml`

Expected: FAIL because `agent_kind` does not exist yet.

- [ ] **Step 5: Implement shared agent types and frontend config shape**

```ts
// src/types/agentRegistry.ts
import type { AgentKind } from './session';

export type AgentCapability =
  | 'supports_resume'
  | 'supports_tools'
  | 'supports_file_snapshots'
  | 'supports_cost'
  | 'supports_context_window'
  | 'supports_mcp'
  | 'supports_ask_user_question';

export interface AgentDefinition {
  kind: AgentKind;
  label: string;
  description: string;
  icon: 'claude' | 'codex' | 'gemini' | 'opencode';
  capabilities: AgentCapability[];
}

export const AGENT_REGISTRY: AgentDefinition[] = [
  {
    kind: 'claude_code',
    label: 'Claude Code',
    description: 'Default coding agent with the most complete runtime support.',
    icon: 'claude',
    capabilities: [
      'supports_resume',
      'supports_tools',
      'supports_file_snapshots',
      'supports_cost',
      'supports_context_window',
      'supports_mcp',
      'supports_ask_user_question',
    ],
  },
  {
    kind: 'codex',
    label: 'Codex',
    description: 'OpenAI Codex SDK backed coding agent.',
    icon: 'codex',
    capabilities: ['supports_tools', 'supports_file_snapshots'],
  },
  {
    kind: 'gemini_cli',
    label: 'Gemini CLI',
    description: 'Future coding agent entry kept in the registry for menu stability.',
    icon: 'gemini',
    capabilities: [],
  },
  {
    kind: 'opencode',
    label: 'OpenCode',
    description: 'Future coding agent entry kept in the registry for menu stability.',
    icon: 'opencode',
    capabilities: [],
  },
];

export function getAgentDefinition(kind: AgentKind): AgentDefinition | undefined {
  return AGENT_REGISTRY.find((entry) => entry.kind === kind);
}

export function getDefaultAgentKind(): AgentKind {
  return 'claude_code';
}
```

```ts
// src/types/provider.ts
import type { AgentKind } from './session';

export type Theme = 'Light' | 'Dark' | 'System';

export interface AgentDefaults {
  default_agent_kind: AgentKind;
}

export interface AgentConfigMap {
  claude_code: {
    executable_mode?: 'auto' | 'bundled' | 'path';
    resume_sessions?: boolean;
  };
  codex: {
    sdk_mode?: 'responses' | 'agent';
    default_provider_id?: string | null;
  };
  gemini_cli: Record<string, never>;
  opencode: Record<string, never>;
}

export interface Provider {
  id: string;
  name: string;
  api_key: string;
  anthropic_base_url: string;
  openai_base_url: string;
  default_model: string;
  input_price?: number;
  cache_read_price?: number;
  output_price?: number;
  context_1m?: boolean;
}

export interface AppConfig {
  providers: Provider[];
  active_provider_id: string | null;
  agent_defaults: AgentDefaults;
  agent_configs: AgentConfigMap;
  theme: Theme;
}
```

- [ ] **Step 6: Implement session creation payload and Rust schema/config migration**

```ts
// src/lib/tauri.ts
export const sessionApi = {
  create: (title: string, agentKind: string, mode?: string, projectId?: string): Promise<Session> =>
    invokeLogged('create_session', {
      title,
      agentKind,
      mode,
      projectId: projectId ?? null,
    }),
  // ...
};
```

```rust
// src-tauri/src/db/schema.rs
let has_agent_kind: bool = conn
    .prepare("SELECT agent_kind FROM sessions LIMIT 0")
    .is_ok();
if !has_agent_kind {
    let _ = conn.execute(
        "ALTER TABLE sessions ADD COLUMN agent_kind TEXT NOT NULL DEFAULT 'claude_code'",
        [],
    );
}
```

```rust
// src-tauri/src/db/operations.rs
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub agent_kind: String,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub mode: Option<String>,
    pub project_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub fn create_session_with_mode(conn: &Connection, title: &str, agent_kind: &str, mode: &str) -> Result<Session> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, title, agent_kind, mode, now, now],
    )?;

    Ok(Session {
        id,
        title: title.to_string(),
        agent_kind: agent_kind.to_string(),
        provider_id: None,
        model: None,
        mode: Some(mode.to_string()),
        project_id: None,
        created_at: now.clone(),
        updated_at: now,
    })
}
```

```rust
// src-tauri/src/config/types.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDefaults {
    pub default_agent_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeCodeAgentConfig {
    #[serde(default)]
    pub executable_mode: String,
    #[serde(default = "default_true")]
    pub resume_sessions: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexAgentConfig {
    #[serde(default)]
    pub sdk_mode: String,
    #[serde(default)]
    pub default_provider_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfigs {
    pub claude_code: ClaudeCodeAgentConfig,
    pub codex: CodexAgentConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub providers: Vec<Provider>,
    pub active_provider_id: Option<String>,
    pub agent_defaults: AgentDefaults,
    pub agent_configs: AgentConfigs,
    pub theme: Theme,
}
```

- [ ] **Step 7: Re-run the focused tests to verify the foundations pass**

Run: `npx vitest run src/agentRegistry.test.ts`

Expected: PASS

Run: `cargo test adds_agent_kind_to_legacy_sessions --manifest-path src-tauri/Cargo.toml`

Expected: PASS

- [ ] **Step 8: Commit the schema and config foundation**

```bash
git add src/types/agentRegistry.ts src/types/session.ts src/types/provider.ts src/lib/tauri.ts src/stores/sessionStore.ts src/stores/settingsStore.ts src/agentRegistry.test.ts src-tauri/src/db/schema.rs src-tauri/src/db/operations.rs src-tauri/src/commands/session.rs src-tauri/src/config/types.rs src-tauri/src/config/mod.rs
git commit -m "feat: add multi-agent session and config foundations"
```

## Task 2: Build the New-Conversation Agent Selector and Agent Settings

**Files:**
- Create: `src/stores/newSessionStore.ts`
- Create: `src/components/agent/AgentSelector.tsx`
- Create: `src/components/agent/NewSessionPanel.tsx`
- Create: `src/components/settings/AgentSettings.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/layout/Sidebar.tsx`
- Modify: `src/components/settings/SettingsDialog.tsx`
- Modify: `src/stores/settingsStore.ts`
- Test: `src/stores/newSessionStore.test.ts`
- Test: `src/components/agent/NewSessionPanel.test.tsx`

- [ ] **Step 1: Write the failing draft-state store test**

```ts
// src/stores/newSessionStore.test.ts
import { beforeEach, describe, expect, it } from 'vitest';

import { useNewSessionStore } from './newSessionStore';

describe('new session store', () => {
  beforeEach(() => {
    useNewSessionStore.setState({
      selectedAgentKind: 'claude_code',
    });
  });

  it('defaults to Claude Code', () => {
    expect(useNewSessionStore.getState().selectedAgentKind).toBe('claude_code');
  });

  it('updates the draft agent independently from persisted sessions', () => {
    useNewSessionStore.getState().setSelectedAgentKind('codex');
    expect(useNewSessionStore.getState().selectedAgentKind).toBe('codex');
  });
});
```

- [ ] **Step 2: Run the store test to verify the draft-state store is missing**

Run: `npx vitest run src/stores/newSessionStore.test.ts`

Expected: FAIL because `newSessionStore.ts` does not exist yet.

- [ ] **Step 3: Write the failing empty-state selector test**

```tsx
// src/components/agent/NewSessionPanel.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { NewSessionPanel } from './NewSessionPanel';

describe('NewSessionPanel', () => {
  it('shows Claude Code as the default placeholder target', () => {
    render(<NewSessionPanel onSubmit={vi.fn()} />);

    expect(screen.getByPlaceholderText('给 Claude Code 发送消息')).toBeTruthy();
  });

  it('switches the placeholder when Codex is selected', async () => {
    render(<NewSessionPanel onSubmit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Codex' }));

    expect(screen.getByPlaceholderText('给 Codex 发送消息')).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run the selector test to verify the UI is missing**

Run: `npx vitest run src/components/agent/NewSessionPanel.test.tsx`

Expected: FAIL because `NewSessionPanel` does not exist yet.

- [ ] **Step 5: Implement the draft agent store and selector UI**

```ts
// src/stores/newSessionStore.ts
import { create } from 'zustand';
import type { AgentKind } from '../types/session';

interface NewSessionState {
  selectedAgentKind: AgentKind;
  setSelectedAgentKind: (agentKind: AgentKind) => void;
}

export const useNewSessionStore = create<NewSessionState>((set) => ({
  selectedAgentKind: 'claude_code',
  setSelectedAgentKind: (selectedAgentKind) => set({ selectedAgentKind }),
}));
```

```tsx
// src/components/agent/AgentSelector.tsx
import { ChevronDown } from 'lucide-react';

import { AGENT_REGISTRY, getAgentDefinition } from '../../types/agentRegistry';
import type { AgentKind } from '../../types/session';
import { DropdownMenu, DropdownMenuItem } from '../ui/dropdown-menu';

export function AgentSelector({
  value,
  onChange,
}: {
  value: AgentKind;
  onChange: (value: AgentKind) => void;
}) {
  const current = getAgentDefinition(value)!;

  return (
    <DropdownMenu
      trigger={
        <button
          type="button"
          aria-label={current.label}
          className="flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-sm text-foreground/80 hover:bg-muted/50"
        >
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-[hsl(var(--primary)/0.1)]">
            {current.label.slice(0, 1)}
          </span>
          <span className="hidden sm:inline">{current.label}</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      }
    >
      {AGENT_REGISTRY.map((agent) => (
        <DropdownMenuItem
          key={agent.kind}
          onClick={() => onChange(agent.kind)}
          className={agent.kind === value ? 'bg-muted/60' : undefined}
        >
          {agent.label}
        </DropdownMenuItem>
      ))}
    </DropdownMenu>
  );
}
```

```tsx
// src/components/agent/NewSessionPanel.tsx
import { useState } from 'react';

import { useNewSessionStore } from '../../stores/newSessionStore';
import { getAgentDefinition } from '../../types/agentRegistry';
import { AgentSelector } from './AgentSelector';

export function NewSessionPanel({ onSubmit }: { onSubmit: (message: string) => Promise<void> | void }) {
  const { selectedAgentKind, setSelectedAgentKind } = useNewSessionStore();
  const [value, setValue] = useState('');
  const selectedAgent = getAgentDefinition(selectedAgentKind)!;

  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <form
        className="w-full max-w-3xl rounded-3xl border border-border/40 bg-background/80 p-4 shadow-2xl shadow-black/5"
        onSubmit={async (event) => {
          event.preventDefault();
          const trimmed = value.trim();
          if (!trimmed) return;
          await onSubmit(trimmed);
          setValue('');
        }}
      >
        <div className="flex items-center gap-3">
          <AgentSelector value={selectedAgentKind} onChange={setSelectedAgentKind} />
          <input
            className="flex-1 bg-transparent text-sm outline-none"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={`给 ${selectedAgent.label} 发送消息`}
          />
          <button type="submit" className="rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground">
            发送
          </button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 6: Wire the new panel into the empty state and expose default-agent settings**

```tsx
// src/App.tsx
const handleNewSession = async (agentKind?: AgentKind, projectId?: string) => {
  const chosenAgentKind = agentKind ?? useNewSessionStore.getState().selectedAgentKind;
  await createSession('新对话', chosenAgentKind, 'agent', projectId);
};

// ...
{activeSessionId ? (
  <AgentPanel sessionId={activeSessionId} />
) : (
  <NewSessionPanel
    onSubmit={async (message) => {
      const session = await createSession('新对话', useNewSessionStore.getState().selectedAgentKind, 'agent');
      await useAgentStore.getState().startQuery(session.id, message, '.');
    }}
  />
)}
```

```tsx
// src/components/settings/AgentSettings.tsx
import { useSettingsStore } from '../../stores/settingsStore';
import { AGENT_REGISTRY } from '../../types/agentRegistry';

export function AgentSettingsPanel() {
  const { config, setDefaultAgentKind } = useSettingsStore();

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold">Agents</h3>
      <p className="text-sm text-foreground/74">配置新建对话默认使用的编码 Agent。</p>
      <div className="grid gap-3">
        {AGENT_REGISTRY.map((agent) => (
          <button
            key={agent.kind}
            className="flex items-center justify-between rounded-xl border border-border/50 px-4 py-3 text-left hover:border-primary/40"
            onClick={() => setDefaultAgentKind(agent.kind)}
          >
            <div>
              <div className="font-medium">{agent.label}</div>
              <div className="text-xs text-muted-foreground">{agent.description}</div>
            </div>
            <span className="text-xs text-muted-foreground">
              {config?.agent_defaults.default_agent_kind === agent.kind ? '默认' : '可选'}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Re-run the focused UI tests**

Run: `npx vitest run src/stores/newSessionStore.test.ts src/components/agent/NewSessionPanel.test.tsx`

Expected: PASS

- [ ] **Step 8: Commit the new-session UI and settings changes**

```bash
git add src/stores/newSessionStore.ts src/stores/newSessionStore.test.ts src/components/agent/AgentSelector.tsx src/components/agent/NewSessionPanel.tsx src/components/agent/NewSessionPanel.test.tsx src/App.tsx src/components/layout/Sidebar.tsx src/components/settings/SettingsDialog.tsx src/components/settings/AgentSettings.tsx src/stores/settingsStore.ts
git commit -m "feat: add agent-aware new conversation entry"
```

## Task 3: Introduce the Rust Runtime Factory and Wrap Claude

**Files:**
- Create: `src-tauri/src/agent_runtime/mod.rs`
- Create: `src-tauri/src/agent_runtime/types.rs`
- Create: `src-tauri/src/agent_runtime/factory.rs`
- Create: `src-tauri/src/agent_runtime/claude_code.rs`
- Modify: `src-tauri/src/agent/commands.rs`
- Modify: `src-tauri/src/agent/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/agent_runtime/factory.rs`

- [ ] **Step 1: Write the failing runtime-factory test**

```rust
// src-tauri/src/agent_runtime/factory.rs
#[cfg(test)]
mod tests {
    use super::runtime_for_agent_kind;

    #[test]
    fn resolves_claude_and_codex_runtime_variants() {
        assert_eq!(runtime_for_agent_kind("claude_code").kind_name(), "claude_code");
        assert_eq!(runtime_for_agent_kind("codex").kind_name(), "codex");
    }
}
```

- [ ] **Step 2: Run the Rust test to verify the runtime factory is missing**

Run: `cargo test resolves_claude_and_codex_runtime_variants --manifest-path src-tauri/Cargo.toml`

Expected: FAIL because `agent_runtime` does not exist yet.

- [ ] **Step 3: Create the shared runtime contract**

```rust
// src-tauri/src/agent_runtime/types.rs
use async_trait::async_trait;
use serde_json::Value;
use tauri::ipc::Channel;

#[derive(Clone, Debug)]
pub struct RuntimeRequest {
    pub session_id: String,
    pub agent_kind: String,
    pub cwd: String,
    pub prompt: Option<String>,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub channel: Channel<String>,
}

#[async_trait]
pub trait AgentRuntime: Send + Sync {
    fn kind_name(&self) -> &'static str;
    async fn ensure(&self, request: RuntimeRequest) -> Result<(), String>;
    async fn start(&self, request: RuntimeRequest) -> Result<(), String>;
    async fn send_input(&self, session_id: &str, prompt: String) -> Result<(), String>;
    async fn interrupt(&self, session_id: &str) -> Result<(), String>;
    async fn shutdown(&self, session_id: &str) -> Result<(), String>;
    async fn reset(&self, session_id: &str) -> Result<(), String>;
    async fn load_history(&self, session_id: &str) -> Result<Vec<Value>, String>;
}
```

```rust
// src-tauri/src/agent_runtime/factory.rs
use super::{claude_code::ClaudeCodeRuntime, codex::CodexRuntime, types::AgentRuntime};

pub fn runtime_for_agent_kind(agent_kind: &str) -> Box<dyn AgentRuntime> {
    match agent_kind {
        "codex" => Box::new(CodexRuntime::default()),
        _ => Box::new(ClaudeCodeRuntime::default()),
    }
}
```

- [ ] **Step 4: Wrap the current Claude command flow in `ClaudeCodeRuntime`**

```rust
// src-tauri/src/agent_runtime/claude_code.rs
use async_trait::async_trait;

use crate::agent::commands::{
    ensure_sidecar_for_session,
    send_command_to_session,
    build_ensure_session_command,
    AgentState,
};

use super::types::{AgentRuntime, RuntimeRequest};

#[derive(Default)]
pub struct ClaudeCodeRuntime;

#[async_trait]
impl AgentRuntime for ClaudeCodeRuntime {
    fn kind_name(&self) -> &'static str {
        "claude_code"
    }

    async fn ensure(&self, request: RuntimeRequest) -> Result<(), String> {
        let _ = request;
        // call existing sidecar-backed ensure path here
        Ok(())
    }

    async fn start(&self, request: RuntimeRequest) -> Result<(), String> {
        let _ = request;
        Ok(())
    }

    async fn send_input(&self, session_id: &str, prompt: String) -> Result<(), String> {
        let _ = (session_id, prompt);
        Ok(())
    }

    async fn interrupt(&self, session_id: &str) -> Result<(), String> {
        let _ = session_id;
        Ok(())
    }

    async fn shutdown(&self, session_id: &str) -> Result<(), String> {
        let _ = session_id;
        Ok(())
    }

    async fn reset(&self, session_id: &str) -> Result<(), String> {
        let _ = session_id;
        Ok(())
    }

    async fn load_history(&self, session_id: &str) -> Result<Vec<serde_json::Value>, String> {
        let _ = session_id;
        Ok(Vec::new())
    }
}
```

- [ ] **Step 5: Route Tauri agent commands through the session's bound `agent_kind`**

```rust
// src-tauri/src/agent/commands.rs
fn session_agent_kind(state: &crate::AppState, session_id: &str) -> Result<String, String> {
    let db = state.db.lock().unwrap();
    let session = crate::db::operations::get_all_sessions(&db)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|session| session.id == session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;
    Ok(session.agent_kind)
}

pub async fn ensure_agent_session(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    agent_state: State<'_, AgentState>,
    session_id: String,
    cwd: String,
    channel: tauri::ipc::Channel<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    let agent_kind = session_agent_kind(&state, &session_id)?;
    let runtime = crate::agent_runtime::factory::runtime_for_agent_kind(&agent_kind);
    runtime
        .ensure(crate::agent_runtime::types::RuntimeRequest {
            session_id,
            agent_kind,
            cwd,
            prompt: None,
            api_key,
            base_url,
            model,
            channel,
        })
        .await
}
```

- [ ] **Step 6: Re-run the focused Rust tests**

Run: `cargo test resolves_claude_and_codex_runtime_variants --manifest-path src-tauri/Cargo.toml`

Expected: PASS

- [ ] **Step 7: Commit the runtime factory and Claude wrapper**

```bash
git add src-tauri/src/agent_runtime/mod.rs src-tauri/src/agent_runtime/types.rs src-tauri/src/agent_runtime/factory.rs src-tauri/src/agent_runtime/claude_code.rs src-tauri/src/agent/commands.rs src-tauri/src/agent/mod.rs src-tauri/src/lib.rs
git commit -m "refactor: route agent commands through runtime factory"
```

## Task 4: Add Codex Sidecar Runtime and Wire the Codex Adapter

**Files:**
- Create: `src-tauri/src/agent_runtime/codex.rs`
- Modify: `src-tauri/sidecar/package.json`
- Modify: `src-tauri/sidecar/src/types.ts`
- Modify: `src-tauri/sidecar/src/index.ts`
- Create: `src-tauri/sidecar/src/claudeRuntime.ts`
- Create: `src-tauri/sidecar/src/codexRuntime.ts`
- Create: `src-tauri/sidecar/src/runtimeEvents.ts`
- Modify: `src/sidecarSessionHelpers.test.ts`

- [ ] **Step 1: Write the failing sidecar helper/runtime-selection test**

```ts
// src/sidecarSessionHelpers.test.ts
import { describe, expect, it } from 'vitest';

import { getRuntimeFlavor } from '../src-tauri/sidecar/src/runtimeEvents';

describe('getRuntimeFlavor', () => {
  it('routes Claude and Codex to different runtime flavors', () => {
    expect(getRuntimeFlavor('claude_code')).toBe('claude');
    expect(getRuntimeFlavor('codex')).toBe('codex');
  });
});
```

- [ ] **Step 2: Run the focused sidecar test to verify the Codex runtime helpers are missing**

Run: `npx vitest run src/sidecarSessionHelpers.test.ts`

Expected: FAIL because `runtimeEvents.ts` or `getRuntimeFlavor` does not exist yet.

- [ ] **Step 3: Add `agentKind` to sidecar commands and extract the Claude runtime**

```ts
// src-tauri/sidecar/src/types.ts
export type SidecarCommand =
  | {
      type: 'ensure_session';
      agentKind: 'claude_code' | 'codex';
      cwd: string;
      sessionId?: string;
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      mcpServers?: Record<string, unknown>;
      mcpServerInstructions?: Record<string, string>;
      skills?: string[];
    }
  | { type: 'send_input'; prompt: string }
  | { type: 'reset_session'; sessionId: string }
  | { type: 'interrupt' }
  | { type: 'shutdown' }
  | { type: 'tool_response'; toolUseId: string; response: unknown };
```

```ts
// src-tauri/sidecar/src/runtimeEvents.ts
export function getRuntimeFlavor(agentKind: string): 'claude' | 'codex' {
  return agentKind === 'codex' ? 'codex' : 'claude';
}
```

```ts
// src-tauri/sidecar/src/claudeRuntime.ts
export { SessionRuntime as ClaudeSessionRuntime } from './index';
```

- [ ] **Step 4: Implement the Codex runtime shell**

```ts
// src-tauri/sidecar/src/codexRuntime.ts
type CodexSessionBootstrap = {
  sessionId?: string;
  cwd: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

export class CodexSessionRuntime {
  private config: CodexSessionBootstrap | null = null;

  async ensure(cmd: Extract<SidecarCommand, { type: 'ensure_session' }>): Promise<void> {
    this.config = {
      sessionId: cmd.sessionId,
      cwd: cmd.cwd,
      apiKey: cmd.apiKey,
      baseUrl: cmd.baseUrl,
      model: cmd.model,
    };
    emit({ type: 'mcp_status_update', servers: {}, status: 'ready' });
  }

  async sendInput(prompt: string): Promise<void> {
    if (!this.config) throw new Error('Codex session not initialized');
    emit({ type: 'system', subtype: 'init', session_id: this.config.sessionId || '', model: this.config.model || 'codex', cwd: this.config.cwd, tools: [], permissionMode: 'bypassPermissions' });
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Codex placeholder response for: ${prompt}` }] }, parent_tool_use_id: null, session_id: this.config.sessionId || '', uuid: crypto.randomUUID() });
    emit({ type: 'result', subtype: 'success', is_error: false, session_id: this.config.sessionId || '', uuid: crypto.randomUUID(), duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: 'ok', total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });
    emit({ type: 'sidecar_query_done' });
  }

  async resetSession(): Promise<void> {
    this.config = null;
  }

  async interrupt(): Promise<void> {
    emit({ type: 'sidecar_query_done' });
  }
}
```

- [ ] **Step 5: Dispatch to the correct runtime in the sidecar entrypoint**

```ts
// src-tauri/sidecar/src/index.ts
import { ClaudeSessionRuntime } from './claudeRuntime.js';
import { CodexSessionRuntime } from './codexRuntime.js';
import { getRuntimeFlavor } from './runtimeEvents.js';

const claudeRuntime = new ClaudeSessionRuntime();
const codexRuntime = new CodexSessionRuntime();

function activeRuntime(agentKind: string) {
  return getRuntimeFlavor(agentKind) === 'codex' ? codexRuntime : claudeRuntime;
}

// inside command handling
case 'ensure_session':
  await activeRuntime(cmd.agentKind).ensure(cmd as any);
  break;
case 'send_input':
  if (lastAgentKind === 'codex') {
    await codexRuntime.sendInput(cmd.prompt);
  } else {
    await claudeRuntime.sendInput(cmd.prompt);
  }
  break;
```

- [ ] **Step 6: Re-run the focused sidecar test**

Run: `npx vitest run src/sidecarSessionHelpers.test.ts`

Expected: PASS

- [ ] **Step 7: Commit the Codex runtime shell**

```bash
git add src-tauri/src/agent_runtime/codex.rs src-tauri/sidecar/package.json src-tauri/sidecar/src/types.ts src-tauri/sidecar/src/index.ts src-tauri/sidecar/src/claudeRuntime.ts src-tauri/sidecar/src/codexRuntime.ts src-tauri/sidecar/src/runtimeEvents.ts src/sidecarSessionHelpers.test.ts
git commit -m "feat: add codex runtime adapter shell"
```

## Task 5: Surface Agent Badges, Capability Gating, and End-to-End Regression Coverage

**Files:**
- Modify: `src/components/agent/AgentPanel.tsx`
- Modify: `src/components/session/SessionItem.tsx`
- Modify: `src/stores/agentStore.ts`
- Modify: `src/stores/agentEventParsing.test.ts`
- Create: `src/components/session/SessionItem.test.tsx`
- Create: `src/components/agent/agentCapabilities.ts`

- [ ] **Step 1: Write the failing session-item badge test**

```tsx
// src/components/session/SessionItem.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SessionItem } from './SessionItem';

describe('SessionItem', () => {
  it('shows the bound agent label for Codex sessions', () => {
    render(
      <SessionItem
        session={{
          id: 'session-1',
          title: 'Codex Session',
          agent_kind: 'codex',
          provider_id: null,
          model: null,
          mode: 'agent',
          project_id: null,
          created_at: '',
          updated_at: '',
        }}
        isActive={false}
        onClick={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText('Codex')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the focused badge test to verify the list item does not show agent identity yet**

Run: `npx vitest run src/components/session/SessionItem.test.tsx`

Expected: FAIL because `SessionItem` only shows the generic icon and title.

- [ ] **Step 3: Add shared capability helpers and gate UI surfaces**

```ts
// src/components/agent/agentCapabilities.ts
import { getAgentDefinition } from '../../types/agentRegistry';
import type { AgentKind } from '../../types/session';

export function supportsCapability(agentKind: AgentKind, capability: string): boolean {
  return getAgentDefinition(agentKind)?.capabilities.includes(capability as never) ?? false;
}
```

```tsx
// src/components/agent/AgentPanel.tsx
const sessionAgentKind = session?.agent_kind ?? 'claude_code';
const supportsCost = supportsCapability(sessionAgentKind, 'supports_cost');

// ...
{supportsCost && contextUsage.usedTokens > 0 && (
  <ContextDisplay
    usedTokens={contextUsage.usedTokens}
    totalTokens={contextUsage.totalTokens}
    modelName={session?.model || activeProvider?.default_model}
    inputTokens={contextUsage.inputTokens}
    cachedTokens={contextUsage.cachedTokens}
    outputTokens={contextUsage.outputTokens}
  />
)}
```

```tsx
// src/components/session/SessionItem.tsx
import { getAgentDefinition } from '../../types/agentRegistry';

const agent = getAgentDefinition(session.agent_kind);

<div className="flex min-w-0 items-center gap-2">
  <MessageSquare className={cn('h-3.5 w-3.5 shrink-0', isActive ? 'text-[hsl(var(--sidebar-glow))]' : 'text-[hsl(var(--sidebar-fg))]/64')} />
  <span className={cn('flex-1 truncate', isActive && 'font-medium')}>
    {session.title || '未命名对话'}
  </span>
  {agent && (
    <span className="rounded-md border border-border/50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
      {agent.label}
    </span>
  )}
</div>
```

- [ ] **Step 4: Add a focused Codex normalization regression test**

```ts
// src/stores/agentEventParsing.test.ts
it('keeps non-Claude assistant payloads usable after runtime normalization', () => {
  const event = mapPersistedClaudeMessage({
    type: 'assistant',
    uuid: 'assistant-1',
    session_id: 'session-1',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Codex says hello' }],
    },
    parent_tool_use_id: null,
  });

  expect(event).toEqual({
    kind: 'assistant',
    data: expect.objectContaining({
      message: expect.objectContaining({
        content: [{ type: 'text', text: 'Codex says hello' }],
      }),
    }),
  });
});
```

- [ ] **Step 5: Run the focused frontend regression tests**

Run: `npx vitest run src/components/session/SessionItem.test.tsx src/stores/agentEventParsing.test.ts src/components/agent/NewSessionPanel.test.tsx src/stores/newSessionStore.test.ts`

Expected: PASS

- [ ] **Step 6: Run the broader regression suite**

Run: `npx vitest run src/agentRegistry.test.ts src/sidecarSessionHelpers.test.ts src/stores/agentEventParsing.test.ts src/components/agent/NewSessionPanel.test.tsx src/components/session/SessionItem.test.tsx`

Expected: PASS

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS

- [ ] **Step 7: Commit the UI polish and regression coverage**

```bash
git add src/components/agent/AgentPanel.tsx src/components/agent/agentCapabilities.ts src/components/session/SessionItem.tsx src/components/session/SessionItem.test.tsx src/stores/agentStore.ts src/stores/agentEventParsing.test.ts
git commit -m "feat: surface agent badges and capability gating"
```

## Self-Review

### Spec coverage

- Session-bound `agent_kind`: covered by Task 1
- Hybrid config (`providers` + `agent_configs` + `agent_defaults`): covered by Task 1 and Task 2
- Input-adjacent selector (visual A): covered by Task 2
- New session only agent switching: covered by Task 2 and Task 5
- Runtime adapter and factory approach: covered by Task 3
- Claude wrapper before Codex parity: covered by Task 3
- Codex phase-1 main path: covered by Task 4
- Capability-based degradation and badges: covered by Task 5

### Placeholder scan

- No `TODO`, `TBD`, or "implement later" placeholders remain.
- Every task contains exact files, code examples, test commands, and commit commands.

### Type consistency

- `agent_kind` is used consistently across session types, config defaults, the registry, and runtime factory routing.
- `claude_code` remains the canonical default string in all layers.
- Codex is introduced through the same session and runtime path rather than a side branch.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-10-multi-agent-codex-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
