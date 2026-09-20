# Multi-Provider Agent Mode Design

**Date:** 2026-05-28
**Status:** Draft

## Overview

Redesign the provider system to support multiple providers for Agent mode. Remove the unused Chat mode. The active provider's config (API key, base URL, default model) flows to the Claude Code sidecar at query time.

## Data Model

### Provider (replaces current single-provider ProviderConfig)

```typescript
interface Provider {
  id: string;                // uuid
  name: string;              // user-defined, e.g. "OpenRouter"
  api_key: string;           // shared across Anthropic/OpenAI endpoints
  anthropic_base_url: string;  // for Claude Code agent-sdk
  openai_base_url: string;     // for future Codex support
  default_model: string;       // e.g. "claude-sonnet-4-20250514"
}
```

### AppConfig

```typescript
interface AppConfig {
  providers: Provider[];
  active_provider_id: string | null;
  theme: 'Light' | 'Dark' | 'System';
}
```

- `ApiType` enum is removed (no longer needed).
- Rust side mirrors the TypeScript types exactly, stored in `{app_data_dir}/config.json`.

### Default Provider

On first launch (no config.json), create one default provider:

```json
{
  "id": "<uuid>",
  "name": "默认",
  "api_key": "",
  "anthropic_base_url": "https://api.anthropic.com",
  "openai_base_url": "",
  "default_model": "claude-sonnet-4-20250514"
}
```

First provider is automatically set as `active_provider_id`.

Leaving `api_key` empty allows using Claude Code's own authentication.

## Settings UI

### Provider Tab (replaces current ProviderConfig)

**Layout:** Card-style grid. Each provider is a card showing name, active badge, default model, and masked API key. A dashed "添加供应商" card lets users add new providers.

**Interactions:**

| Action | Behavior |
|--------|----------|
| Click card | Open edit modal |
| "激活" button in modal | Set as active provider, save |
| "删除" button in modal | Remove provider (with confirmation) |
| "获取模型列表" button | Fetch from `{any_base_url}/v1/models`, populate model dropdown |
| "保存" button | Persist changes to config.json |
| "取消" button | Discard changes, close modal |

**Edit modal fields:**

1. 供应商名称 — text input
2. API Key — password input
3. Anthropic Base URL — text input
4. OpenAI Base URL — text input (optional)
5. 默认模型 — select dropdown (populated by "获取列表" or built-in fallback)

**Model fetching (方案 A: endpoint-type aware):**

- Use `anthropic_base_url` first; if empty, fall back to `openai_base_url`.
- Try `{chosen_url}/v1/models` with the filled API key.
- On success: populate the model select dropdown with returned models.
- On failure (e.g. direct Anthropic API has no `/v1/models`): show built-in list:
  - `claude-opus-4-20250514`
  - `claude-sonnet-4-20250514`
  - `claude-haiku-4-20250514`

### Agent Tab

Remove the separate API key input from `AgentConfig.tsx`. Provider config now handles authentication. The agent tab can be removed entirely or repurposed.

### Appearance / General Tabs

No changes.

## Chat Input (AgentPanel)

Replace the model dropdown with read-only text showing the active provider's default model name. Keep the existing input layout unchanged.

Current `ChatInput.tsx` behavior: dropdown with hardcoded MODELS list, model selection stored in localStorage but never forwarded to agent.

New behavior: display `active_provider.default_model` as static text. No dropdown, no localStorage model key.

Rename `ChatInput.tsx` to `AgentInput.tsx`.

## Data Flow

```
AgentPanel.handleSend()
  ↓
Read active_provider from AppConfig (via settingsStore)
  ↓
agentStore.startQuery(sessionId, content, cwd, apiKey, baseUrl)
  ↓
agentApi.startSession(sessionId, prompt, cwd, onEvent, apiKey, baseUrl)
  ↓
Tauri invoke: start_agent_session { sessionId, prompt, cwd, apiKey, baseUrl }
  ↓
Rust command: build sidecar JSON with apiKey + baseUrl
  ↓
Sidecar receives: { type: "start", prompt, cwd, sessionId, apiKey, baseUrl }
  ↓
Set process.env.ANTHROPIC_API_KEY = apiKey
Set process.env.ANTHROPIC_BASE_URL = baseUrl
  ↓
Call claude-agent-sdk query()
```

### Sidecar Changes

- `SidecarCommand` type: add `baseUrl?: string` field to the `start` variant.
- `handleStart`: set `process.env.ANTHROPIC_BASE_URL = cmd.baseUrl` (in addition to existing `ANTHROPIC_API_KEY`).
- `cmd.model`: remove from type entirely (model is not passed to SDK; it uses the provider's configured model or SDK default).

### Rust Command Changes

- `start_agent_session`: accept `base_url: Option<String>` parameter. Build sidecar command JSON with both `apiKey` and `baseUrl`.
- Remove the broken fallback that reads active provider's key from AppConfig (lines 69-78 in `commands.rs`). The frontend is now responsible for always passing the correct key.

### Frontend API Changes

- `agentApi.startSession`: add `baseUrl` parameter.
- `agentStore.startQuery`: add `baseUrl` parameter.
- `AgentPanel.handleSend`: read active provider, pass `api_key` and `anthropic_base_url`.

## Files to Remove (Chat Mode)

### Frontend

| File | Reason |
|------|--------|
| `src/types/chat.ts` | Chat types, unused |
| `src/stores/chatStore.ts` | Chat store, unused |
| `src/components/chat/ChatPanel.tsx` | Chat panel, never rendered |
| `src/components/chat/MessageList.tsx` | Chat message list, unused |
| `src/components/chat/MessageItem.tsx` | Chat message item, unused |
| `src/components/chat/MarkdownRenderer.tsx` | Chat markdown, unused |
| `src/lib/tauri.ts` `chatApi` section | Chat API calls, unused |

### Rust

| File | Reason |
|------|--------|
| `src-tauri/src/commands/chat.rs` | Chat commands, unused |
| `src-tauri/src/provider/` (entire dir) | Provider impls only used by chat |
| `src-tauri/src/commands/mod.rs` | Remove `pub mod chat` |
| `src-tauri/src/lib.rs` | Remove `send_message` / `send_message_stream` from invoke_handler |

### Keep

| File | Reason |
|------|--------|
| `src/components/chat/ChatInput.tsx` | Used by AgentPanel, rename to AgentInput.tsx |
| `src/types/provider.ts` | Rewrite with new Provider/AppConfig types |
| `src-tauri/src/config/types.rs` | Rewrite with new Provider struct |
| `src-tauri/src/commands/provider.rs` | Update for multi-provider CRUD |

## Settings Store Changes

`settingsStore.ts` needs:

- `updateProvider(provider: Provider)` — upsert a provider in the list
- `deleteProvider(providerId: string)` — remove a provider
- `setActiveProvider(providerId: string)` — set active provider
- `fetchModels(apiKey: string, baseUrl: string): Promise<string[]>` — fetch available models from endpoint
- `getActiveProvider(): Provider | null` — helper to get the currently active provider

### New Tauri Command

`fetch_provider_models(api_key: String, base_url: String) -> Result<Vec<String>, String>` in `commands/provider.rs`:

- Calls `GET {base_url}/v1/models` with `Authorization: Bearer {api_key}`.
- Parses response, extracts model IDs.
- Returns `Vec<String>` of model IDs on success, error string on failure.
- Frontend calls this via `invoke('fetch_provider_models', { apiKey, baseUrl })`.

## Future Considerations

- **Codex support:** When adding Codex, the sidecar can check `openai_base_url` and use OpenAI SDK instead of claude-agent-sdk. The provider config already has the field.
- **Per-session provider:** Not in scope now, but the session model could store which provider was used for reproducibility.
