# Model Selector Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the custom `CodeMuxModelSelector` with assistant-ui's `@assistant-ui/model-selector`, remove provider switching from the send box, and implement agent-specific model loading.

**Architecture:** New `useAgentModels` hook loads models per agent type (Claude Code built-ins, Codex file-based, OpenCode free + file-based). New `AgentModelSelector` component wraps assistant-ui's `ModelSelector`. Old `CodeMuxModelSelector` deleted.

**Tech Stack:** `@assistant-ui/model-selector`, `cmdk`, `@radix-ui/react-popover`, React hooks, Tauri IPC

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src-tauri/src/commands/file.rs` | Add `read_home_file` command for home directory access |
| `src-tauri/src/lib.rs` | Register `read_home_file` command |
| `src/lib/tauri.ts` | Add `readHomeFile` to API layer |
| `src/hooks/useAgentModels.ts` | Agent-specific model loading logic (new) |
| `src/components/agent/AgentModelSelector.tsx` | Wrapper around assistant-ui ModelSelector (new) |
| `src/components/agent/AgentPanel.tsx` | Replace CodeMuxModelSelector, remove provider switching |
| `src/components/agent/NewSessionPanel.tsx` | Replace CodeMuxModelSelector, remove provider switching |
| `src/components/agent/assistant-ui/CodeMuxModelSelector.tsx` | Delete |
| `src/components/agent/assistant-ui/CodeMuxModelSelector.test.tsx` | Delete |
| `src/components/agent/AgentPanel.ensure.test.tsx` | Update mock |
| `src/components/agent/NewSessionPanel.test.tsx` | Update mock |
| `src/hooks/useAgentModels.test.ts` | New unit tests |

---

### Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install packages**

```bash
npm install @assistant-ui/model-selector cmdk @radix-ui/react-popover
```

- [ ] **Step 2: Verify installation**

```bash
npm ls @assistant-ui/model-selector cmdk @radix-ui/react-popover
```

Expected: All three packages listed with version numbers.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add @assistant-ui/model-selector, cmdk, @radix-ui/react-popover"
```

---

### Task 2: Add `read_home_file` Tauri Command

**Files:**
- Modify: `src-tauri/src/commands/file.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/tauri.ts`

- [ ] **Step 1: Add Rust command to `src-tauri/src/commands/file.rs`**

Add at the end of the file (before the last closing brace if any, or at end of file):

```rust
/// Read a file from the user's home directory.
/// `relative_path` is relative to ~ (e.g. ".codex/models_cache.json").
#[tauri::command]
pub fn read_home_file(relative_path: String) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("无法获取用户主目录")?;
    let path = home.join(&relative_path);
    std::fs::read_to_string(&path).map_err(|e| format!("文件读取失败: {}", e))
}
```

- [ ] **Step 2: Register command in `src-tauri/src/lib.rs`**

Find the `invoke_handler` call and add `commands::file::read_home_file` to the list. Search for existing file commands like `read_file` to find the right location:

```rust
// Add this line next to the other file commands:
commands::file::read_home_file,
```

- [ ] **Step 3: Add `dirs` dependency if not present**

Check `src-tauri/Cargo.toml` for `dirs` crate. If not present:

```toml
[dependencies]
dirs = "5"
```

- [ ] **Step 4: Add frontend wrapper to `src/lib/tauri.ts`**

In the `configApi` object (or create a new `homeFileApi` object), add:

```typescript
readHomeFile: (relativePath: string): Promise<string> =>
    invokeLogged('read_home_file', { relativePath }),
```

- [ ] **Step 5: Verify Rust compiles**

```bash
cd src-tauri && cargo check --all-targets --all-features
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/file.rs src-tauri/src/lib.rs src/lib/tauri.ts
git commit -m "feat(tauri): add read_home_file command for home directory access"
```

---

### Task 3: Create `useAgentModels` Hook

**Files:**
- Create: `src/hooks/useAgentModels.ts`

- [ ] **Step 1: Create the hook file `src/hooks/useAgentModels.ts`**

```typescript
import { useEffect, useMemo, useState } from 'react';

import { getProviderModelList } from '../lib/providerModels';
import { profileToSelectorProvider } from '../lib/agentProfileSelector';
import { formatModelDisplayName } from '../components/agent/modelDisplay';
import { configApi } from '../lib/tauri';
import type { AgentKind } from '../types/session';
import type { AgentProviderProfile, CodexCatalogModel, OpenCodeModel } from '../types/provider';

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  efforts?: boolean;
}

const CLAUDE_BUILTINS: ModelOption[] = [
  { id: 'sonnet', name: 'Sonnet 5', efforts: true },
  { id: 'opus', name: 'Opus 4.8', efforts: true },
  { id: 'fable', name: 'Fable 5', efforts: true },
  { id: 'haiku', name: 'Haiku 4.5', efforts: true },
];

const OPENCODE_FREE_MODELS: ModelOption[] = [
  { id: 'opencode/nemotron-3-ultra-free', name: 'Nemotron 3 Ultra' },
  { id: 'opencode/north-mini-code-free', name: 'North Mini Code' },
  { id: 'opencode/deepseek-v4-flash-free', name: 'DeepSeek V4 Flash' },
  { id: 'opencode/mimo-v2.5-free', name: 'Mimo V2.5' },
  { id: 'opencode/big-pickle', name: 'Big Pickle' },
];

function dedupModels(models: ModelOption[]): ModelOption[] {
  const seen = new Set<string>();
  return models.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

async function readJsonHomeFile<T>(relativePath: string): Promise<T | null> {
  try {
    const content = await configApi.readHomeFile(relativePath);
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function codexCatalogToModels(catalog: CodexCatalogModel[]): ModelOption[] {
  return catalog.map((entry) => ({
    id: entry.model,
    name: entry.displayName ?? entry.model,
    efforts: true,
  }));
}

function opencodeConfigToModels(
  config: Record<string, { models?: Record<string, OpenCodeModel> }>,
  providerKey: string,
): ModelOption[] {
  const provider = config[providerKey];
  if (!provider?.models) return [];
  return Object.entries(provider.models).map(([name, _]) => ({
    id: `${providerKey}/${name}`,
    name,
  }));
}

function mergeWithProfileModels(
  base: ModelOption[],
  profile: AgentProviderProfile,
  agentKind: AgentKind,
): ModelOption[] {
  const provider = profileToSelectorProvider(profile);
  const profileModelIds = getProviderModelList(provider);
  const profileModels: ModelOption[] = profileModelIds.map((id) => ({
    id,
    name: formatModelDisplayName({ model: id, agentKind, usesLargeContext: false }),
    efforts: true,
  }));
  return dedupModels([...base, ...profileModels]);
}

async function loadClaudeModels(
  activeProfile: AgentProviderProfile | null,
): Promise<ModelOption[]> {
  if (!activeProfile) return CLAUDE_BUILTINS;
  return mergeWithProfileModels(CLAUDE_BUILTINS, activeProfile, 'claude_code');
}

async function loadCodexModels(
  activeProfile: AgentProviderProfile | null,
): Promise<ModelOption[]> {
  if (!activeProfile) {
    const cache = await readJsonHomeFile<CodexCatalogModel[]>('.codex/models_cache.json');
    return cache ? codexCatalogToModels(cache) : [];
  }
  const catalog = await readJsonHomeFile<CodexCatalogModel[]>('.codex/codemux-model-catalog.json');
  const fileModels = catalog ? codexCatalogToModels(catalog) : [];
  return dedupModels([...fileModels, ...activeProfile.models.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    efforts: true,
  }))]);
}

async function loadOpenCodeModels(
  activeProfile: AgentProviderProfile | null,
): Promise<ModelOption[]> {
  const fileConfig = await readJsonHomeFile<Record<string, { models?: Record<string, OpenCodeModel> }>>(
    '.config/opencode/opencode.json',
  );
  const providerKey = activeProfile?.native_config.type === 'opencode'
    ? (activeProfile.native_config.provider_key ?? 'codemux-openai')
    : 'codemux-openai';
  const fileModels = fileConfig ? opencodeConfigToModels(fileConfig, providerKey) : [];
  const base = dedupModels([...OPENCODE_FREE_MODELS, ...fileModels]);
  if (!activeProfile) return base;
  return mergeWithProfileModels(base, activeProfile, 'opencode');
}

export function useAgentModels(
  agentKind: AgentKind,
  activeProfile: AgentProviderProfile | null,
  activeProfileId: string | null,
): { models: ModelOption[]; isLoading: boolean } {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    const load = async () => {
      try {
        let result: ModelOption[];
        switch (agentKind) {
          case 'claude_code':
            result = await loadClaudeModels(activeProfile);
            break;
          case 'codex':
            result = await loadCodexModels(activeProfile);
            break;
          case 'opencode':
            result = await loadOpenCodeModels(activeProfile);
            break;
          default:
            result = [];
        }
        if (!cancelled) setModels(result);
      } catch {
        if (!cancelled) setModels([]);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void load();
    return () => { cancelled = true; };
  }, [agentKind, activeProfileId]);

  return useMemo(() => ({ models, isLoading }), [models, isLoading]);
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run build
```

Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useAgentModels.ts
git commit -m "feat(hooks): add useAgentModels hook for agent-specific model loading"
```

---

### Task 4: Create `AgentModelSelector` Component

**Files:**
- Create: `src/components/agent/AgentModelSelector.tsx`

- [ ] **Step 1: Create the component file**

```tsx
import { useAui } from '@assistant-ui/react';
import { ModelSelector } from '@assistant-ui/model-selector';
import { useEffect } from 'react';

import { useAgentModels, type ModelOption } from '../../hooks/useAgentModels';
import { formatModelDisplayName } from './modelDisplay';
import type { AgentKind, ReasoningEffort } from '../../types/session';
import type { AgentProviderProfile } from '../../types/provider';

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

export function AgentModelSelector({
  agentKind,
  activeProfile,
  activeProfileId,
  value,
  onChange,
  reasoningEffort,
  onReasoningEffortChange,
  disabled,
  compact,
}: AgentModelSelectorProps) {
  const api = useAui();
  const { models, isLoading } = useAgentModels(agentKind, activeProfile, activeProfileId);

  useEffect(() => {
    if (!value) return;
    return api.modelContext().register({
      getModelContext: () => ({
        config: { modelName: value, reasoningEffort },
      }),
    });
  }, [api, value, reasoningEffort]);

  const displayModels = models.map((m) => ({
    ...m,
    name: formatModelDisplayName({ model: m.name, agentKind, usesLargeContext: false }),
  }));

  const selectedModel = displayModels.find((m) => m.id === value) ?? displayModels[0];

  return (
    <ModelSelector
      models={displayModels}
      value={value || selectedModel?.id || ''}
      onValueChange={onChange}
      effort={reasoningEffort}
      onEffortChange={onReasoningEffortChange}
      searchable
      size="sm"
      disabled={disabled || isLoading}
    />
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run build
```

Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/agent/AgentModelSelector.tsx
git commit -m "feat(agent): add AgentModelSelector wrapping assistant-ui ModelSelector"
```

---

### Task 5: Update AgentPanel

**Files:**
- Modify: `src/components/agent/AgentPanel.tsx`

- [ ] **Step 1: Update imports**

Remove:
```typescript
import { CodeMuxModelSelector } from './assistant-ui/CodeMuxModelSelector';
```
Remove `getProviderModelList` from the import on the `providerModels` line.

Add:
```typescript
import { AgentModelSelector } from './AgentModelSelector';
```

- [ ] **Step 2: Remove provider-related state**

Remove these lines (approximately lines 76-80):
```typescript
const selectorProvider = useMemo(() => activeProfile ? profileToSelectorProvider(activeProfile) : null, [activeProfile]);
```
```typescript
const providerModels = useMemo(() => getProviderModelList(selectorProvider), [selectorProvider]);
```
```typescript
const availableProviders = useMemo(() => availableProfiles.map(profileToSelectorProvider), [availableProfiles]);
```

- [ ] **Step 3: Remove `handleProviderChange` callback**

Remove the entire `handleProviderChange` function (approximately lines 206-217).

- [ ] **Step 4: Replace `<CodeMuxModelSelector>` with `<AgentModelSelector>`**

Find the `<CodeMuxModelSelector>` JSX block and replace it with:

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

- [ ] **Step 5: Remove unused imports**

Remove `getProviderModelList` from `providerModels` import if no longer used elsewhere. Keep `profileToSelectorProvider` if still used by `formatSelectedProviderModel`.

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npm run build
```

Expected: No type errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/agent/AgentPanel.tsx
git commit -m "feat(agent): replace CodeMuxModelSelector with AgentModelSelector in AgentPanel"
```

---

### Task 6: Update NewSessionPanel

**Files:**
- Modify: `src/components/agent/NewSessionPanel.tsx`

- [ ] **Step 1: Update imports**

Remove:
```typescript
import { CodeMuxModelSelector } from './assistant-ui/CodeMuxModelSelector';
```
Remove `getProviderModelList` and `getPrimaryProviderModel` from the providerModels import.

Add:
```typescript
import { AgentModelSelector } from './AgentModelSelector';
```

- [ ] **Step 2: Remove provider-related state**

Remove these lines:
```typescript
const availableProviders = useMemo(
  () => availableProfiles.map(profileToSelectorProvider),
  [availableProfiles],
);
```
```typescript
const selectedProvider = useMemo(
  () => availableProviders.find((provider) => provider.id === selectedProviderId)
    ?? availableProviders.find((provider) => provider.id === activeProfileId)
    ?? null,
  [activeProfileId, availableProviders, selectedProviderId],
);
```
```typescript
const providerModels = useMemo(() => getProviderModelList(selectedProvider), [selectedProvider]);
```
```typescript
const effectiveModel = selectedModel || getPrimaryProviderModel(selectedProvider);
```

Replace `effectiveModel` with:
```typescript
const effectiveModel = selectedModel || (() => {
  const profile = availableProfiles.find((p) => p.id === activeProfileId);
  return profile?.models.find((m) => m.id.trim())?.id.trim() ?? '';
})();
```

- [ ] **Step 3: Remove `formatSelectedProviderModel`**

Remove the `formatSelectedProviderModel` useMemo block (approximately lines 80-86).

- [ ] **Step 4: Simplify `hasUsableProfile`**

Replace:
```typescript
const hasUsableProfile = usesClaudeDefault || !isProfileAgent || Boolean(
  activeProfileId
    && selectedProvider?.id === activeProfileId
    && effectiveModel
    && providerModels.includes(effectiveModel),
);
```

With:
```typescript
const hasUsableProfile = usesClaudeDefault || !isProfileAgent || Boolean(activeProfileId && effectiveModel);
```

- [ ] **Step 5: Simplify useEffect (lines 130-140)**

Remove `setSelectedProviderId` calls. The provider is always the active one:

```typescript
useEffect(() => {
  if (!isProfileAgent) return;
  const active = availableProfiles.find((profile) => profile.id === activeProfileId);
  if (!active) {
    setSelectedModel(null);
    return;
  }
  setSelectedModel(active.models.find((m) => m.id.trim())?.id.trim() || null);
}, [activeProfileId, availableProfiles, isProfileAgent, selectedAgentKind, setSelectedModel]);
```

- [ ] **Step 6: Replace `<CodeMuxModelSelector>` with `<AgentModelSelector>`**

```tsx
<AgentModelSelector
  agentKind={selectedAgentKind}
  activeProfile={availableProfiles.find((p) => p.id === activeProfileId) ?? null}
  activeProfileId={activeProfileId}
  value={effectiveModel}
  onChange={setSelectedModel}
  reasoningEffort={selectedReasoningEffort}
  onReasoningEffortChange={setSelectedReasoningEffort}
/>
```

- [ ] **Step 7: Remove `selectedProviderId` from newSessionStore usage**

In the destructuring of `useNewSessionStore`, remove `selectedProviderId` and `setSelectedProviderId` since they're no longer used.

- [ ] **Step 8: Verify TypeScript compiles**

```bash
npm run build
```

Expected: No type errors.

- [ ] **Step 9: Commit**

```bash
git add src/components/agent/NewSessionPanel.tsx
git commit -m "feat(agent): replace CodeMuxModelSelector with AgentModelSelector in NewSessionPanel"
```

---

### Task 7: Delete Old CodeMuxModelSelector

**Files:**
- Delete: `src/components/agent/assistant-ui/CodeMuxModelSelector.tsx`
- Delete: `src/components/agent/assistant-ui/CodeMuxModelSelector.test.tsx`

- [ ] **Step 1: Delete the files**

```bash
rm src/components/agent/assistant-ui/CodeMuxModelSelector.tsx
rm src/components/agent/assistant-ui/CodeMuxModelSelector.test.tsx
```

- [ ] **Step 2: Verify no remaining imports**

```bash
grep -r "CodeMuxModelSelector" src/
```

Expected: No results.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npm run build
```

Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add -A src/components/agent/assistant-ui/CodeMuxModelSelector.tsx src/components/agent/assistant-ui/CodeMuxModelSelector.test.tsx
git commit -m "chore: delete old CodeMuxModelSelector component and tests"
```

---

### Task 8: Update Test Mocks

**Files:**
- Modify: `src/components/agent/AgentPanel.ensure.test.tsx`
- Modify: `src/components/agent/NewSessionPanel.test.tsx`

- [ ] **Step 1: Update AgentPanel.ensure.test.tsx mock**

Replace the old mock:
```typescript
vi.mock('./assistant-ui/CodeMuxModelSelector', () => ({
  CodeMuxModelSelector: ({ providers, providerId, onProviderChange }: any) => (
    <button
      type="button"
      data-testid="model-selector"
      data-provider-id={providerId}
      data-provider-count={providers?.length ?? 0}
      onClick={() => onProviderChange?.('profile-2', 'claude-opus-4-1')}
    >
      切换供应商
    </button>
  ),
}));
```

With:
```typescript
vi.mock('./AgentModelSelector', () => ({
  AgentModelSelector: ({ value, onChange }: any) => (
    <button
      type="button"
      data-testid="model-selector"
      onClick={() => onChange?.('claude-opus-4-1')}
    >
      {value ?? '选择模型'}
    </button>
  ),
}));
```

- [ ] **Step 2: Update NewSessionPanel.test.tsx mock**

Replace the old mock:
```typescript
vi.mock('./assistant-ui/CodeMuxModelSelector', () => ({
  CodeMuxModelSelector: ({ models, providers, providerId, onChange, onProviderChange }: any) => (
    <div>
      <select aria-label="Providers" value={providerId ?? ''} onChange={(event) => onProviderChange?.(event.target.value, 'gpt-5')}>
        {providers?.map((provider: any) => (
          <option key={provider.id} value={provider.id}>
            {provider.name}
          </option>
        ))}
      </select>
      <select aria-label="Models" onChange={(event) => onChange(event.target.value)}>
        {models.map((model: string) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
      </select>
    </div>
  ),
}));
```

With:
```typescript
vi.mock('./AgentModelSelector', () => ({
  AgentModelSelector: ({ value, onChange }: any) => (
    <div>
      <select aria-label="Models" value={value ?? ''} onChange={(event) => onChange(event.target.value)}>
        <option value="claude-sonnet-4-20250514">claude-sonnet-4-20250514</option>
        <option value="claude-opus-4-1">claude-opus-4-1</option>
      </select>
    </div>
  ),
}));
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/components/agent/AgentPanel.ensure.test.tsx src/components/agent/NewSessionPanel.test.tsx
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/agent/AgentPanel.ensure.test.tsx src/components/agent/NewSessionPanel.test.tsx
git commit -m "test(agent): update mocks for AgentModelSelector replacement"
```

---

### Task 9: Add `useAgentModels` Unit Tests

**Files:**
- Create: `src/hooks/useAgentModels.test.ts`

- [ ] **Step 1: Create test file**

```typescript
// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { useAgentModels } from './useAgentModels';
import { configApi } from '../lib/tauri';

vi.mock('../lib/tauri', () => ({
  configApi: {
    readHomeFile: vi.fn(),
  },
}));

const mockReadHomeFile = vi.mocked(configApi.readHomeFile);

describe('useAgentModels', () => {
  beforeEach(() => {
    mockReadHomeFile.mockReset();
  });

  it('returns Claude built-in models when no profile', async () => {
    const { result } = renderHook(() =>
      useAgentModels('claude_code', null, null),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.models).toHaveLength(4);
    expect(result.current.models.map((m) => m.id)).toEqual([
      'sonnet', 'opus', 'fable', 'haiku',
    ]);
  });

  it('returns empty array for codex with no profile and no cache file', async () => {
    mockReadHomeFile.mockRejectedValue(new Error('File not found'));

    const { result } = renderHook(() =>
      useAgentModels('codex', null, null),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.models).toHaveLength(0);
  });

  it('loads codex models from cache file', async () => {
    mockReadHomeFile.mockResolvedValue(JSON.stringify([
      { model: 'gpt-5', displayName: 'GPT 5' },
      { model: 'gpt-5-mini', displayName: 'GPT 5 Mini' },
    ]));

    const { result } = renderHook(() =>
      useAgentModels('codex', null, null),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.models).toHaveLength(2);
    expect(result.current.models[0]).toEqual({
      id: 'gpt-5',
      name: 'GPT 5',
      efforts: true,
    });
  });

  it('returns OpenCode free models when no profile', async () => {
    mockReadHomeFile.mockRejectedValue(new Error('File not found'));

    const { result } = renderHook(() =>
      useAgentModels('opencode', null, null),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.models).toHaveLength(5);
    expect(result.current.models[0].id).toBe('opencode/nemotron-3-ultra-free');
  });

  it('deduplicates models by id', async () => {
    mockReadHomeFile.mockResolvedValue(JSON.stringify([
      { model: 'sonnet', displayName: 'Custom Sonnet' },
    ]));

    const { result } = renderHook(() =>
      useAgentModels('claude_code', null, null),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const sonnetModels = result.current.models.filter((m) => m.id === 'sonnet');
    expect(sonnetModels).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run src/hooks/useAgentModels.test.ts
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useAgentModels.test.ts
git commit -m "test(hooks): add useAgentModels unit tests"
```

---

### Task 10: Full Build Verification

**Files:**
- None (verification only)

- [ ] **Step 1: Run full TypeScript build**

```bash
npm run build
```

Expected: No type errors.

- [ ] **Step 2: Run all tests**

```bash
npx vitest run
```

Expected: All tests pass.

- [ ] **Step 3: Run Rust checks**

```bash
cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings
```

Expected: No formatting issues or warnings.

- [ ] **Step 4: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix: address review feedback from full build verification"
```

(Only if fixes were needed. Skip if clean.)

---

## Self-Review Checklist

1. **Spec coverage:** All requirements from the spec are covered by tasks:
   - ✅ Dependencies installed (Task 1)
   - ✅ `read_home_file` Tauri command (Task 2)
   - ✅ `useAgentModels` hook with all agent types (Task 3)
   - ✅ `AgentModelSelector` component (Task 4)
   - ✅ AgentPanel update (Task 5)
   - ✅ NewSessionPanel update (Task 6)
   - ✅ Old component deleted (Task 7)
   - ✅ Test mocks updated (Task 8)
   - ✅ New unit tests (Task 9)
   - ✅ Full build verification (Task 10)

2. **Placeholder scan:** No TBD/TODO/implement-later found. All steps have complete code.

3. **Type consistency:** All types match across tasks:
   - `ModelOption` defined in Task 3, used in Task 4
   - `AgentModelSelectorProps` defined in Task 4, used in Tasks 5-6
   - `readHomeFile` added in Task 2, used in Task 3
