# Claude Agent SDK Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate `@anthropic-ai/claude-agent-sdk` into CodeMUX so users can run Claude Agent for autonomous coding tasks with full interactive UI.

**Architecture:** A Node.js sidecar process runs the Claude Agent SDK (`query()`), communicating with the Rust backend via stdin/stdout JSON. The Rust layer manages the sidecar lifecycle and forwards `SDKMessage` events to the frontend via Tauri IPC Channel. The frontend renders each event type (thinking, tool_use, tool_result, text, diff) as specialized UI components.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk` (sidecar), `tokio::process::Command` (Rust process management), `tauri::ipc::Channel` (frontend streaming), Zustand + React (frontend state/UI)

---

## File Map

### New Files

| File | Responsibility |
|---|---|
| `src-tauri/sidecar/package.json` | Sidecar npm dependencies |
| `src-tauri/sidecar/tsconfig.json` | TypeScript config for sidecar |
| `src-tauri/sidecar/src/index.ts` | Sidecar entry: stdin command loop, stdout event stream |
| `src-tauri/sidecar/src/types.ts` | Command/event type definitions |
| `src-tauri/src/agent/mod.rs` | Agent module: sidecar spawn, process management |
| `src-tauri/src/agent/commands.rs` | Tauri commands for agent operations |
| `src/types/agent.ts` | Frontend TypeScript types for agent messages |
| `src/stores/agentStore.ts` | Zustand store for agent session state |
| `src/components/agent/AgentPanel.tsx` | Main agent panel container |
| `src/components/agent/AgentMessageList.tsx` | Scrollable message list |
| `src/components/agent/ThinkingBlock.tsx` | Collapsible thinking display |
| `src/components/agent/ToolCallCard.tsx` | Tool call with name, input, result |
| `src/components/agent/DiffBlock.tsx` | File diff viewer (accept/reject) |
| `src/components/agent/TerminalBlock.tsx` | Bash command output |
| `src/components/agent/AgentStatusBar.tsx` | Session info, cost, token usage |

### Modified Files

| File | Change |
|---|---|
| `src-tauri/src/lib.rs` | Add `mod agent;` and register new commands |
| `src-tauri/src/commands/mod.rs` | Add `pub mod agent;` re-export |
| `src-tauri/src/db/schema.rs` | Add `mode` column to sessions table |
| `src-tauri/src/db/operations.rs` | Add `create_session_with_mode` function |
| `src/lib/tauri.ts` | Add `agentApi` object |
| `src/App.tsx` | Route to AgentPanel or ChatPanel based on session mode |
| `src/components/layout/Sidebar.tsx` | Add "Agent 任务" button |

---

## Task 1: Node.js Sidecar — Project Setup

**Files:**
- Create: `src-tauri/sidecar/package.json`
- Create: `src-tauri/sidecar/tsconfig.json`
- Create: `src-tauri/sidecar/src/types.ts`

- [ ] **Step 1: Create sidecar directory and package.json**

```bash
mkdir -p src-tauri/sidecar/src
```

Create `src-tauri/sidecar/package.json`:

```json
{
  "name": "codemux-agent-sidecar",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.1.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `src-tauri/sidecar/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": false
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create sidecar type definitions**

Create `src-tauri/sidecar/src/types.ts`:

```typescript
// Commands from Rust to sidecar (via stdin)
export type SidecarCommand =
  | { type: 'start'; prompt: string; cwd: string; sessionId?: string; apiKey?: string }
  | { type: 'interrupt' }
  | { type: 'shutdown' };

// The sidecar emits raw SDKMessage JSON lines to stdout.
// We re-export key shapes here for reference only.
export interface SidecarReadyEvent {
  type: 'sidecar_ready';
}

export interface SidecarErrorEvent {
  type: 'sidecar_error';
  error: string;
}
```

- [ ] **Step 4: Install sidecar dependencies**

```bash
cd src-tauri/sidecar && npm install
```

Expected: `node_modules/` and `package-lock.json` created, `@anthropic-ai/claude-agent-sdk` installed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/sidecar/
git commit -m "feat(agent): scaffold Node.js sidecar with Claude Agent SDK"
```

---

## Task 2: Node.js Sidecar — Main Entry Point

**Files:**
- Create: `src-tauri/sidecar/src/index.ts`

- [ ] **Step 1: Create sidecar entry point**

Create `src-tauri/sidecar/src/index.ts`:

```typescript
import * as readline from 'node:readline';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SidecarCommand } from './types.js';

let activeQuery: ReturnType<typeof query> | null = null;
let abortController: AbortController | null = null;

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handleStart(cmd: Extract<SidecarCommand, { type: 'start' }>): Promise<void> {
  if (activeQuery) {
    emit({ type: 'sidecar_error', error: 'A query is already active' });
    return;
  }

  if (cmd.apiKey) {
    process.env.ANTHROPIC_API_KEY = cmd.apiKey;
  }

  abortController = new AbortController();

  try {
    activeQuery = query({
      prompt: cmd.prompt,
      options: {
        cwd: cmd.cwd,
        resume: cmd.sessionId,
        abortController,
        permissionMode: 'auto',
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      },
    });

    for await (const message of activeQuery) {
      emit(message);
    }

    emit({ type: 'sidecar_query_done' });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg !== 'The operation was aborted') {
      emit({ type: 'sidecar_error', error: errorMsg });
    }
  } finally {
    activeQuery = null;
    abortController = null;
  }
}

function handleInterrupt(): void {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  activeQuery = null;
}

async function main(): Promise<void> {
  emit({ type: 'sidecar_ready' });

  const rl = readline.createInterface({ input: process.stdin });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let cmd: SidecarCommand;
    try {
      cmd = JSON.parse(trimmed) as SidecarCommand;
    } catch {
      emit({ type: 'sidecar_error', error: `Invalid JSON: ${trimmed}` });
      continue;
    }

    switch (cmd.type) {
      case 'start':
        // Run async but don't await — allows interrupt to be received during execution
        handleStart(cmd).catch((err) => {
          emit({ type: 'sidecar_error', error: String(err) });
        });
        break;
      case 'interrupt':
        handleInterrupt();
        break;
      case 'shutdown':
        process.exit(0);
        break;
    }
  }
}

main().catch((err) => {
  emit({ type: 'sidecar_error', error: `Fatal: ${String(err)}` });
  process.exit(1);
});
```

- [ ] **Step 2: Build sidecar**

```bash
cd src-tauri/sidecar && npx tsc
```

Expected: `dist/index.js` and `dist/types.js` created.

- [ ] **Step 3: Test sidecar starts and emits ready event**

```bash
echo '{"type":"shutdown"}' | node src-tauri/sidecar/dist/index.js
```

Expected output includes `{"type":"sidecar_ready"}` as the first line.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/sidecar/src/index.ts src-tauri/sidecar/dist/
git commit -m "feat(agent): implement sidecar entry point with stdin command loop"
```

---

## Task 3: Rust Agent Module — Process Management

**Files:**
- Create: `src-tauri/src/agent/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create agent module with sidecar process management**

Create `src-tauri/src/agent/mod.rs`:

```rust
pub mod commands;

use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

/// Handle to a running sidecar process.
pub struct SidecarHandle {
    child: Child,
    stdin_tx: mpsc::Sender<String>,
}

impl SidecarHandle {
    /// Send a command string to the sidecar's stdin.
    pub async fn send_command(&self, cmd: &str) -> Result<(), String> {
        self.stdin_tx
            .send(cmd.to_string())
            .await
            .map_err(|_| "Failed to send command to sidecar".to_string())
    }

    /// Kill the sidecar process.
    pub async fn shutdown(&mut self) {
        let _ = self.send_command(r#"{"type":"shutdown"}"#).await;
        let _ = self.child.wait().await;
    }
}

/// Path to the sidecar script (dist/index.js).
fn sidecar_script_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    resource_dir.join("sidecar").join("dist").join("index.js")
}

/// Spawn the sidecar process and return a handle + event receiver.
///
/// Events are raw JSON strings (one per line) from the sidecar's stdout.
/// The first event MUST be `{"type":"sidecar_ready"}`.
pub async fn spawn_sidecar(
    app_handle: &tauri::AppHandle,
) -> Result<(SidecarHandle, mpsc::Receiver<String>), String> {
    let script_path = sidecar_script_path(app_handle);

    // Try to find node executable
    let node_cmd = if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    };

    let mut child = Command::new(node_cmd)
        .arg(script_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}. Is Node.js installed?", e))?;

    // Set up stdin writer
    let stdin = child.stdin.take().ok_or("Failed to open sidecar stdin")?;
    let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(64);

    tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        let mut stdin = stdin;
        while let Some(msg) = stdin_rx.recv().await {
            let line = format!("{}\n", msg);
            if stdin.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if stdin.flush().await.is_err() {
                break;
            }
        }
    });

    // Set up stdout reader — uses oneshot to signal when the first event (ready) arrives
    let stdout = child.stdout.take().ok_or("Failed to open sidecar stdout")?;
    let (event_tx, event_rx) = mpsc::channel::<String>(256);
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();

    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        let mut ready_signaled = false;

        while let Ok(Some(line)) = lines.next_line().await {
            if !ready_signaled {
                if line.contains("sidecar_error") {
                    let _ = ready_tx.send(Err(format!("Sidecar error: {}", line)));
                    return;
                }
                let _ = ready_tx.send(Ok(()));
                ready_signaled = true;
            }
            if event_tx.send(line).await.is_err() {
                break;
            }
        }
    });

    // Wait for sidecar to signal ready
    match ready_rx.await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err("Sidecar died before signaling ready".to_string()),
    }

    // Log stderr
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[sidecar stderr] {}", line);
            }
        });
    }

    let handle = SidecarHandle { child, stdin_tx };
    Ok((handle, event_rx))
}
```

- [ ] **Step 2: Register agent module in lib.rs**

In `src-tauri/src/lib.rs`, add `mod agent;` after `mod provider;` (line 4):

```rust
mod db;
mod config;
mod commands;
mod provider;
mod agent;
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/agent/mod.rs src-tauri/src/lib.rs
git commit -m "feat(agent): add Rust agent module with sidecar process management"
```

---

## Task 4: Rust Agent Module — Tauri Commands

**Files:**
- Create: `src-tauri/src/agent/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create agent Tauri commands**

Create `src-tauri/src/agent/commands.rs`:

```rust
use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::sync::{Mutex, mpsc};

use super::{SidecarHandle, spawn_sidecar};

/// Managed state for the agent sidecar.
pub struct AgentState {
    pub sidecar: Arc<Mutex<Option<SidecarHandle>>>,
    /// The currently active frontend channel for receiving events.
    /// Set per-query; cleared when the query ends.
    pub active_channel: Arc<Mutex<Option<tauri::ipc::Channel<String>>>>,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            sidecar: Arc::new(Mutex::new(None)),
            active_channel: Arc::new(Mutex::new(None)),
        }
    }
}

/// Start a new agent session. Spawns the sidecar if needed, sends the prompt,
/// and streams SDKMessage JSON events back through the channel.
#[tauri::command]
pub async fn start_agent_session(
    app: AppHandle,
    agent_state: State<'_, AgentState>,
    session_id: String,
    prompt: String,
    cwd: String,
    channel: tauri::ipc::Channel<String>,
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

        // Spawn persistent forwarding task: reads from sidecar stdout,
        // forwards events to whichever frontend channel is currently active.
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

    // Read API key from app config
    let api_key = {
        let state: State<'_, crate::AppState> = app.state();
        let config = state.config.lock().unwrap();
        config
            .providers
            .iter()
            .find(|p| p.is_active)
            .map(|p| p.api_key.clone())
            .unwrap_or_default()
    };

    // Build and send start command
    let cmd = serde_json::json!({
        "type": "start",
        "prompt": prompt,
        "cwd": cwd,
        "sessionId": session_id,
        "apiKey": api_key,
    });

    let guard = agent_state.sidecar.lock().await;
    if let Some(handle) = guard.as_ref() {
        handle
            .send_command(&cmd.to_string())
            .await?;
    }

    Ok(())
}

/// Interrupt the currently running agent query and clear the active channel.
#[tauri::command]
pub async fn interrupt_agent_session(
    agent_state: State<'_, AgentState>,
) -> Result<(), String> {
    {
        let guard = agent_state.sidecar.lock().await;
        if let Some(handle) = guard.as_ref() {
            handle
                .send_command(r#"{"type":"interrupt"}"#)
                .await?;
        }
    }
    {
        let mut guard = agent_state.active_channel.lock().await;
        *guard = None;
    }
    Ok(())
}

/// Shutdown the sidecar process.
#[tauri::command]
pub async fn shutdown_agent(
    agent_state: State<'_, AgentState>,
) -> Result<(), String> {
    {
        let mut guard = agent_state.active_channel.lock().await;
        *guard = None;
    }
    let mut guard = agent_state.sidecar.lock().await;
    if let Some(mut handle) = guard.take() {
        handle.shutdown().await;
    }
    Ok(())
}

/// Interrupt the currently running agent query.
#[tauri::command]
pub async fn interrupt_agent_session(
    agent_state: State<'_, AgentState>,
) -> Result<(), String> {
    let guard = agent_state.sidecar.lock().await;
    if let Some(handle) = guard.as_ref() {
        handle
            .send_command(r#"{"type":"interrupt"}"#)
            .await?;
    }
    Ok(())
}

/// Shutdown the sidecar process.
#[tauri::command]
pub async fn shutdown_agent(
    agent_state: State<'_, AgentState>,
) -> Result<(), String> {
    let mut guard = agent_state.sidecar.lock().await;
    if let Some(mut handle) = guard.take() {
        handle.shutdown().await;
    }
    Ok(())
}
```

- [ ] **Step 2: Register commands and AgentState in lib.rs**

Update `src-tauri/src/lib.rs`:

```rust
mod db;
mod config;
mod commands;
mod provider;
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
            commands::chat::send_message,
            commands::chat::send_message_stream,
            commands::file::read_file,
            agent::commands::start_agent_session,
            agent::commands::interrupt_agent_session,
            agent::commands::shutdown_agent,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Verify Rust compiles**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: Compiles with no errors (warnings OK).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/agent/commands.rs src-tauri/src/lib.rs
git commit -m "feat(agent): add Tauri commands for agent session management"
```

---

## Task 5: Database — Session Mode Support

**Files:**
- Modify: `src-tauri/src/db/schema.rs`
- Modify: `src-tauri/src/db/operations.rs`
- Modify: `src/types/session.ts`

- [ ] **Step 1: Add mode column to sessions table**

In `src-tauri/src/db/schema.rs`, add migration after the existing CREATE TABLE statements:

```rust
use rusqlite::{Connection, Result};

pub fn initialize_database(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            provider_id TEXT,
            model TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS tool_calls (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            arguments TEXT,
            result TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
        CREATE INDEX IF NOT EXISTS idx_tool_calls_message_id ON tool_calls(message_id);
        "
    )?;

    // Migration: add mode column if missing
    let has_mode: bool = conn
        .prepare("SELECT mode FROM sessions LIMIT 0")
        .is_ok();
    if !has_mode {
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat'", []);
    }

    Ok(())
}
```

- [ ] **Step 2: Add create_session_with_mode operation**

In `src-tauri/src/db/operations.rs`, add after `create_session`:

```rust
pub fn create_session_with_mode(conn: &Connection, title: &str, mode: &str) -> Result<Session> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO sessions (id, title, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, title, mode, now, now],
    )?;

    Ok(Session {
        id,
        title: title.to_string(),
        provider_id: None,
        model: None,
        created_at: now.clone(),
        updated_at: now,
    })
}
```

Also update the `Session` struct to include `mode`:

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub mode: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
```

And update `get_all_sessions` to include `mode` in the SELECT:

```rust
pub fn get_all_sessions(conn: &Connection) -> Result<Vec<Session>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, provider_id, model, mode, created_at, updated_at FROM sessions ORDER BY updated_at DESC"
    )?;

    let sessions = stmt.query_map([], |row| {
        Ok(Session {
            id: row.get(0)?,
            title: row.get(1)?,
            provider_id: row.get(2)?,
            model: row.get(3)?,
            mode: row.get(4)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        })
    })?.collect::<Result<Vec<_>>>()?;

    Ok(sessions)
}
```

- [ ] **Step 3: Update frontend Session type**

In `src/types/session.ts`:

```typescript
export interface Session {
  id: string;
  title: string;
  provider_id: string | null;
  model: string | null;
  mode: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateSessionRequest {
  title: string;
  mode?: string;
}
```

- [ ] **Step 4: Verify Rust compiles**

```bash
cd src-tauri && cargo check 2>&1
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/ src/types/session.ts
git commit -m "feat(agent): add session mode support (chat/agent)"
```

---

## Task 6: Frontend — Agent Types and IPC Layer

**Files:**
- Create: `src/types/agent.ts`
- Modify: `src/lib/tauri.ts`

- [ ] **Step 1: Create agent type definitions**

Create `src/types/agent.ts`:

```typescript
/** Mode for a session */
export type SessionMode = 'chat' | 'agent';

/** Minimal representation of an SDKMessage from the sidecar */
export interface AgentEvent {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}

/** Parsed assistant content block */
export interface ContentBlock {
  type: 'text' | 'thinking' | 'tool_use';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/** Parsed assistant message */
export interface AgentAssistantMessage {
  type: 'assistant';
  uuid: string;
  session_id: string;
  message: {
    role: 'assistant';
    content: ContentBlock[];
    model?: string;
  };
  parent_tool_use_id: string | null;
}

/** Tool result from user message */
export interface AgentToolResult {
  type: 'user';
  uuid: string;
  session_id: string;
  message: {
    role: 'user';
    content: Array<{
      type: 'tool_result';
      tool_use_id: string;
      content: string;
    }>;
  };
  parent_tool_use_id: string | null;
}

/** System init message */
export interface AgentSystemMessage {
  type: 'system';
  subtype: 'init';
  uuid: string;
  session_id: string;
  tools: string[];
  model: string;
  cwd: string;
  permissionMode: string;
}

/** Final result message */
export interface AgentResultMessage {
  type: 'result';
  subtype: 'success' | string;
  uuid: string;
  session_id: string;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  terminal_reason?: string;
}

/** Sidecar lifecycle events */
export interface SidecarReadyEvent {
  type: 'sidecar_ready';
}

export interface SidecarErrorEvent {
  type: 'sidecar_error';
  error: string;
}

export interface SidecarQueryDoneEvent {
  type: 'sidecar_query_done';
}
```

- [ ] **Step 2: Add agentApi to tauri.ts**

In `src/lib/tauri.ts`, add the `agentApi` object:

```typescript
import { invoke, Channel } from '@tauri-apps/api/core';
import type { Session } from '../types/session';
import type { ChatMessage } from '../types/chat';
import type { AppConfig, ProviderConfig, Theme } from '../types/provider';

export const sessionApi = {
  create: (title: string): Promise<Session> => invoke('create_session', { title }),
  getAll: (): Promise<Session[]> => invoke('get_all_sessions'),
  delete: (sessionId: string): Promise<void> => invoke('delete_session', { sessionId }),
  updateTitle: (sessionId: string, title: string): Promise<void> => invoke('update_session_title', { sessionId, title }),
  getMessages: (sessionId: string): Promise<ChatMessage[]> => invoke('get_messages', { sessionId }),
};

export const chatApi = {
  sendMessage: (sessionId: string, content: string): Promise<string> => invoke('send_message', { sessionId, content }),
  sendMessageStream: (sessionId: string, content: string, onChunk: (token: string) => void): Promise<void> => {
    const channel = new Channel<string>();
    channel.onmessage = (token: string) => {
      onChunk(token);
    };
    return invoke('send_message_stream', { sessionId, content, channel });
  },
};

export const agentApi = {
  startSession: (
    sessionId: string,
    prompt: string,
    cwd: string,
    onEvent: (event: string) => void,
  ): Promise<void> => {
    const channel = new Channel<string>();
    channel.onmessage = (event: string) => {
      onEvent(event);
    };
    return invoke('start_agent_session', { sessionId, prompt, cwd, channel });
  },
  interrupt: (): Promise<void> => invoke('interrupt_agent_session'),
  shutdown: (): Promise<void> => invoke('shutdown_agent'),
};

export const configApi = {
  get: (): Promise<AppConfig> => invoke('get_config'),
  updateProvider: (provider: ProviderConfig): Promise<void> => invoke('update_provider', { provider }),
  setActiveProvider: (providerId: string): Promise<void> => invoke('set_active_provider', { providerId }),
  setTheme: (theme: Theme): Promise<void> => invoke('set_theme', { theme: theme.toLowerCase() }),
  testConnection: (provider: ProviderConfig): Promise<string> => invoke('test_connection', { provider }),
};

export const fileApi = {
  readFile: (path: string): Promise<string> => invoke('read_file', { path }),
};
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1
```

Expected: No errors related to the new files.

- [ ] **Step 4: Commit**

```bash
git add src/types/agent.ts src/lib/tauri.ts
git commit -m "feat(agent): add frontend agent types and IPC layer"
```

---

## Task 7: Frontend — Agent Store

**Files:**
- Create: `src/stores/agentStore.ts`

- [ ] **Step 1: Create agent Zustand store**

Create `src/stores/agentStore.ts`:

```typescript
import { create } from 'zustand';
import { agentApi } from '../lib/tauri';
import type {
  AgentAssistantMessage,
  AgentToolResult,
  AgentSystemMessage,
  AgentResultMessage,
  SidecarReadyEvent,
  SidecarErrorEvent,
} from '../types/agent';

export type AgentMessage =
  | { kind: 'assistant'; data: AgentAssistantMessage }
  | { kind: 'tool_result'; data: AgentToolResult }
  | { kind: 'system'; data: AgentSystemMessage }
  | { kind: 'result'; data: AgentResultMessage }
  | { kind: 'ready'; data: SidecarReadyEvent }
  | { kind: 'error'; data: SidecarErrorEvent }
  | { kind: 'done' }
  | { kind: 'raw'; data: Record<string, unknown> };

interface AgentState {
  /** Events for each session */
  events: Record<string, AgentMessage[]>;
  /** Whether a query is currently running */
  isRunning: Record<string, boolean>;
  /** Error message if any */
  error: Record<string, string | null>;

  /** Start a new agent query */
  startQuery: (sessionId: string, prompt: string, cwd: string) => Promise<void>;
  /** Interrupt the current query */
  interrupt: () => Promise<void>;
  /** Clear events for a session */
  clearEvents: (sessionId: string) => void;
}

function parseAgentEvent(raw: string): AgentMessage {
  try {
    const data = JSON.parse(raw);
    switch (data.type) {
      case 'sidecar_ready':
        return { kind: 'ready', data };
      case 'sidecar_error':
        return { kind: 'error', data };
      case 'sidecar_query_done':
        return { kind: 'done' };
      case 'assistant':
        return { kind: 'assistant', data };
      case 'user':
        return { kind: 'tool_result', data };
      case 'system':
        return { kind: 'system', data };
      case 'result':
        return { kind: 'result', data };
      default:
        return { kind: 'raw', data };
    }
  } catch {
    return { kind: 'raw', data: { type: 'parse_error', raw } };
  }
}

export const useAgentStore = create<AgentState>((set, get) => ({
  events: {},
  isRunning: {},
  error: {},

  startQuery: async (sessionId: string, prompt: string, cwd: string) => {
    set((state) => ({
      isRunning: { ...state.isRunning, [sessionId]: true },
      error: { ...state.error, [sessionId]: null },
      events: { ...state.events, [sessionId]: [] },
    }));

    try {
      await agentApi.startSession(sessionId, prompt, cwd, (raw: string) => {
        const event = parseAgentEvent(raw);
        set((state) => ({
          events: {
            ...state.events,
            [sessionId]: [...(state.events[sessionId] || []), event],
          },
        }));

        if (event.kind === 'done' || event.kind === 'error') {
          set((state) => ({
            isRunning: { ...state.isRunning, [sessionId]: false },
            error: event.kind === 'error'
              ? { ...state.error, [sessionId]: event.data.error }
              : state.error,
          }));
        }
      });
    } catch (err) {
      set((state) => ({
        isRunning: { ...state.isRunning, [sessionId]: false },
        error: { ...state.error, [sessionId]: String(err) },
      }));
    }
  },

  interrupt: async () => {
    await agentApi.interrupt();
  },

  clearEvents: (sessionId: string) => {
    set((state) => {
      const newEvents = { ...state.events };
      delete newEvents[sessionId];
      const newRunning = { ...state.isRunning };
      delete newRunning[sessionId];
      const newError = { ...state.error };
      delete newError[sessionId];
      return { events: newEvents, isRunning: newRunning, error: newError };
    });
  },
}));
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1
```

- [ ] **Step 3: Commit**

```bash
git add src/stores/agentStore.ts
git commit -m "feat(agent): add agent Zustand store with event parsing"
```

---

## Task 8: Frontend — Agent UI Components (Part 1: ThinkingBlock, TerminalBlock)

**Files:**
- Create: `src/components/agent/ThinkingBlock.tsx`
- Create: `src/components/agent/TerminalBlock.tsx`

- [ ] **Step 1: Create ThinkingBlock component**

Create `src/components/agent/ThinkingBlock.tsx`:

```tsx
import { useState } from 'react';
import { ChevronDown, ChevronRight, Brain } from 'lucide-react';

interface ThinkingBlockProps {
  thinking: string;
}

export function ThinkingBlock({ thinking }: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!thinking.trim()) return null;

  return (
    <div className="border rounded-md bg-muted/30 my-2">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <Brain className="h-4 w-4" />
        <span>思考过程</span>
      </button>
      {isExpanded && (
        <div className="px-3 pb-3 text-sm text-muted-foreground whitespace-pre-wrap border-t pt-2">
          {thinking}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create TerminalBlock component**

Create `src/components/agent/TerminalBlock.tsx`:

```tsx
import { useState } from 'react';
import { Terminal, ChevronDown, ChevronRight } from 'lucide-react';

interface TerminalBlockProps {
  command: string;
  output?: string;
  isRunning?: boolean;
}

export function TerminalBlock({ command, output, isRunning }: TerminalBlockProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div className="border rounded-md bg-black/90 my-2 font-mono text-sm">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-green-400 hover:bg-white/5 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <Terminal className="h-4 w-4" />
        <span className="truncate">{command}</span>
        {isRunning && <span className="ml-auto text-yellow-400 animate-pulse">运行中...</span>}
      </button>
      {isExpanded && output && (
        <div className="px-3 pb-3 text-gray-300 whitespace-pre-wrap border-t border-gray-700 pt-2 max-h-64 overflow-auto">
          {output}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/agent/ThinkingBlock.tsx src/components/agent/TerminalBlock.tsx
git commit -m "feat(agent): add ThinkingBlock and TerminalBlock components"
```

---

## Task 9: Frontend — Agent UI Components (Part 2: ToolCallCard, DiffBlock)

**Files:**
- Create: `src/components/agent/ToolCallCard.tsx`
- Create: `src/components/agent/DiffBlock.tsx`

- [ ] **Step 1: Create ToolCallCard component**

Create `src/components/agent/ToolCallCard.tsx`:

```tsx
import { useState } from 'react';
import {
  FileText,
  Edit3,
  Search,
  Globe,
  Terminal,
  ChevronDown,
  ChevronRight,
  Wrench,
} from 'lucide-react';

interface ToolCallCardProps {
  toolName: string;
  input: Record<string, unknown>;
  result?: string;
  status?: 'pending' | 'running' | 'done' | 'error';
}

const TOOL_ICONS: Record<string, typeof FileText> = {
  Read: FileText,
  Write: FileText,
  Edit: Edit3,
  Glob: Search,
  Grep: Search,
  Bash: Terminal,
  WebSearch: Globe,
  WebFetch: Globe,
};

function getToolSummary(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read':
      return String(input.file_path || '');
    case 'Write':
      return String(input.file_path || '');
    case 'Edit':
      return String(input.file_path || '');
    case 'Glob':
      return String(input.pattern || '');
    case 'Grep':
      return String(input.pattern || '');
    case 'Bash':
      return String(input.command || '');
    case 'WebSearch':
      return String(input.query || '');
    case 'WebFetch':
      return String(input.url || '');
    default:
      return JSON.stringify(input).slice(0, 80);
  }
}

export function ToolCallCard({ toolName, input, result, status }: ToolCallCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const Icon = TOOL_ICONS[toolName] || Wrench;
  const summary = getToolSummary(toolName, input);

  const statusColors = {
    pending: 'text-muted-foreground',
    running: 'text-yellow-500 animate-pulse',
    done: 'text-green-500',
    error: 'text-red-500',
  };

  return (
    <div className="border rounded-md my-2 bg-muted/20">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-muted/40 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <Icon className="h-4 w-4 text-blue-500" />
        <span className="font-medium">{toolName}</span>
        <span className="text-muted-foreground truncate flex-1 text-left">{summary}</span>
        {status && <span className={`text-xs ${statusColors[status]}`}>{status}</span>}
      </button>
      {isExpanded && (
        <div className="border-t px-3 py-2 space-y-2">
          <div>
            <div className="text-xs text-muted-foreground mb-1">参数</div>
            <pre className="text-xs bg-muted/50 rounded p-2 overflow-auto max-h-40">
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>
          {result && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">结果</div>
              <pre className="text-xs bg-muted/50 rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap">
                {result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create DiffBlock component**

Create `src/components/agent/DiffBlock.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { diffLines, type Change } from 'diff';
import { FileText, ChevronDown, ChevronRight } from 'lucide-react';

interface DiffBlockProps {
  filePath: string;
  oldContent: string;
  newContent: string;
}

export function DiffBlock({ filePath, oldContent, newContent }: DiffBlockProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  const changes = useMemo(() => diffLines(oldContent, newContent), [oldContent, newContent]);

  const fileName = filePath.split(/[/\\]/).pop() || filePath;

  return (
    <div className="border rounded-md my-2">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-muted/40 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <FileText className="h-4 w-4 text-orange-500" />
        <span className="font-medium">{fileName}</span>
        <span className="text-muted-foreground text-xs truncate">{filePath}</span>
      </button>
      {isExpanded && (
        <div className="border-t font-mono text-xs overflow-auto max-h-80">
          {changes.map((change: Change, i: number) => {
            const lines = change.value.split('\n').filter((l, idx, arr) =>
              idx < arr.length - 1 || l !== ''
            );
            return lines.map((line, j) => {
              let bgClass = '';
              let prefix = ' ';
              if (change.added) {
                bgClass = 'bg-green-500/10';
                prefix = '+';
              } else if (change.removed) {
                bgClass = 'bg-red-500/10';
                prefix = '-';
              }
              return (
                <div key={`${i}-${j}`} className={`px-3 py-0.5 ${bgClass}`}>
                  <span className="text-muted-foreground select-none mr-2">{prefix}</span>
                  {line}
                </div>
              );
            });
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/agent/ToolCallCard.tsx src/components/agent/DiffBlock.tsx
git commit -m "feat(agent): add ToolCallCard and DiffBlock components"
```

---

## Task 10: Frontend — Agent UI Components (Part 3: AgentMessageList, AgentStatusBar)

**Files:**
- Create: `src/components/agent/AgentMessageList.tsx`
- Create: `src/components/agent/AgentStatusBar.tsx`

- [ ] **Step 1: Create AgentMessageList component**

Create `src/components/agent/AgentMessageList.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { useAgentStore, type AgentMessage } from '../../stores/agentStore';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCallCard } from './ToolCallCard';
import { TerminalBlock } from './TerminalBlock';
import { MarkdownRenderer } from '../chat/MarkdownRenderer';
import { Loader2 } from 'lucide-react';

interface AgentMessageListProps {
  sessionId: string;
}

function AgentEventItem({ msg }: { msg: AgentMessage }) {
  switch (msg.kind) {
    case 'ready':
      return (
        <div className="text-xs text-muted-foreground py-2">
          Agent 已就绪
        </div>
      );

    case 'system':
      return (
        <div className="text-xs text-muted-foreground py-2 border-b mb-2">
          会话初始化 | 模型: {msg.data.model} | 工具: {msg.data.tools.length} 个
        </div>
      );

    case 'assistant': {
      const blocks = msg.data.message?.content || [];
      return (
        <div className="space-y-1">
          {blocks.map((block, i) => {
            if (block.type === 'thinking' && block.thinking) {
              return <ThinkingBlock key={i} thinking={block.thinking} />;
            }
            if (block.type === 'text' && block.text) {
              return (
                <div key={i} className="prose prose-sm dark:prose-invert max-w-none">
                  <MarkdownRenderer content={block.text} />
                </div>
              );
            }
            if (block.type === 'tool_use' && block.name) {
              return (
                <ToolCallCard
                  key={i}
                  toolName={block.name}
                  input={block.input || {}}
                />
              );
            }
            return null;
          })}
        </div>
      );
    }

    case 'tool_result': {
      const results = msg.data.message?.content || [];
      return (
        <div>
          {results.map((r, i) => {
            if (r.type === 'tool_result') {
              // Check if it's a bash result
              const content = r.content || '';
              if (content.length > 200) {
                return (
                  <TerminalBlock
                    key={i}
                    command={`tool_result: ${r.tool_use_id}`}
                    output={content}
                  />
                );
              }
              return (
                <div key={i} className="text-xs text-muted-foreground bg-muted/30 rounded p-2 my-1 whitespace-pre-wrap max-h-40 overflow-auto">
                  {content}
                </div>
              );
            }
            return null;
          })}
        </div>
      );
    }

    case 'result':
      return (
        <div className="border-t pt-2 mt-2 space-y-1">
          <div className="text-sm font-medium">
            {msg.data.subtype === 'success' ? '任务完成' : `任务结束: ${msg.data.subtype}`}
          </div>
          {msg.data.result && (
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <MarkdownRenderer content={msg.data.result} />
            </div>
          )}
          <div className="text-xs text-muted-foreground flex gap-4">
            <span>耗时: {(msg.data.duration_ms / 1000).toFixed(1)}s</span>
            <span>轮次: {msg.data.num_turns}</span>
            <span>费用: ${msg.data.total_cost_usd?.toFixed(4)}</span>
            <span>Token: {msg.data.usage?.input_tokens}+{msg.data.usage?.output_tokens}</span>
          </div>
        </div>
      );

    case 'error':
      return (
        <div className="text-sm text-red-500 bg-red-500/10 rounded p-2">
          错误: {msg.data.error}
        </div>
      );

    case 'done':
      return null;

    case 'raw':
      return (
        <details className="text-xs text-muted-foreground">
          <summary>原始事件: {String(msg.data.type)}</summary>
          <pre className="mt-1 bg-muted/30 rounded p-2 overflow-auto max-h-32">
            {JSON.stringify(msg.data, null, 2)}
          </pre>
        </details>
      );

    default:
      return null;
  }
}

export function AgentMessageList({ sessionId }: AgentMessageListProps) {
  const events = useAgentStore((s) => s.events[sessionId] || []);
  const isRunning = useAgentStore((s) => s.isRunning[sessionId] || false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  return (
    <div className="flex-1 overflow-auto p-4 space-y-2">
      {events.length === 0 && !isRunning && (
        <div className="text-center text-muted-foreground py-8">
          输入任务描述，让 Claude Agent 自主完成编码工作
        </div>
      )}
      {events.map((msg, i) => (
        <AgentEventItem key={i} msg={msg} />
      ))}
      {isRunning && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Agent 执行中...</span>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
```

- [ ] **Step 2: Create AgentStatusBar component**

Create `src/components/agent/AgentStatusBar.tsx`:

```tsx
import { useAgentStore } from '../../stores/agentStore';
import { Square, Loader2 } from 'lucide-react';
import { Button } from '../ui/button';

interface AgentStatusBarProps {
  sessionId: string;
}

export function AgentStatusBar({ sessionId }: AgentStatusBarProps) {
  const isRunning = useAgentStore((s) => s.isRunning[sessionId] || false);
  const error = useAgentStore((s) => s.error[sessionId]);
  const events = useAgentStore((s) => s.events[sessionId] || []);
  const interrupt = useAgentStore((s) => s.interrupt);

  // Find the latest result for stats
  const lastResult = [...events].reverse().find((e) => e.kind === 'result');

  if (!isRunning && !error && events.length === 0) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-t bg-muted/30 text-xs">
      {isRunning && (
        <>
          <Loader2 className="h-3 w-3 animate-spin text-yellow-500" />
          <span>执行中</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => interrupt()}
          >
            <Square className="h-3 w-3 mr-1" />
            中断
          </Button>
        </>
      )}
      {error && <span className="text-red-500">错误: {error}</span>}
      {lastResult && lastResult.kind === 'result' && (
        <span className="text-muted-foreground">
          完成 | {(lastResult.data.duration_ms / 1000).toFixed(1)}s |
          ${lastResult.data.total_cost_usd?.toFixed(4)}
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/agent/AgentMessageList.tsx src/components/agent/AgentStatusBar.tsx
git commit -m "feat(agent): add AgentMessageList and AgentStatusBar components"
```

---

## Task 11: Frontend — AgentPanel Main Container

**Files:**
- Create: `src/components/agent/AgentPanel.tsx`

- [ ] **Step 1: Create AgentPanel component**

Create `src/components/agent/AgentPanel.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { useSessionStore } from '../../stores/sessionStore';
import { AgentMessageList } from './AgentMessageList';
import { AgentStatusBar } from './AgentStatusBar';
import { ChatInput } from '../chat/ChatInput';

interface AgentPanelProps {
  sessionId: string;
}

export function AgentPanel({ sessionId }: AgentPanelProps) {
  const { sessions } = useSessionStore();
  const { startQuery, isRunning, clearEvents } = useAgentStore();
  const [cwd, setCwd] = useState('');

  const session = sessions.find((s) => s.id === sessionId);
  const running = isRunning[sessionId] || false;

  useEffect(() => {
    // Default cwd to current working directory (will be set by user or config)
    if (!cwd) {
      setCwd(process.cwd?.() || '.');
    }
  }, [cwd]);

  useEffect(() => {
    return () => {
      // Clean up events when unmounting
      // clearEvents(sessionId);
    };
  }, [sessionId]);

  const handleSend = async (content: string) => {
    await startQuery(sessionId, content, cwd);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="border-b px-4 py-3 flex items-center justify-between">
        <div>
          <h2 className="font-semibold">{session?.title || 'Agent 任务'}</h2>
          <div className="text-xs text-muted-foreground">
            工作目录: {cwd}
          </div>
        </div>
      </div>
      <AgentMessageList sessionId={sessionId} />
      <AgentStatusBar sessionId={sessionId} />
      <ChatInput onSend={handleSend} isLoading={running} />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/agent/AgentPanel.tsx
git commit -m "feat(agent): add AgentPanel main container"
```

---

## Task 12: Integration — App Routing and Sidebar

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Update App.tsx to route based on session mode**

Update `src/App.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { MainLayout } from './components/layout/MainLayout';
import { Sidebar } from './components/layout/Sidebar';
import { ChatPanel } from './components/chat/ChatPanel';
import { AgentPanel } from './components/agent/AgentPanel';
import { SettingsDialog } from './components/settings/SettingsDialog';
import { PreviewPanel } from './components/preview/PreviewPanel';
import { useSessionStore } from './stores/sessionStore';
import { useSettingsStore } from './stores/settingsStore';

function App() {
  const { createSession, activeSessionId, sessions } = useSessionStore();
  const { fetchConfig } = useSettingsStore();
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const handleNewSession = async (mode: 'chat' | 'agent' = 'chat') => {
    const title = mode === 'agent' ? '新 Agent 任务' : '新对话';
    await createSession(title, mode);
  };

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const isAgentMode = activeSession?.mode === 'agent';

  return (
    <>
      <MainLayout
        sidebar={
          <Sidebar onNewSession={handleNewSession} onOpenSettings={() => setSettingsOpen(true)} />
        }
        preview={<PreviewPanel />}
      >
        {activeSessionId ? (
          isAgentMode ? (
            <AgentPanel sessionId={activeSessionId} />
          ) : (
            <ChatPanel sessionId={activeSessionId} />
          )
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <h2 className="text-2xl font-bold mb-2">欢迎使用 CodeMUX</h2>
              <p className="text-muted-foreground">点击 "快速对话" 或 "Agent 任务" 开始</p>
            </div>
          </div>
        )}
      </MainLayout>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}

export default App;
```

- [ ] **Step 2: Update Sidebar with Agent button**

Update `src/components/layout/Sidebar.tsx`:

```tsx
import { SessionList } from '../session/SessionList';
import { Button } from '../ui/button';
import { Plus, Settings, Bot } from 'lucide-react';

interface SidebarProps {
  onNewSession: (mode?: 'chat' | 'agent') => void;
  onOpenSettings: () => void;
}

export function Sidebar({ onNewSession, onOpenSettings }: SidebarProps) {
  return (
    <div className="flex flex-col h-full bg-background">
      <div className="p-3 border-b">
        <h1 className="text-lg font-bold text-foreground">CodeMUX</h1>
      </div>

      {/* Top actions */}
      <div className="p-2 space-y-1">
        <Button variant="ghost" className="w-full justify-start gap-2 text-sm" onClick={() => onNewSession('chat')}>
          <Plus className="h-4 w-4" />
          快速对话
        </Button>
        <Button variant="ghost" className="w-full justify-start gap-2 text-sm" onClick={() => onNewSession('agent')}>
          <Bot className="h-4 w-4" />
          Agent 任务
        </Button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-auto">
        <div className="px-2 py-1">
          <span className="text-xs text-muted-foreground px-2">对话</span>
        </div>
        <SessionList />
      </div>

      {/* Bottom settings */}
      <div className="p-2 border-t">
        <Button variant="ghost" className="w-full justify-start gap-2 text-sm" onClick={onOpenSettings}>
          <Settings className="h-4 w-4" />
          设置
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Update createSession to accept mode parameter**

In `src/stores/sessionStore.ts`, update the `createSession` action to pass mode:

Check the current implementation of `sessionStore.ts` and update `createSession` to accept an optional `mode` parameter and pass it to the backend.

In `src/lib/tauri.ts`, update `sessionApi.create`:

```typescript
export const sessionApi = {
  create: (title: string, mode?: string): Promise<Session> => invoke('create_session', { title, mode }),
  // ... rest unchanged
};
```

In `src-tauri/src/commands/session.rs`, update `create_session` to accept `mode`:

```rust
#[tauri::command]
pub fn create_session(
    state: State<'_, AppState>,
    title: String,
    mode: Option<String>,
) -> Result<operations::Session, String> {
    let db = state.db.lock().unwrap();
    let mode_str = mode.as_deref().unwrap_or("chat");
    operations::create_session_with_mode(&db, &title, mode_str)
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Verify full app compiles and runs**

```bash
cd src-tauri && cargo check 2>&1
```

Then in a separate terminal:

```bash
npm run dev
```

Expected: App starts, sidebar shows both "快速对话" and "Agent 任务" buttons.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/components/layout/Sidebar.tsx src/lib/tauri.ts src/stores/sessionStore.ts src-tauri/src/commands/session.rs
git commit -m "feat(agent): integrate agent panel with app routing and sidebar"
```

---

## Task 13: Build and End-to-End Test

- [ ] **Step 1: Build the sidecar**

```bash
cd src-tauri/sidecar && npm run build
```

Expected: `dist/index.js` created.

- [ ] **Step 2: Verify sidecar starts**

```bash
echo '{"type":"shutdown"}' | node src-tauri/sidecar/dist/index.js
```

Expected: First line is `{"type":"sidecar_ready"}`.

- [ ] **Step 3: Run the full app**

```bash
npm run tauri dev
```

Expected: App launches, sidebar shows both buttons.

- [ ] **Step 4: Test Agent flow**

1. Click "Agent 任务" in sidebar
2. Type a simple task like "列出当前目录的文件"
3. Observe: thinking blocks, tool calls, and results stream in real-time
4. Verify: status bar shows completion stats

- [ ] **Step 5: Test interrupt**

1. Start a longer task
2. Click "中断" button in status bar
3. Verify: execution stops

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: complete Claude Agent SDK integration with interactive UI"
```
