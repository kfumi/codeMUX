# Model Selector Replacement Design

## Goal

Replace the custom `CodeMuxModelSelector` (provider chips + model list + reasoning effort) in the send box with assistant-ui's `@assistant-ui/model-selector` component. The send box will only show models from the current provider. Provider switching moves to Settings only. Each agent type has its own model loading logic.

## Architecture

### Data Flow

```
useAgentModels(agentKind, activeProfile, activeProfileId)
  → ModelOption[]
    → AgentModelSelector (wraps @assistant-ui/model-selector)
      → api.modelContext().register() → backend receives modelName + reasoningEffort
```

### File Changes

| File | Action |
|------|--------|
| `package.json` | Add `@assistant-ui/model-selector`, `cmdk`, `@radix-ui/react-popover` |
| `src-tauri/src/commands/file.rs` | Add `read_home_file` Tauri command |
| `src/lib/tauri.ts` | Add `readHomeFile` to `configApi` |
| `src/hooks/useAgentModels.ts` | **NEW** — agent-specific model loading hook |
| `src/components/agent/AgentModelSelector.tsx` | **NEW** — wrapper around assistant-ui ModelSelector |
| `src/components/agent/AgentPanel.tsx` | Modify — replace CodeMuxModelSelector, remove provider switching |
| `src/components/agent/NewSessionPanel.tsx` | Modify — replace CodeMuxModelSelector, remove provider switching |
| `src/components/agent/assistant-ui/CodeMuxModelSelector.tsx` | **DELETE** |
| `src/components/agent/assistant-ui/CodeMuxModelSelector.test.tsx` | **DELETE** |
| `src/components/agent/AgentPanel.ensure.test.tsx` | Update mock |
| `src/components/agent/NewSessionPanel.test.tsx` | Update mock |

## Component Design

### `useAgentModels` Hook

**Signature:**

```typescript
function useAgentModels(
  agentKind: AgentKind,
  activeProfile: AgentProviderProfile | null,
  activeProfileId: string | null,
): { models: ModelOption[]; isLoading: boolean }
```

**ModelOption type:**

```typescript
interface ModelOption {
  id: string;          // model ID sent to backend
  name: string;        // display name
  description?: string;
  efforts?: boolean;   // show reasoning effort toggle
}
```

**Agent-specific loading logic:**

#### Claude Code

Built-in models (always shown):

| id | name | efforts |
|----|------|---------|
| `sonnet` | Sonnet 5 | true |
| `opus` | Opus 4.8 | true |
| `fable` | Fable 5 | true |
| `haiku` | Haiku 4.5 | true |

If `activeProfile` exists:
- Extract models from `profileToSelectorProvider(profile)` → `getProviderModelList()`
- Merge into list, dedup by `id`
- Built-in models keep their display names; profile models use `formatModelDisplayName()`

#### Codex

**No active profile (default provider):**
- Read `~/.codex/models_cache.json` via new `readHomeFile` Tauri command
- Parse as `CodexCatalogModel[]` → map to `ModelOption[]`
- File not found → return empty array

**Has active profile (custom provider):**
- Start with `profile.models`
- Read `~/.codex/codemux-model-catalog.json` via `readHomeFile`
- Parse as `CodexCatalogModel[]` → merge, dedup by `model`/`id`
- File not found → use only profile models

#### OpenCode

Free models (always shown):

| id | name |
|----|------|
| `opencode/nemotron-3-ultra-free` | Nemotron 3 Ultra |
| `opencode/north-mini-code-free` | North Mini Code |
| `opencode/deepseek-v4-flash-free` | DeepSeek V4 Flash |
| `opencode/mimo-v2.5-free` | Mimo V2.5 |
| `opencode/big-pickle` | Big Pickle |

If `activeProfile` exists:
- Read `~/.config/opencode/opencode.json` via `readHomeFile`
- Extract `provider.{key}.models` → map to `ModelOption[]`
- Merge free models + file models + profile models, dedup by `id`
- File not found → use only free models + profile models

### `AgentModelSelector` Component

**Props:**

```typescript
interface AgentModelSelectorProps {
  agentKind: AgentKind;
  activeProfile: AgentProviderProfile | null;
  activeProfileId: string | null;
  value: string;
  onChange: (modelId: string) => void;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  disabled?: boolean;
  compact?: boolean;
}
```

**Implementation:**

1. Call `useAgentModels(agentKind, activeProfile, activeProfileId)` to get model list
2. Use `useAui()` to get assistant-ui API
3. Register model context via `useEffect`:
   ```typescript
   useEffect(() => {
     if (!value) return;
     return api.modelContext().register({
       getModelContext: () => ({
         config: { modelName: value, reasoningEffort },
       }),
     });
   }, [api, value, reasoningEffort]);
   ```
4. Render assistant-ui `ModelSelector`:
   - `searchable` — enable search
   - `size="sm"` — compact mode
   - `efforts: true` on all models — reasoning effort toggle
   - Model list from `useAgentModels` passed to `models` prop
   - Apply `formatModelDisplayName()` to each model's `name` field for display (handles `[1m]` suffix for Claude Code large context models)

### AgentPanel Changes

**Remove:**
- `import { CodeMuxModelSelector }` and `import { getProviderModelList }`
- `availableProviders` computation
- `selectorProvider` computation
- `providerModels` computation
- `handleProviderChange` callback

**Replace `<CodeMuxModelSelector>` with:**

```tsx
<AgentModelSelector
  agentKind={agentKind}
  activeProfile={activeProfile}
  activeProfileId={activeProfileId}
  value={selectorModel}
  onChange={handleModelChange}
  reasoningEffort={reasoningEffort}
  onReasoningEffortChange={handleReasoningEffortChange}
  disabled={isRunning}
  compact={compact}
/>
```

**Keep:** `handleModelChange`, `handleReasoningEffortChange`, `formatSelectedProviderModel`, `modelNameWithSuffix`

### NewSessionPanel Changes

**Remove:**
- `import { CodeMuxModelSelector }` and `import { getProviderModelList }`
- `availableProviders`, `selectedProvider`, `providerModels` computations
- `formatSelectedProviderModel`
- `onProviderChange` handler

**Simplify useEffect:** Remove `setSelectedProviderId` — provider is always the active one.

**Simplify `hasUsableProfile`:** No longer depends on `selectedProviderId` matching.

**Replace `<CodeMuxModelSelector>` with:**

```tsx
<AgentModelSelector
  agentKind={selectedAgentKind}
  activeProfile={activeProfile}
  activeProfileId={activeProfileId}
  value={effectiveModel}
  onChange={setSelectedModel}
  reasoningEffort={selectedReasoningEffort}
  onReasoningEffortChange={setSelectedReasoningEffort}
/>
```

## Error Handling

| Scenario | Handling |
|----------|----------|
| File not found (`models_cache.json`, etc.) | try-catch, silent fallback to empty/partial list |
| JSON parse failure | `console.warn`, skip that file source |
| Empty model list | Trigger shows "选择模型", send button disabled |
| Current model not in new list | Auto-select first model |
| Async loading in progress | Return `isLoading: true`, trigger shows loading state |
| Profile models duplicate built-in models | Dedup by `id`, built-in models take priority |

## New Tauri Command: `read_home_file`

`fileApi.readFile` has security restrictions (path must be under base directory) and doesn't support `~` expansion. Add a new command for reading files from the user's home directory:

```rust
#[tauri::command]
pub fn read_home_file(relative_path: String) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("无法获取用户主目录")?;
    let path = home.join(&relative_path);
    std::fs::read_to_string(&path).map_err(|e| format!("文件读取失败: {}", e))
}
```

Frontend wrapper in `src/lib/tauri.ts`:
```typescript
readHomeFile: (relativePath: string): Promise<string> =>
    invokeLogged('read_home_file', { relativePath }),
```

Usage in `useAgentModels`:
```typescript
const content = await readHomeFile('.codex/models_cache.json');
```

## Testing Strategy

1. **Unit tests:** Test `useAgentModels` hook with mock `readHomeFile` responses
2. **Tauri command test:** Test `read_home_file` with existing, missing, and invalid paths
3. **Update existing test mocks:** `AgentPanel.ensure.test.tsx`, `NewSessionPanel.test.tsx`
4. **Manual testing:**
   - Claude Code: built-in models only (no profile) + built-in + profile models
   - Codex default: models from `models_cache.json`
   - Codex custom: profile + `codemux-model-catalog.json`
   - OpenCode: free models + `opencode.json` models
   - File not found scenarios
   - Model selection persistence
   - Reasoning effort toggle
   - No provider switching in send box
   - Provider switching works in Settings
