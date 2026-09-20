# Multi-Provider Agent Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-provider chat-mode system with a multi-provider configuration that drives the Agent mode sidecar, and remove all dead chat-mode code.

**Architecture:** Providers are stored in `config.json` as an array. The active provider's `api_key` and `anthropic_base_url` flow through `AgentPanel → agentStore → agentApi → Rust command → sidecar`, where they become `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` env vars for `@anthropic-ai/claude-agent-sdk`. The settings UI uses a card grid with modal editing.

**Tech Stack:** TypeScript, React, Zustand, Tauri v2, Rust, `@anthropic-ai/claude-agent-sdk`

---

### Task 1: Remove Chat Mode (Rust)

Delete unused Rust chat/provider code.

**Files:**
- Delete: `src-tauri/src/commands/chat.rs`
- Delete: `src-tauri/src/provider/` (entire directory: `mod.rs`, `types.rs`, `deepseek.rs`, `openai_compat.rs`)
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Delete chat command file**

```bash
rm src-tauri/src/commands/chat.rs
```

- [ ] **Step 2: Delete provider directory**

```bash
rm -rf src-tauri/src/provider/
```

- [ ] **Step 3: Update commands/mod.rs**

Remove `pub mod chat;` from `src-tauri/src/commands/mod.rs`. The file should become:

```rust
pub mod file;
pub mod project;
pub mod provider;
pub mod session;
```

- [ ] **Step 4: Update lib.rs**

In `src-tauri/src/lib.rs`:
1. Remove `mod provider;` (line 4)
2. Remove `commands::chat::send_message,` and `commands::chat::send_message_stream,` from the invoke_handler

The file should become:

```rust
mod db;
mod config;
mod commands;
mod agent;

use tauri::Manager;
use std::sync::Mutex;

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub config: Mutex<config::types::AppConfig>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let conn = db::initialize(&app.handle()).expect("Failed to initialize database");
            let config = config::load_config(&app.handle());

            app.manage(AppState {
                db: Mutex::new(conn),
                config: Mutex::new(config),
            });
            app.manage(agent::commands::AgentState::default());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::provider::get_config,
            commands::provider::update_provider,
            commands::provider::set_active_provider,
            commands::provider::set_theme,
            commands::provider::test_connection,
            commands::session::create_session,
            commands::session::get_all_sessions,
            commands::session::delete_session,
            commands::session::update_session_title,
            commands::session::get_messages,
            commands::session::save_agent_events,
            commands::session::get_agent_events,
            commands::project::create_project,
            commands::project::get_all_projects,
            commands::project::delete_project,
            commands::project::rename_project,
            commands::file::read_file,
            agent::commands::start_agent_session,
            agent::commands::interrupt_agent_session,
            agent::commands::shutdown_agent,
            agent::commands::reset_agent_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 5: Verify Rust compiles**

```bash
cd src-tauri && cargo check
```

Expected: Compiles with possible warnings about unused imports, no errors.

- [ ] **Step 6: Commit**

```bash
git add -A src-tauri/
git commit -m "refactor: remove chat mode Rust code (commands, provider impls)"
```

---

### Task 2: Remove Chat Mode (Frontend)

Delete unused frontend chat code.

**Files:**
- Delete: `src/types/chat.ts`
- Delete: `src/stores/chatStore.ts`
- Delete: `src/components/chat/ChatPanel.tsx`
- Delete: `src/components/chat/MessageList.tsx`
- Delete: `src/components/chat/MessageItem.tsx`
- Delete: `src/components/chat/MarkdownRenderer.tsx`
- Modify: `src/lib/tauri.ts`

- [ ] **Step 1: Delete chat frontend files**

```bash
rm src/types/chat.ts
rm src/stores/chatStore.ts
rm src/components/chat/ChatPanel.tsx
rm src/components/chat/MessageList.tsx
rm src/components/chat/MessageItem.tsx
rm src/components/chat/MarkdownRenderer.tsx
```

- [ ] **Step 2: Remove chatApi and ChatMessage import from tauri.ts**

In `src/lib/tauri.ts`:
1. Remove line 3: `import type { ChatMessage } from '../types/chat';`
2. Remove lines 23-32 (the entire `chatApi` block)

The file should become:

```typescript
import { invoke, Channel } from '@tauri-apps/api/core';
import type { Session } from '../types/session';
import type { AppConfig, Provider, Theme } from '../types/provider';
import type { Project } from '../types/project';

export const projectApi = {
  create: (name: string, path: string): Promise<Project> => invoke('create_project', { name, path }),
  getAll: (): Promise<Project[]> => invoke('get_all_projects'),
  delete: (projectId: string): Promise<void> => invoke('delete_project', { projectId }),
  rename: (projectId: string, name: string): Promise<void> => invoke('rename_project', { projectId, name }),
};

export const sessionApi = {
  create: (title: string, mode?: string, projectId?: string): Promise<Session> =>
    invoke('create_session', { title, mode, projectId: projectId ?? null }),
  getAll: (): Promise<Session[]> => invoke('get_all_sessions'),
  delete: (sessionId: string): Promise<void> => invoke('delete_session', { sessionId }),
  updateTitle: (sessionId: string, title: string): Promise<void> => invoke('update_session_title', { sessionId, title }),
  getMessages: (sessionId: string): Promise<unknown[]> => invoke('get_messages', { sessionId }),
};

export const agentApi = {
  startSession: (
    sessionId: string,
    prompt: string,
    cwd: string,
    onEvent: (event: string) => void,
    apiKey?: string,
    baseUrl?: string,
  ): Promise<void> => {
    const channel = new Channel<string>();
    channel.onmessage = (event: string) => {
      onEvent(event);
    };
    return invoke('start_agent_session', { sessionId, prompt, cwd, channel, apiKey, baseUrl });
  },
  interrupt: (): Promise<void> => invoke('interrupt_agent_session'),
  shutdown: (): Promise<void> => invoke('shutdown_agent'),
  resetSession: (sessionId: string): Promise<void> => invoke('reset_agent_session', { sessionId }),
  saveEvents: (sessionId: string, eventsJson: string): Promise<void> =>
    invoke('save_agent_events', { sessionId, eventsJson }),
  getEvents: (sessionId: string): Promise<string> =>
    invoke('get_agent_events', { sessionId }),
};

export const configApi = {
  get: (): Promise<AppConfig> => invoke('get_config'),
  updateProvider: (provider: Provider): Promise<void> => invoke('update_provider', { provider }),
  deleteProvider: (providerId: string): Promise<void> => invoke('delete_provider', { providerId }),
  setActiveProvider: (providerId: string): Promise<void> => invoke('set_active_provider', { providerId }),
  setTheme: (theme: Theme): Promise<void> => invoke('set_theme', { theme: theme.toLowerCase() }),
  fetchModels: (apiKey: string, baseUrl: string): Promise<string[]> =>
    invoke('fetch_provider_models', { apiKey, baseUrl }),
};

export const fileApi = {
  readFile: (path: string): Promise<string> => invoke('read_file', { path }),
};
```

Note: This already includes the new `Provider` type import, `deleteProvider`, `fetchModels`, and `baseUrl` param on `agentApi.startSession`. These will be used by later tasks.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: Errors about missing `Provider` type and `delete_provider`/`fetch_provider_models` commands. These will be fixed in Tasks 3 and 4.

- [ ] **Step 4: Commit**

```bash
git add -A src/
git commit -m "refactor: remove chat mode frontend code"
```

---

### Task 3: Update Data Model (TypeScript + Rust)

Rewrite provider types for multi-provider support.

**Files:**
- Rewrite: `src/types/provider.ts`
- Rewrite: `src-tauri/src/config/types.rs`

- [ ] **Step 1: Rewrite TypeScript types**

Replace `src/types/provider.ts` entirely:

```typescript
export type Theme = 'Light' | 'Dark' | 'System';

export interface Provider {
  id: string;
  name: string;
  api_key: string;
  anthropic_base_url: string;
  openai_base_url: string;
  default_model: string;
}

export interface AppConfig {
  providers: Provider[];
  active_provider_id: string | null;
  theme: Theme;
}
```

- [ ] **Step 2: Rewrite Rust types**

Replace `src-tauri/src/config/types.rs` entirely:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub api_key: String,
    pub anthropic_base_url: String,
    pub openai_base_url: String,
    pub default_model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub providers: Vec<Provider>,
    pub active_provider_id: Option<String>,
    pub theme: Theme,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Theme {
    Light,
    Dark,
    System,
}

impl Default for AppConfig {
    fn default() -> Self {
        let id = uuid::Uuid::new_v4().to_string();
        Self {
            providers: vec![Provider {
                id: id.clone(),
                name: "默认".to_string(),
                api_key: String::new(),
                anthropic_base_url: "https://api.anthropic.com".to_string(),
                openai_base_url: String::new(),
                default_model: "claude-sonnet-4-20250514".to_string(),
            }],
            active_provider_id: Some(id),
            theme: Theme::System,
        }
    }
}
```

Note: This uses `uuid` crate. Check if it's already in `Cargo.toml`; if not, add it.

- [ ] **Step 3: Add uuid dependency if missing**

Check `src-tauri/Cargo.toml` for `uuid`. If not present, add:

```toml
[dependencies]
uuid = { version = "1", features = ["v4"] }
```

- [ ] **Step 4: Verify Rust compiles**

```bash
cd src-tauri && cargo check
```

Expected: Errors in `commands/provider.rs` (references old `ProviderConfig`/`ApiType`). Will be fixed in Task 4.

- [ ] **Step 5: Commit**

```bash
git add src/types/provider.ts src-tauri/src/config/types.rs src-tauri/Cargo.toml
git commit -m "feat: update data model for multi-provider support"
```

---

### Task 4: Update Rust Provider Commands

Rewrite provider commands for multi-provider CRUD and model fetching.

**Files:**
- Rewrite: `src-tauri/src/commands/provider.rs`

- [ ] **Step 1: Rewrite provider.rs**

Replace `src-tauri/src/commands/provider.rs` entirely:

```rust
use tauri::{AppHandle, State};
use crate::AppState;
use crate::config::types::{AppConfig, Provider, Theme};
use crate::config;

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> AppConfig {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
pub fn update_provider(state: State<'_, AppState>, app: AppHandle, provider: Provider) -> Result<(), String> {
    let mut config = state.config.lock().unwrap();

    if let Some(existing) = config.providers.iter_mut().find(|p| p.id == provider.id) {
        *existing = provider;
    } else {
        config.providers.push(provider);
    }

    config::save_config(&app, &config)?;
    Ok(())
}

#[tauri::command]
pub fn delete_provider(state: State<'_, AppState>, app: AppHandle, provider_id: String) -> Result<(), String> {
    let mut config = state.config.lock().unwrap();
    config.providers.retain(|p| p.id != provider_id);

    // If deleted provider was active, clear active_provider_id
    if config.active_provider_id.as_deref() == Some(&provider_id) {
        config.active_provider_id = config.providers.first().map(|p| p.id.clone());
    }

    config::save_config(&app, &config)?;
    Ok(())
}

#[tauri::command]
pub fn set_active_provider(state: State<'_, AppState>, app: AppHandle, provider_id: String) -> Result<(), String> {
    let mut config = state.config.lock().unwrap();
    config.active_provider_id = Some(provider_id);
    config::save_config(&app, &config)?;
    Ok(())
}

#[tauri::command]
pub fn set_theme(state: State<'_, AppState>, app: AppHandle, theme: String) -> Result<(), String> {
    let mut config = state.config.lock().unwrap();
    config.theme = match theme.as_str() {
        "light" => Theme::Light,
        "dark" => Theme::Dark,
        _ => Theme::System,
    };
    config::save_config(&app, &config)?;
    Ok(())
}

#[tauri::command]
pub async fn fetch_provider_models(api_key: String, base_url: String) -> Result<Vec<String>, String> {
    let url = format!("{}/v1/models", base_url.trim_end_matches('/'));
    let client = reqwest::Client::new();

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}: {}", resp.status(), resp.text().await.unwrap_or_default()));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let models = body["data"]
        .as_array()
        .ok_or("Response missing 'data' array")?
        .iter()
        .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
        .collect();

    Ok(models)
}
```

- [ ] **Step 2: Ensure reqwest is in Cargo.toml**

Check `src-tauri/Cargo.toml` for `reqwest`. If not present, add:

```toml
[dependencies]
reqwest = { version = "0.12", features = ["json"] }
```

- [ ] **Step 3: Update lib.rs invoke_handler**

In `src-tauri/src/lib.rs`, replace the old commands with new ones in the invoke_handler:

```rust
.invoke_handler(tauri::generate_handler![
    commands::provider::get_config,
    commands::provider::update_provider,
    commands::provider::delete_provider,
    commands::provider::set_active_provider,
    commands::provider::set_theme,
    commands::provider::fetch_provider_models,
    // ... rest unchanged
```

- [ ] **Step 4: Verify Rust compiles**

```bash
cd src-tauri && cargo check
```

Expected: Clean compile.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/
git commit -m "feat: multi-provider CRUD commands and fetch_models"
```

---

### Task 5: Update Sidecar

Add `baseUrl` support, remove unused `model` field.

**Files:**
- Modify: `src-tauri/sidecar/src/types.ts`
- Modify: `src-tauri/sidecar/src/index.ts`

- [ ] **Step 1: Update SidecarCommand type**

In `src-tauri/sidecar/src/types.ts`, change the `start` variant:

```typescript
export type SidecarCommand =
  | { type: 'start'; prompt: string; cwd: string; sessionId?: string; apiKey?: string; baseUrl?: string }
  | { type: 'reset_session'; sessionId: string }
  | { type: 'interrupt' }
  | { type: 'shutdown' };
```

- [ ] **Step 2: Update handleStart in index.ts**

In `src-tauri/sidecar/src/index.ts`, in the `handleStart` function:

1. After setting `ANTHROPIC_API_KEY` (line 59-61), add `ANTHROPIC_BASE_URL`:

```typescript
if (cmd.apiKey) {
  process.env.ANTHROPIC_API_KEY = cmd.apiKey;
}
if (cmd.baseUrl) {
  process.env.ANTHROPIC_BASE_URL = cmd.baseUrl;
}
```

2. Update the log line (line 68) to show baseUrl instead of model:

```typescript
process.stderr.write(`[sidecar] Starting query: cwd=${cmd.cwd}, apiKey=${keyPreview}, baseUrl=${cmd.baseUrl || 'default'}, claude=${claudePath || 'not found'}\n`);
```

- [ ] **Step 3: Build sidecar**

```bash
cd src-tauri/sidecar && npm run build
```

Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/sidecar/
git commit -m "feat: sidecar accepts baseUrl for ANTHROPIC_BASE_URL env var"
```

---

### Task 6: Update Agent Commands (Rust)

Accept `base_url` parameter, remove broken provider fallback.

**Files:**
- Modify: `src-tauri/src/agent/commands.rs`

- [ ] **Step 1: Update start_agent_session signature and body**

In `src-tauri/src/agent/commands.rs`, update `start_agent_session`:

1. Add `base_url: Option<String>` parameter
2. Remove the broken fallback (lines 69-78) that reads from AppConfig
3. Add `baseUrl` to the sidecar command JSON

```rust
#[tauri::command]
pub async fn start_agent_session(
    app: AppHandle,
    agent_state: State<'_, AgentState>,
    session_id: String,
    prompt: String,
    cwd: String,
    channel: tauri::ipc::Channel<String>,
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<(), String> {
    // Ensure sidecar is running
    let need_spawn = {
        let guard = agent_state.sidecar.lock().await;
        guard.is_none()
    };

    if need_spawn {
        let (handle, mut rx) = spawn_sidecar(&app).await?;
        {
            let mut guard = agent_state.sidecar.lock().await;
            *guard = Some(handle);
        }

        let active_ch = agent_state.active_channel.clone();
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                let guard = active_ch.lock().await;
                if let Some(ch) = guard.as_ref() {
                    let _ = ch.send(event.clone());
                }
            }
        });
    }

    // Set the active channel for this query
    {
        let mut guard = agent_state.active_channel.lock().await;
        *guard = Some(channel);
    }

    // Build and send start command
    let mut cmd = serde_json::json!({
        "type": "start",
        "prompt": prompt,
        "cwd": cwd,
        "sessionId": session_id,
    });

    if let Some(key) = api_key {
        cmd["apiKey"] = serde_json::Value::String(key);
    }
    if let Some(url) = base_url {
        cmd["baseUrl"] = serde_json::Value::String(url);
    }

    let guard = agent_state.sidecar.lock().await;
    if let Some(handle) = guard.as_ref() {
        handle
            .send_command(&cmd.to_string())
            .await?;
    }

    Ok(())
}
```

- [ ] **Step 2: Verify Rust compiles**

```bash
cd src-tauri && cargo check
```

Expected: Clean compile.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/agent/commands.rs
git commit -m "feat: agent command passes baseUrl to sidecar, remove broken fallback"
```

---

### Task 7: Update Settings Store

Add multi-provider actions to the Zustand store.

**Files:**
- Rewrite: `src/stores/settingsStore.ts`

- [ ] **Step 1: Rewrite settingsStore.ts**

Replace `src/stores/settingsStore.ts` entirely:

```typescript
import { create } from 'zustand';
import type { AppConfig, Provider, Theme } from '../types/provider';
import { configApi } from '../lib/tauri';

interface SettingsState {
  config: AppConfig | null;
  isLoading: boolean;
  error: string | null;
  fetchConfig: () => Promise<void>;
  setTheme: (theme: Theme) => Promise<void>;
  setActiveProvider: (providerId: string) => Promise<void>;
  updateProvider: (provider: Provider) => Promise<void>;
  deleteProvider: (providerId: string) => Promise<void>;
  fetchModels: (apiKey: string, baseUrl: string) => Promise<string[]>;
  getActiveProvider: () => Provider | null;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  config: null,
  isLoading: false,
  error: null,

  fetchConfig: async () => {
    set({ isLoading: true, error: null });
    try {
      const config = await configApi.get();
      set({ config, isLoading: false });
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },

  setTheme: async (theme: Theme) => {
    try {
      await configApi.setTheme(theme);
      set((state) => ({
        config: state.config ? { ...state.config, theme } : null,
      }));
    } catch (error) {
      set({ error: String(error) });
    }
  },

  setActiveProvider: async (providerId: string) => {
    try {
      await configApi.setActiveProvider(providerId);
      set((state) => ({
        config: state.config ? { ...state.config, active_provider_id: providerId } : null,
      }));
    } catch (error) {
      set({ error: String(error) });
    }
  },

  updateProvider: async (provider: Provider) => {
    try {
      await configApi.updateProvider(provider);
      set((state) => {
        if (!state.config) return { config: null };
        const exists = state.config.providers.some((p) => p.id === provider.id);
        const providers = exists
          ? state.config.providers.map((p) => (p.id === provider.id ? provider : p))
          : [...state.config.providers, provider];
        return { config: { ...state.config, providers } };
      });
    } catch (error) {
      set({ error: String(error) });
    }
  },

  deleteProvider: async (providerId: string) => {
    try {
      await configApi.deleteProvider(providerId);
      set((state) => {
        if (!state.config) return { config: null };
        const providers = state.config.providers.filter((p) => p.id !== providerId);
        const active_provider_id =
          state.config.active_provider_id === providerId
            ? providers[0]?.id ?? null
            : state.config.active_provider_id;
        return { config: { ...state.config, providers, active_provider_id } };
      });
    } catch (error) {
      set({ error: String(error) });
    }
  },

  fetchModels: async (apiKey: string, baseUrl: string) => {
    const models = await configApi.fetchModels(apiKey, baseUrl);
    return models;
  },

  getActiveProvider: () => {
    const config = get().config;
    if (!config) return null;
    return config.providers.find((p) => p.id === config.active_provider_id) ?? null;
  },
}));
```

- [ ] **Step 2: Commit**

```bash
git add src/stores/settingsStore.ts
git commit -m "feat: settings store supports multi-provider CRUD and fetchModels"
```

---

### Task 8: Rename ChatInput to AgentInput

Replace model dropdown with read-only model display.

**Files:**
- Create: `src/components/agent/AgentInput.tsx` (from ChatInput.tsx)
- Delete: `src/components/chat/ChatInput.tsx`

- [ ] **Step 1: Create AgentInput.tsx**

Create `src/components/agent/AgentInput.tsx`:

```tsx
import { useState, useRef, KeyboardEvent } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { cn } from '../../lib/utils';

interface AgentInputProps {
  onSend: (content: string) => Promise<void>;
  onStop?: () => void;
  isLoading: boolean;
  modelName?: string;
}

export function AgentInput({ onSend, onStop, isLoading, modelName }: AgentInputProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = async () => {
    const content = input.trim();
    if (!content || isLoading) return;
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    await onSend(content);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    }
  };

  const hasContent = input.trim().length > 0;

  return (
    <div className="px-5 pb-5 pt-2">
      <div className="relative max-w-3xl mx-auto">
        <div className={cn(
          'composer-glow rounded-2xl border transition-all duration-300',
          'bg-[hsl(var(--card))] shadow-[0_0_0_1px_hsl(var(--border)),0_2px_8px_-2px_hsl(var(--foreground)/0.05)]',
          'focus-within:shadow-[0_0_0_1px_hsl(var(--primary)/0.3),0_4px_16px_-4px_hsl(var(--primary)/0.1)]',
          'focus-within:border-[hsl(var(--primary)/0.3)]'
        )}>
          <div className="px-4 pt-3 pb-1">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onInput={handleInput}
              placeholder="输入任务描述... (Enter 发送, Shift+Enter 换行)"
              className="w-full resize-none bg-transparent text-[14px] leading-[1.6] focus:outline-none placeholder:text-muted-foreground min-h-[48px] max-h-[200px]"
              rows={2}
              disabled={isLoading}
            />
          </div>

          <div className="flex items-center justify-between px-3 pb-2.5 pt-0.5">
            <div className="flex items-center gap-1.5" />

            <div className="flex items-center gap-1.5">
              {/* Read-only model display */}
              {modelName && (
                <span
                  className="px-2 py-1.5 text-[12px] font-medium text-foreground/50 truncate max-w-[160px]"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  {modelName}
                </span>
              )}

              <div className="w-px h-4 bg-border/60" />

              {isLoading ? (
                <button
                  onClick={onStop}
                  className={cn(
                    'shrink-0 h-8 w-8 rounded-xl flex items-center justify-center transition-all duration-200',
                    'bg-red-500/10 text-red-500 hover:bg-red-500/20 hover:scale-105 active:scale-95'
                  )}
                  title="停止"
                >
                  <Square className="h-3.5 w-3.5" fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!hasContent}
                  className={cn(
                    'shrink-0 h-8 w-8 rounded-xl flex items-center justify-center transition-all duration-300',
                    hasContent
                      ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] shadow-[0_2px_8px_-2px_hsl(var(--primary)/0.4)] hover:shadow-[0_4px_12px_-2px_hsl(var(--primary)/0.5)] hover:scale-105 active:scale-95'
                      : 'bg-muted/60 text-muted-foreground/50 cursor-not-allowed'
                  )}
                  title="发送"
                >
                  <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
        </div>

        <p className="text-center text-[11px] text-muted-foreground/50 mt-2.5 select-none">
          Claude Agent 将自主完成编码任务
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Delete ChatInput.tsx**

```bash
rm src/components/chat/ChatInput.tsx
```

- [ ] **Step 3: Commit**

```bash
git add src/components/agent/AgentInput.tsx src/components/chat/ChatInput.tsx
git commit -m "feat: replace ChatInput dropdown with read-only AgentInput"
```

---

### Task 9: Update AgentPanel

Wire up active provider config to the agent data flow.

**Files:**
- Modify: `src/components/agent/AgentPanel.tsx`

- [ ] **Step 1: Rewrite AgentPanel**

Replace `src/components/agent/AgentPanel.tsx`:

```tsx
import { useState, useEffect } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { AgentMessageList } from './AgentMessageList';
import { AgentInput } from './AgentInput';
import { DropdownMenu, DropdownMenuItem } from '../ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { FolderOpen, MoreHorizontal, Pencil } from 'lucide-react';

interface AgentPanelProps {
  sessionId: string;
}

export function AgentPanel({ sessionId }: AgentPanelProps) {
  const { sessions, updateSessionTitle } = useSessionStore();
  const { projects } = useProjectStore();
  const { startQuery, isRunning, interrupt, loadSessionMessages } = useAgentStore();
  const { config } = useSettingsStore();

  const session = sessions.find((s) => s.id === sessionId);
  const project = session?.project_id ? projects.find((p) => p.id === session.project_id) : null;
  const activeProvider = config?.providers.find((p) => p.id === config.active_provider_id) ?? null;

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  const handleRenameOpen = () => {
    setRenameValue(session?.title || '');
    setRenameOpen(true);
  };

  const handleRenameSave = async () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== session?.title) {
      await updateSessionTitle(sessionId, trimmed);
    }
    setRenameOpen(false);
  };

  const [cwd, setCwd] = useState(() => {
    return localStorage.getItem('agent-cwd') || '.';
  });

  useEffect(() => {
    loadSessionMessages(sessionId);
  }, [sessionId, loadSessionMessages]);

  useEffect(() => {
    if (project?.path) {
      setCwd(project.path);
      localStorage.setItem('agent-cwd', project.path);
    }
  }, [project?.path]);

  const running = isRunning[sessionId] || false;

  const handleSend = async (content: string) => {
    const apiKey = activeProvider?.api_key || undefined;
    const baseUrl = activeProvider?.anthropic_base_url || undefined;
    await startQuery(sessionId, content, cwd, apiKey, baseUrl);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border/40 bg-background/80 backdrop-blur-sm shrink-0">
        <h2 className="text-[13px] font-medium text-foreground/80 truncate">
          {session?.title || '新对话'}
        </h2>
        <DropdownMenu
          trigger={
            <button className="p-1 rounded-md hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors">
              <MoreHorizontal className="h-4 w-4" />
            </button>
          }
        >
          <DropdownMenuItem icon={<Pencil className="h-3.5 w-3.5" />} onClick={handleRenameOpen}>
            重命名
          </DropdownMenuItem>
        </DropdownMenu>
        <div className="flex-1" />
        {project && (
          <div className="flex items-center gap-1.5 text-[12px] text-foreground bg-muted/40 rounded-lg px-2.5 py-1.5 border border-border/30"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            <FolderOpen className="h-3 w-3 text-foreground/70 shrink-0" />
            <span className="truncate max-w-[200px]">{project.path}</span>
          </div>
        )}
      </div>

      {/* Message area */}
      <AgentMessageList sessionId={sessionId} />

      {/* Input composer */}
      <AgentInput
        onSend={handleSend}
        onStop={interrupt}
        isLoading={running}
        modelName={activeProvider?.default_model}
      />

      {/* Rename dialog */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>重命名对话</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRenameSave(); }}
            placeholder="输入对话名称"
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>取消</Button>
            <Button onClick={handleRenameSave}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/agent/AgentPanel.tsx
git commit -m "feat: AgentPanel reads active provider config for apiKey and baseUrl"
```

---

### Task 10: Update Agent Store

Add `baseUrl` parameter to `startQuery`.

**Files:**
- Modify: `src/stores/agentStore.ts`

- [ ] **Step 1: Update startQuery signature and body**

In `src/stores/agentStore.ts`:

1. Change the `startQuery` type in the interface (line 35):

```typescript
startQuery: (sessionId: string, prompt: string, cwd: string, apiKey?: string, baseUrl?: string) => Promise<void>;
```

2. Change the implementation signature (line 84) and the `agentApi.startSession` call (line 107):

```typescript
startQuery: async (sessionId: string, prompt: string, cwd: string, apiKey?: string, baseUrl?: string) => {
    // ... existing title/message logic unchanged ...

    try {
      await agentApi.startSession(sessionId, prompt, cwd, (raw: string) => {
        // ... existing event parsing logic unchanged ...
      }, apiKey, baseUrl);
    } catch (err) {
      // ... existing error handling unchanged ...
    }
  },
```

- [ ] **Step 2: Commit**

```bash
git add src/stores/agentStore.ts
git commit -m "feat: agentStore.startQuery accepts baseUrl parameter"
```

---

### Task 11: Rewrite Provider Settings UI

Card-style provider list with modal editing.

**Files:**
- Rewrite: `src/components/settings/ProviderConfig.tsx`
- Delete: `src/components/settings/AgentConfig.tsx`
- Modify: `src/components/settings/SettingsDialog.tsx`

- [ ] **Step 1: Rewrite ProviderConfig.tsx**

Replace `src/components/settings/ProviderConfig.tsx` entirely:

```tsx
import { useState, useEffect } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import type { Provider } from '../../types/provider';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Plus, Loader2, CheckCircle, XCircle, Eye, EyeOff } from 'lucide-react';

const BUILT_IN_MODELS = [
  'claude-opus-4-20250514',
  'claude-sonnet-4-20250514',
  'claude-haiku-4-20250514',
];

function generateId(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

function maskKey(key: string): string {
  if (!key) return '未设置';
  if (key.length <= 8) return '••••••••';
  return key.slice(0, 4) + '••••' + key.slice(-4);
}

export function ProviderConfigPanel() {
  const { config, updateProvider, deleteProvider, setActiveProvider, fetchModels } = useSettingsStore();
  const providers = config?.providers ?? [];
  const activeId = config?.active_provider_id ?? null;

  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [fetchStatus, setFetchStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [fetchMessage, setFetchMessage] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const openEdit = (provider: Provider) => {
    setEditingProvider({ ...provider });
    setIsNew(false);
    setShowKey(false);
    setAvailableModels([]);
    setFetchStatus('idle');
    setDeleteConfirm(false);
  };

  const openNew = () => {
    setEditingProvider({
      id: generateId(),
      name: '',
      api_key: '',
      anthropic_base_url: '',
      openai_base_url: '',
      default_model: BUILT_IN_MODELS[1],
    });
    setIsNew(true);
    setShowKey(false);
    setAvailableModels([]);
    setFetchStatus('idle');
    setDeleteConfirm(false);
  };

  const closeModal = () => {
    setEditingProvider(null);
  };

  const handleSave = async () => {
    if (!editingProvider) return;
    await updateProvider(editingProvider);
    if (isNew) {
      await setActiveProvider(editingProvider.id);
    }
    closeModal();
  };

  const handleActivate = async () => {
    if (!editingProvider) return;
    await setActiveProvider(editingProvider.id);
    closeModal();
  };

  const handleDelete = async () => {
    if (!editingProvider) return;
    await deleteProvider(editingProvider.id);
    closeModal();
  };

  const handleFetchModels = async () => {
    if (!editingProvider) return;
    const url = editingProvider.anthropic_base_url || editingProvider.openai_base_url;
    if (!url || !editingProvider.api_key) return;

    setIsFetchingModels(true);
    setFetchStatus('idle');
    setFetchMessage('');
    try {
      const models = await fetchModels(editingProvider.api_key, url);
      setAvailableModels(models);
      setFetchStatus('success');
      setFetchMessage(`获取到 ${models.length} 个模型`);
    } catch (err) {
      setFetchStatus('error');
      setFetchMessage(`获取失败: ${err}`);
      setAvailableModels(BUILT_IN_MODELS);
    } finally {
      setIsFetchingModels(false);
    }
  };

  const updateField = (field: keyof Provider, value: string) => {
    if (!editingProvider) return;
    setEditingProvider({ ...editingProvider, [field]: value });
  };

  return (
    <div className="space-y-4">
      <h3 className="font-medium">供应商配置</h3>
      <p className="text-sm text-muted-foreground">管理 AI 供应商，激活的供应商将用于智能体。</p>

      {/* Provider cards */}
      <div className="flex flex-wrap gap-3">
        {providers.map((p) => (
          <div
            key={p.id}
            onClick={() => openEdit(p)}
            className="w-[200px] p-3 bg-card border rounded-lg cursor-pointer hover:border-primary/50 transition-colors"
            style={{
              borderColor: p.id === activeId ? 'hsl(var(--primary))' : undefined,
              borderWidth: p.id === activeId ? '2px' : '1px',
            }}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="font-medium text-sm truncate">{p.name || '未命名'}</span>
              {p.id === activeId && (
                <span className="text-[10px] bg-primary text-primary-foreground px-1.5 py-0.5 rounded-full">
                  激活
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground truncate">{p.default_model}</div>
            <div className="text-xs text-muted-foreground/60 mt-1">{maskKey(p.api_key)}</div>
          </div>
        ))}

        {/* Add card */}
        <div
          onClick={openNew}
          className="w-[200px] p-3 border border-dashed rounded-lg cursor-pointer hover:border-primary/50 transition-colors flex items-center justify-center min-h-[88px]"
        >
          <span className="text-sm text-muted-foreground">+ 添加供应商</span>
        </div>
      </div>

      {/* Edit modal */}
      <Dialog open={!!editingProvider} onOpenChange={(open) => !open && closeModal()}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{isNew ? '添加供应商' : '编辑供应商'}</DialogTitle>
          </DialogHeader>

          {editingProvider && (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">供应商名称</label>
                <Input
                  value={editingProvider.name}
                  onChange={(e) => updateField('name', e.target.value)}
                  placeholder="如 OpenRouter"
                />
              </div>

              <div>
                <label className="text-xs text-muted-foreground mb-1 block">API Key</label>
                <div className="relative">
                  <Input
                    type={showKey ? 'text' : 'password'}
                    value={editingProvider.api_key}
                    onChange={(e) => updateField('api_key', e.target.value)}
                    placeholder="输入 API Key"
                    className="pr-9"
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowKey(!showKey)}
                  >
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Anthropic Base URL</label>
                  <Input
                    value={editingProvider.anthropic_base_url}
                    onChange={(e) => updateField('anthropic_base_url', e.target.value)}
                    placeholder="https://api.anthropic.com"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">OpenAI Base URL</label>
                  <Input
                    value={editingProvider.openai_base_url}
                    onChange={(e) => updateField('openai_base_url', e.target.value)}
                    placeholder="可选"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs text-muted-foreground mb-1 block">默认模型</label>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <Select
                      value={editingProvider.default_model}
                      onValueChange={(value) => updateField('default_model', value)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(availableModels.length > 0 ? availableModels : BUILT_IN_MODELS).map((m) => (
                          <SelectItem key={m} value={m}>{m}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleFetchModels}
                    disabled={isFetchingModels || !editingProvider.api_key || !(editingProvider.anthropic_base_url || editingProvider.openai_base_url)}
                    className="shrink-0"
                  >
                    {isFetchingModels ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      '获取列表'
                    )}
                  </Button>
                </div>
                {fetchMessage && (
                  <p className={`text-xs mt-1 ${fetchStatus === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                    {fetchMessage}
                  </p>
                )}
              </div>
            </div>
          )}

          <DialogFooter className="flex justify-between">
            <div>
              {!isNew && (
                deleteConfirm ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-red-500">确认删除？</span>
                    <Button variant="destructive" size="sm" onClick={handleDelete}>确认</Button>
                    <Button variant="outline" size="sm" onClick={() => setDeleteConfirm(false)}>取消</Button>
                  </div>
                ) : (
                  <Button variant="ghost" size="sm" className="text-red-500" onClick={() => setDeleteConfirm(true)}>
                    删除
                  </Button>
                )
              )}
            </div>
            <div className="flex gap-2">
              {!isNew && editingProvider?.id !== activeId && (
                <Button variant="outline" onClick={handleActivate}>激活</Button>
              )}
              <Button variant="outline" onClick={closeModal}>取消</Button>
              <Button onClick={handleSave}>保存</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 2: Delete AgentConfig.tsx**

```bash
rm src/components/settings/AgentConfig.tsx
```

- [ ] **Step 3: Update SettingsDialog.tsx**

In `src/components/settings/SettingsDialog.tsx`:

1. Remove `AgentConfig` import
2. Remove the `agent` tab from the tabs array
3. Remove the `{activeTab === 'agent' && <AgentConfig />}` line
4. Import `ProviderConfigPanel` instead of `ProviderConfig`
5. Default to `'provider'` tab

```tsx
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { ThemeToggle } from './ThemeToggle';
import { ProviderConfigPanel } from './ProviderConfig';
import { Settings, Palette, Plug } from 'lucide-react';
import { cn } from '../../lib/utils';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type SettingsTab = 'general' | 'appearance' | 'provider';

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('provider');

  const tabs = [
    { id: 'provider' as SettingsTab, label: '供应商配置', icon: Plug },
    { id: 'appearance' as SettingsTab, label: '外观', icon: Palette },
    { id: 'general' as SettingsTab, label: '常规', icon: Settings },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px] h-[520px] p-0 flex flex-col">
        <div className="flex flex-1 overflow-hidden">
          <div className="w-40 border-r p-2 shrink-0">
            <DialogHeader className="p-2">
              <DialogTitle className="text-sm">设置</DialogTitle>
            </DialogHeader>
            <nav className="space-y-1 mt-2">
              {tabs.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  className={cn(
                    'w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left',
                    activeTab === id ? 'bg-accent text-accent-foreground' : 'hover:bg-accent'
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </nav>
          </div>

          <div className="flex-1 p-4 overflow-auto">
            {activeTab === 'general' && (
              <div className="space-y-4">
                <h3 className="font-medium">常规设置</h3>
                <p className="text-sm text-muted-foreground">管理应用的基本设置。</p>
              </div>
            )}
            {activeTab === 'appearance' && <ThemeToggle />}
            {activeTab === 'provider' && <ProviderConfigPanel />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: Clean compile.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/ src/stores/settingsStore.ts
git commit -m "feat: card-style provider settings with modal editing and model fetching"
```

---

### Task 12: Verify and Clean Up

Ensure everything works end-to-end.

- [ ] **Step 1: Clean up empty chat directory**

If `src/components/chat/` is now empty, remove it:

```bash
rmdir src/components/chat 2>/dev/null || true
```

- [ ] **Step 2: Full TypeScript check**

```bash
npx tsc --noEmit
```

Expected: Clean compile, no errors.

- [ ] **Step 3: Full Rust check**

```bash
cd src-tauri && cargo check
```

Expected: Clean compile.

- [ ] **Step 4: Build sidecar**

```bash
cd src-tauri/sidecar && npm run build
```

Expected: Clean build.

- [ ] **Step 5: Run the app and verify**

```bash
npm run tauri dev
```

Verify:
1. Settings → 供应商配置 shows card grid with default provider
2. Click card → modal opens with all fields
3. "获取列表" fetches models from endpoint
4. "保存" persists to config.json
5. "激活" switches active provider
6. Chat input shows model name as read-only text
7. Sending a message uses the active provider's apiKey + baseUrl

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: multi-provider agent mode complete"
```
