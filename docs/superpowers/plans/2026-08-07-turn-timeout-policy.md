# Turn Timeout & Interactive Request Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hard total-duration / fixed per-message timeouts across the Claude Code, Codex, and OpenCode runtimes with a shared configurable "turn idle timeout" (pure no-progress heartbeat) plus optional per-interactive-request timeouts, while making approval and question waits block indefinitely by default.

**Architecture:** Three config values (`idle_timeout_ms`, `approval_timeout_ms`, `question_timeout_ms`) flow from the agent profile's `native_config.timeouts` (Rust) through the `ensure_session` sidecar command into each runtime, with env fallback (`CODEMUX_*_TIMEOUT_MS`) and defaults in a shared `turnTimeouts.ts` resolver. A shared, I/O-free `turnIdleGuard.ts` state machine (reset / suspend / resume / isExpired / remainingIdleMs / dispose) is driven by each runtime's own event loop — pull-based for Claude, push-based for OpenCode, and in-stream for Codex. Pending approvals/questions suspend the guard so "waiting for the human" is never misjudged as an Engine Stall. An idle expiry aborts only the current turn (recoverable; session retained), never auto-retries. Approval/question timeouts (default `0` = disabled/infinite) auto-reject only that pending request.

**Tech Stack:** TypeScript (sidecar, Vitest), Rust (Tauri commands, `cargo test`), React/Vite frontend types (type-only change).

---

## File Structure

- Create: `src-tauri/sidecar/src/turnTimeouts.ts` — `TurnTimeouts` type + `resolveTurnTimeouts()` (command value > env > defaults).
- Create: `src-tauri/sidecar/src/turnTimeouts.test.ts`
- Create: `src-tauri/sidecar/src/turnIdleGuard.ts` — shared idle-guard state machine.
- Create: `src-tauri/sidecar/src/turnIdleGuard.test.ts`
- Modify: `src-tauri/sidecar/src/claudeQueryTimeout.ts` — `nextWithTimeout` supports `timeoutMs <= 0`/`Infinity` (no timer).
- Modify: `src-tauri/sidecar/src/claudeQueryTimeout.test.ts`
- Modify: `src-tauri/sidecar/src/types.ts` — add `timeouts?: TurnTimeouts` to `SidecarCommand.ensure_session` and `OpenCodeSessionConfig`.
- Modify: `src-tauri/sidecar/src/index.ts` — `SessionBootstrap.timeouts`; `normalizeConfig`; guard creation/disposal; `nextMessage` uses the guard; suspend/resume around interactive waits; configurable approval/question waits; export `waitForClaudeToolResponse` for testing.
- Modify: `src-tauri/sidecar/src/index.test.ts`
- Modify: `src-tauri/sidecar/src/codexRuntime.ts` — `CodexSessionBootstrap.timeouts`; idle guard in `runInput`; `suspendActiveTurnGuard`/`resumeActiveTurnGuard`/`getActiveCodexQuestionTimeoutMs` exports.
- Modify: `src-tauri/sidecar/src/codexRuntime.test.ts`
- Modify: `src-tauri/sidecar/src/codexCompatProxy.ts` — question wait timeout from active runtime; suspend/resume the guard around the wait.
- Modify: `src-tauri/sidecar/src/opencodeRuntime.ts` — remove `DEFAULT_PROMPT_TIMEOUT_MS`/`awaitPromptWithTimeout`; idle guard + `syncGuardWithInteractiveState`; configurable approval/question timeouts.
- Modify: `src-tauri/sidecar/src/opencodeRuntime.test.ts`
- Modify: `src-tauri/sidecar/src/opencodePermissions.ts` — optional timeout (undefined = infinite), `hasPending(sessionId)`, tombstone TTL default fix.
- Modify: `src-tauri/src/provider_profiles/types.rs` — `AgentTimeouts` struct; `timeouts` field on all three `NativeProfileConfig`/`NativeProfileConfigRaw` variants + deserialization + Debug.
- Modify: `src-tauri/src/agent/commands.rs` — `ResolvedRuntimeConfig.timeouts`; `resolve_active_runtime_config`; `build_ensure_session_command` new arg.
- Modify: `src/types/provider.ts` — `AgentTimeouts` interface + `timeouts` on the three `NativeProfileConfig` variants (no UI).

---

## Task 1: Shared `turnTimeouts` config resolver

**Files:**
- Create: `src-tauri/sidecar/src/turnTimeouts.ts`
- Test: `src-tauri/sidecar/src/turnTimeouts.test.ts`

- [ ] **Step 1: Write the failing test**

`src-tauri/sidecar/src/turnTimeouts.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_IDLE_TIMEOUT_MS, resolveTurnTimeouts } from './turnTimeouts.js';

const ENV_VARS = ['CODEMUX_IDLE_TIMEOUT_MS', 'CODEMUX_APPROVAL_TIMEOUT_MS', 'CODEMUX_QUESTION_TIMEOUT_MS'];

describe('resolveTurnTimeouts', () => {
  beforeEach(() => {
    for (const name of ENV_VARS) delete process.env[name];
  });
  afterEach(() => {
    for (const name of ENV_VARS) delete process.env[name];
  });

  it('applies defaults when nothing is configured', () => {
    expect(resolveTurnTimeouts(undefined)).toEqual({
      idle_timeout_ms: DEFAULT_IDLE_TIMEOUT_MS,
      approval_timeout_ms: 0,
      question_timeout_ms: 0,
    });
  });

  it('prefers the configured value over env and defaults', () => {
    process.env.CODEMUX_IDLE_TIMEOUT_MS = '60000';
    expect(resolveTurnTimeouts({ idle_timeout_ms: 120_000 })).toMatchObject({
      idle_timeout_ms: 120_000,
    });
  });

  it('falls back to env when not configured on the command', () => {
    process.env.CODEMUX_IDLE_TIMEOUT_MS = '60000';
    process.env.CODEMUX_APPROVAL_TIMEOUT_MS = '15000';
    expect(resolveTurnTimeouts(undefined)).toEqual({
      idle_timeout_ms: 60_000,
      approval_timeout_ms: 15_000,
      question_timeout_ms: 0,
    });
  });

  it('keeps 0 (disabled / infinite wait) as an explicit value', () => {
    expect(resolveTurnTimeouts({ idle_timeout_ms: 0, approval_timeout_ms: 0, question_timeout_ms: 0 })).toEqual({
      idle_timeout_ms: 0,
      approval_timeout_ms: 0,
      question_timeout_ms: 0,
    });
  });

  it('ignores invalid env values', () => {
    process.env.CODEMUX_IDLE_TIMEOUT_MS = 'not-a-number';
    process.env.CODEMUX_APPROVAL_TIMEOUT_MS = '-5';
    process.env.CODEMUX_QUESTION_TIMEOUT_MS = '1.5';
    expect(resolveTurnTimeouts(undefined)).toEqual({
      idle_timeout_ms: DEFAULT_IDLE_TIMEOUT_MS,
      approval_timeout_ms: 0,
      question_timeout_ms: 0,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri/sidecar && npx vitest run src/turnTimeouts.test.ts`
Expected: FAIL with `Failed to resolve module "./turnTimeouts.js"`.

- [ ] **Step 3: Write the implementation**

`src-tauri/sidecar/src/turnTimeouts.ts`:

```ts
export interface TurnTimeouts {
  idle_timeout_ms?: number;
  approval_timeout_ms?: number;
  question_timeout_ms?: number;
}

export interface ResolvedTurnTimeouts {
  idle_timeout_ms: number;
  approval_timeout_ms: number;
  question_timeout_ms: number;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

/** 0 disables the timeout (infinite wait / no idle kill). */
export function resolveTurnTimeouts(configured?: TurnTimeouts): ResolvedTurnTimeouts {
  return {
    idle_timeout_ms:
      configured?.idle_timeout_ms
      ?? readEnvTimeoutMs('CODEMUX_IDLE_TIMEOUT_MS')
      ?? DEFAULT_IDLE_TIMEOUT_MS,
    approval_timeout_ms:
      configured?.approval_timeout_ms
      ?? readEnvTimeoutMs('CODEMUX_APPROVAL_TIMEOUT_MS')
      ?? 0,
    question_timeout_ms:
      configured?.question_timeout_ms
      ?? readEnvTimeoutMs('CODEMUX_QUESTION_TIMEOUT_MS')
      ?? 0,
  };
}

function readEnvTimeoutMs(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    process.stderr.write(`[sidecar] Ignoring invalid ${name}=${raw}; expected a non-negative integer of milliseconds\n`);
    return undefined;
  }
  return parsed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri/sidecar && npx vitest run src/turnTimeouts.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/sidecar/src/turnTimeouts.ts src-tauri/sidecar/src/turnTimeouts.test.ts
git commit -m "feat(sidecar): add turn timeouts config resolver"
```

---

## Task 2: Shared `turnIdleGuard` state machine

**Files:**
- Create: `src-tauri/sidecar/src/turnIdleGuard.ts`
- Test: `src-tauri/sidecar/src/turnIdleGuard.test.ts`

- [ ] **Step 1: Write the failing test**

`src-tauri/sidecar/src/turnIdleGuard.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTurnIdleGuard } from './turnIdleGuard.js';

describe('createTurnIdleGuard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onExpired after the idle window without progress', async () => {
    vi.useFakeTimers();
    const onExpired = vi.fn();
    const guard = createTurnIdleGuard({ idleTimeoutMs: 25, onExpired });
    guard.reset();
    await vi.advanceTimersByTimeAsync(24);
    expect(onExpired).not.toHaveBeenCalled();
    expect(guard.isExpired()).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(guard.isExpired()).toBe(true);
    expect(guard.remainingIdleMs()).toBe(0);
  });

  it('reset() renews the idle window', async () => {
    vi.useFakeTimers();
    const onExpired = vi.fn();
    const guard = createTurnIdleGuard({ idleTimeoutMs: 25, onExpired });
    guard.reset();
    await vi.advanceTimersByTimeAsync(20);
    guard.reset();
    await vi.advanceTimersByTimeAsync(20);
    expect(onExpired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('suspend() stops the timer and resume() restarts it from now', async () => {
    vi.useFakeTimers();
    const onExpired = vi.fn();
    const guard = createTurnIdleGuard({ idleTimeoutMs: 25, onExpired });
    guard.reset();
    await vi.advanceTimersByTimeAsync(20);
    guard.suspend();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onExpired).not.toHaveBeenCalled();
    expect(guard.remainingIdleMs()).toBe(Infinity);
    guard.resume();
    await vi.advanceTimersByTimeAsync(20);
    expect(onExpired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('never expires when idleTimeoutMs is 0 (disabled)', async () => {
    vi.useFakeTimers();
    const onExpired = vi.fn();
    const guard = createTurnIdleGuard({ idleTimeoutMs: 0, onExpired });
    guard.reset();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onExpired).not.toHaveBeenCalled();
    expect(guard.remainingIdleMs()).toBe(0);
  });

  it('dispose() prevents any later expiration', async () => {
    vi.useFakeTimers();
    const onExpired = vi.fn();
    const guard = createTurnIdleGuard({ idleTimeoutMs: 25, onExpired });
    guard.reset();
    guard.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onExpired).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri/sidecar && npx vitest run src/turnIdleGuard.test.ts`
Expected: FAIL with `Failed to resolve module "./turnIdleGuard.js"`.

- [ ] **Step 3: Write the implementation**

`src-tauri/sidecar/src/turnIdleGuard.ts`:

```ts
export interface TurnIdleGuardOptions {
  /** 0 disables the guard entirely. */
  idleTimeoutMs: number;
  onExpired?: () => void;
}

export interface TurnIdleGuard {
  /** Called on any progress event. Renews the idle window. */
  reset(): void;
  /** Called while an interactive request is pending. Stops the timer. */
  suspend(): void;
  /** Called when the interactive request resolves. Restarts the timer. */
  resume(): void;
  isExpired(): boolean;
  /** Idle window remaining; Infinity while suspended; 0 when disabled/expired. */
  remainingIdleMs(): number;
  dispose(): void;
}

export function createTurnIdleGuard(options: TurnIdleGuardOptions): TurnIdleGuard {
  const { idleTimeoutMs, onExpired } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let suspended = false;
  let expired = false;
  let disposed = false;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const arm = (): void => {
    clearTimer();
    if (disposed || expired || suspended || idleTimeoutMs <= 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || suspended) return;
      expired = true;
      onExpired?.();
    }, idleTimeoutMs);
    timer.unref?.();
  };

  return {
    reset() {
      arm();
    },
    suspend() {
      suspended = true;
      clearTimer();
    },
    resume() {
      suspended = false;
      arm();
    },
    isExpired() {
      return expired;
    },
    remainingIdleMs() {
      if (disposed || expired || idleTimeoutMs <= 0) return 0;
      if (suspended) return Infinity;
      return idleTimeoutMs;
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri/sidecar && npx vitest run src/turnIdleGuard.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/sidecar/src/turnIdleGuard.ts src-tauri/sidecar/src/turnIdleGuard.test.ts
git commit -m "feat(sidecar): add shared turn idle guard"
```

---

## Task 3: `nextWithTimeout` no-timeout branch

**Files:**
- Modify: `src-tauri/sidecar/src/claudeQueryTimeout.ts`
- Test: `src-tauri/sidecar/src/claudeQueryTimeout.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src-tauri/sidecar/src/claudeQueryTimeout.test.ts`:

```ts
it('waits indefinitely when timeoutMs is 0 (disabled idle timeout)', async () => {
  const next = vi.fn().mockResolvedValueOnce('later');
  const promise = nextWithTimeout(next, 0, () => 'timeout');
  expect(next).toHaveBeenCalledTimes(1);
  await expect(promise).resolves.toBe('later');
});

it('waits indefinitely when timeoutMs is Infinity (suspended idle guard)', async () => {
  const next = vi.fn().mockResolvedValueOnce('later');
  await expect(nextWithTimeout(next, Infinity, () => 'timeout')).resolves.toBe('later');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri/sidecar && npx vitest run src/claudeQueryTimeout.test.ts`
Expected: FAIL — `timeoutMs 0` arms `setTimeout(fn, 0)` and resolves `'timeout'` immediately, so the `toBe('later')` assertion fails.

- [ ] **Step 3: Write the implementation**

Modify `src-tauri/sidecar/src/claudeQueryTimeout.ts` to the full file:

```ts
export async function nextWithTimeout<T>(
  next: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => T | never,
  additionalPromises: Promise<T>[] = [],
): Promise<T> {
  if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    return await next();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        try {
          resolve(onTimeout());
        } catch (error) {
          reject(error);
        }
      }, timeoutMs);
      timer.unref?.();
    });

    return await Promise.race([next(), timeout, ...additionalPromises]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri/sidecar && npx vitest run src/claudeQueryTimeout.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/sidecar/src/claudeQueryTimeout.ts src-tauri/sidecar/src/claudeQueryTimeout.test.ts
git commit -m "feat(sidecar): support disabled/suspended idle timeouts in nextWithTimeout"
```

---

## Task 4: Sidecar `ensure_session` plumbing

**Files:**
- Modify: `src-tauri/sidecar/src/types.ts`
- Modify: `src-tauri/sidecar/src/index.ts`
- Modify: `src-tauri/sidecar/src/codexRuntime.ts`
- Test: `src-tauri/sidecar/src/index.test.ts`
- Test: `src-tauri/sidecar/src/opencodeRuntime.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src-tauri/sidecar/src/index.test.ts`:

```ts
it('forwards timeouts to the OpenCode runtime factory on ensure_session', async () => {
  const opencode = createRuntime();
  const createOpenCodeRuntime = vi.fn(() => opencode);
  const dispatcher = createSidecarCommandDispatcher({
    claudeRuntime: createRuntime(),
    codexRuntime: createRuntime(),
    createOpenCodeRuntime,
    emit: vi.fn(),
    stopProxy: vi.fn().mockResolvedValue(undefined),
    exit: vi.fn(),
  });

  await dispatcher.dispatch({
    type: 'ensure_session',
    agentKind: 'opencode',
    cwd: 'D:\\workspace',
    sessionId: 'session-timeouts',
    provider: 'codemux-openai',
    model: 'gpt-5',
    timeouts: { idle_timeout_ms: 60_000, approval_timeout_ms: 0, question_timeout_ms: 15_000 },
  });

  expect(createOpenCodeRuntime).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: 'session-timeouts',
    timeouts: { idle_timeout_ms: 60_000, approval_timeout_ms: 0, question_timeout_ms: 15_000 },
  }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri/sidecar && npx vitest run src/index.test.ts -t "forwards timeouts"`
Expected: FAIL — TypeScript error: `timeouts` does not exist on the `ensure_session` command type.

- [ ] **Step 3: Write the implementation**

**`src-tauri/sidecar/src/types.ts`:** add the import and the two fields.

Add near the top imports:

```ts
import type { TurnTimeouts } from './turnTimeouts.js';
```

In the `ensure_session` variant of `SidecarCommand` add `timeouts?: TurnTimeouts;` (after `permissionConfig?: SidecarPermissionConfig;`):

```ts
export type SidecarCommand =
  | { type: 'ensure_session'; agentKind?: string; cwd: string; sessionId?: string; agentSessionId?: string; resumeOnly?: boolean; runtimeGeneration?: number; apiKey?: string; baseUrl?: string; provider?: string; credentialSource?: OpenCodeCredentialSource; model?: string; reasoningEffort?: string; codexNeedsProxy?: boolean; skills?: string[]; permissionConfig?: SidecarPermissionConfig; planMode?: AgentPlanMode; runtimeRef?: ProviderRuntimeRef; timeouts?: TurnTimeouts }
```

In `OpenCodeSessionConfig` add the field after `runtimeRef`:

```ts
export interface OpenCodeSessionConfig {
  cwd: string;
  sessionId: string;
  agentSessionId?: string;
  runtimeGeneration: number;
  provider: string;
  model: string;
  credentialSource: OpenCodeCredentialSource;
  apiKey?: string;
  baseUrl?: string;
  /** 外部托管 Runtime 引用。 */
  runtimeRef?: ProviderRuntimeRef;
  timeouts?: TurnTimeouts;
}
```

**`src-tauri/sidecar/src/index.ts`:** add imports, the `SessionBootstrap.timeouts` field, thread it through `normalizeConfig`, and the OpenCode config builder.

Add to the import block near the top (after the existing `./claudeQueryTimeout.js` import):

```ts
import { resolveTurnTimeouts, type ResolvedTurnTimeouts, type TurnTimeouts } from './turnTimeouts.js';
import { createTurnIdleGuard, type TurnIdleGuard } from './turnIdleGuard.js';
```

Add to `SessionBootstrap`:

```ts
type SessionBootstrap = {
  sessionId?: string;
  agentSessionId?: string;
  resumeOnly?: boolean;
  runtimeGeneration: number;
  cwd: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  reasoningEffort?: string;
  skills?: string[];
  permissionConfig?: SidecarPermissionConfig;
  planMode?: AgentPlanMode;
  runtimeRef?: import('./runtimeContract.js').ProviderRuntimeRef;
  timeouts?: TurnTimeouts;
};
```

Add to `normalizeConfig` (after `runtimeRef: cmd.runtimeRef,`):

```ts
      timeouts: cmd.timeouts,
```

Add fields to the `ClaudeSessionRuntime` class (near the existing `private config: SessionBootstrap | null = null;`):

```ts
  private timeouts: ResolvedTurnTimeouts = resolveTurnTimeouts();
  private turnIdleGuard: TurnIdleGuard | undefined;
```

In the `ensure` method, immediately after `const nextConfig = this.normalizeConfig(cmd);`:

```ts
    this.timeouts = resolveTurnTimeouts(nextConfig.timeouts);
```

In the OpenCode config builder (inside `createOpenCodeSidecarRuntime`, after `...(cmd.runtimeRef ? { runtimeRef: cmd.runtimeRef } : {}),`):

```ts
    ...(cmd.timeouts ? { timeouts: cmd.timeouts } : {}),
```

**`src-tauri/sidecar/src/codexRuntime.ts`:** add the imports, the bootstrap field, and resolution.

Add imports (with the other `./...` imports):

```ts
import { resolveTurnTimeouts, type ResolvedTurnTimeouts, type TurnTimeouts } from './turnTimeouts.js';
import { createTurnIdleGuard, type TurnIdleGuard } from './turnIdleGuard.js';
```

Add to `CodexSessionBootstrap` (after `runtimeRef?: ProviderRuntimeRef;`):

```ts
  timeouts?: TurnTimeouts;
```

Add fields to `CodexSessionRuntime` (near `private configFingerprint: string | null = null;`):

```ts
  private timeouts: ResolvedTurnTimeouts = resolveTurnTimeouts();
  private turnIdleGuard: TurnIdleGuard | undefined;
  private idleTimedOut = false;
```

In `ensure`, add `timeouts: cmd.timeouts,` to the `requestedConfig` object (after `planMode: normalizeCodexPlanMode(cmd.planMode),`), then immediately after the `const requestedConfig = { ... };` block:

```ts
    this.timeouts = resolveTurnTimeouts(requestedConfig.timeouts);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri/sidecar && npx vitest run src/index.test.ts src/codexRuntime.test.ts`
Expected: PASS — new test passes; existing dispatcher/Codex tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/sidecar/src/types.ts src-tauri/sidecar/src/index.ts src-tauri/sidecar/src/codexRuntime.ts src-tauri/sidecar/src/index.test.ts
git commit -m "feat(sidecar): plumb turn timeouts through ensure_session"
```

---

## Task 5: Rust profile + command plumbing

**Files:**
- Modify: `src-tauri/src/provider_profiles/types.rs`
- Modify: `src-tauri/src/agent/commands.rs`
- Test: `src-tauri/src/agent/commands.rs` (in-module `#[cfg(test)]`)

- [ ] **Step 1: Write the failing test**

Add to the tests module in `src-tauri/src/agent/commands.rs`:

```rust
#[test]
fn builds_ensure_command_with_timeouts() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    let runtime_root = tempfile::tempdir().unwrap();
    for (provider, version) in [("opencode", "1.18.3"), ("claude_code", "0.3.170")] {
        let version_dir = runtime_root.path().join(provider).join(version);
        std::fs::create_dir_all(&version_dir).unwrap();
        std::fs::write(version_dir.join("package.json"), b"{}").unwrap();
        std::fs::write(runtime_root.path().join(provider).join("current"), version).unwrap();
    }
    crate::db::schema::initialize_database(&conn).unwrap();
    conn.execute(
        "INSERT INTO sessions (id, title, agent_kind, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params!["session-timeouts", "Claude", "claude_code", "chat", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
    )
    .unwrap();
    let app_state = crate::AppState {
        db: std::sync::Mutex::new(conn),
        config: std::sync::Mutex::new(crate::config::types::AppConfig::default()),
        provider_profile_operation_lock: std::sync::Mutex::new(()),
        app_data_dir: std::path::PathBuf::new(),
        runtime_resolver: crate::runtime::RuntimeResolver::new(
            runtime_root.path().to_path_buf(),
        ),
    };

    let timeouts = crate::provider_profiles::types::AgentTimeouts {
        idle_timeout_ms: Some(300_000),
        approval_timeout_ms: Some(0),
        question_timeout_ms: Some(120_000),
    };
    let command = build_ensure_session_command(
        &app_state,
        "session-timeouts",
        "claude_code",
        "D:/workspace/demo".to_string(),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        Some(timeouts),
    )
    .unwrap();

    assert_eq!(command["timeouts"]["idle_timeout_ms"], 300_000);
    assert_eq!(command["timeouts"]["approval_timeout_ms"], 0);
    assert_eq!(command["timeouts"]["question_timeout_ms"], 120_000);

    let without = build_ensure_session_command(
        &app_state,
        "session-timeouts",
        "claude_code",
        "D:/workspace/demo".to_string(),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .unwrap();
    assert!(without.get("timeouts").is_none());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib agent::commands::tests::builds_ensure_command_with_timeouts`
Expected: FAIL — `AgentTimeouts` does not exist and `build_ensure_session_command` does not accept the 13th argument.

- [ ] **Step 3: Write the implementation**

**`src-tauri/src/provider_profiles/types.rs`:**

Add the `AgentTimeouts` struct near the top (after the `const MIGRATION_REVIEW_NOTE` line):

```rust
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AgentTimeouts {
    #[serde(default)]
    pub idle_timeout_ms: Option<u64>,
    #[serde(default)]
    pub approval_timeout_ms: Option<u64>,
    #[serde(default)]
    pub question_timeout_ms: Option<u64>,
}
```

Add `#[serde(default)] timeouts: Option<AgentTimeouts>,` to each of the three variants of `NativeProfileConfig` (after `requires_review: bool,` in `ClaudeCode`, after `requires_review: bool,` in `Codex`, after `requires_review: bool,` in `OpenCode`).

Add `#[serde(default)] timeouts: Option<AgentTimeouts>,` to each of the three variants of `NativeProfileConfigRaw` (same positions).

Update the `Debug` impl for the `ClaudeCode` arm (it destructures explicitly and must not miss the new field):

```rust
            Self::ClaudeCode {
                settings: _,
                requires_review,
                timeouts,
            } => formatter
                .debug_struct("ClaudeCode")
                .field("settings", &"[已脱敏]")
                .field("requires_review", requires_review)
                .field("timeouts", timeouts)
                .finish(),
```

Update `deserialize_native_profile_config` to thread `timeouts` through each arm:

```rust
        NativeProfileConfigRaw::ClaudeCode {
            settings: Some(settings),
            requires_review,
            timeouts,
            ..
        } => NativeProfileConfig::ClaudeCode {
            settings,
            requires_review,
            timeouts,
        },
        NativeProfileConfigRaw::ClaudeCode {
            api_key,
            anthropic_base_url,
            context_1m,
            advanced_config,
            requires_review,
            ..
        } => NativeProfileConfig::ClaudeCode {
            settings: legacy_claude_settings(
                &api_key,
                &anthropic_base_url,
                context_1m.unwrap_or(false),
                advanced_config.as_ref(),
                default_model,
            ),
            requires_review,
            timeouts: None,
        },
        NativeProfileConfigRaw::Codex {
            api_key,
            openai_base_url,
            codex_needs_proxy,
            advanced_config,
            auth_json,
            config_toml,
            model_catalog,
            requires_review,
            timeouts,
        } => NativeProfileConfig::Codex {
            api_key,
            openai_base_url,
            codex_needs_proxy,
            advanced_config,
            auth_json,
            config_toml,
            model_catalog,
            requires_review,
            timeouts,
        },
        NativeProfileConfigRaw::OpenCode {
            api_key,
            openai_base_url,
            provider_key,
            npm,
            models_config,
            extra_options,
            advanced_config,
            requires_review,
            timeouts,
        } => NativeProfileConfig::OpenCode {
            api_key,
            openai_base_url,
            provider_key,
            npm,
            models_config,
            extra_options,
            advanced_config,
            requires_review,
            timeouts,
        },
```

**`src-tauri/src/agent/commands.rs`:**

Update the import (line 9):

```rust
use crate::provider_profiles::types::{AgentTimeouts, NativeProfileConfig};
```

Add the field to `ResolvedRuntimeConfig`:

```rust
struct ResolvedRuntimeConfig {
    profile_id: String,
    api_key: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    codex_needs_proxy: Option<bool>,
    provider: Option<String>,
    credential_source: Option<String>,
    timeouts: Option<AgentTimeouts>,
}
```

Add a helper (place it just above `resolve_active_runtime_config`):

```rust
fn profile_timeouts(profile: &NativeProfileConfig) -> Option<AgentTimeouts> {
    match profile {
        NativeProfileConfig::ClaudeCode { timeouts, .. } => timeouts.clone(),
        NativeProfileConfig::Codex { timeouts, .. } => timeouts.clone(),
        NativeProfileConfig::OpenCode { timeouts, .. } => timeouts.clone(),
    }
}
```

In `resolve_active_runtime_config`, add `timeouts: None,` to each of the four early-return `Ok(ResolvedRuntimeConfig { ... })` literals (the OpenCode/Codex default at ~line 131/143, the Claude default supplier at ~line 157, and `resolve_default_claude_runtime_config` at ~line 263).

Set the field in the final literal (after `credential_source,`):

```rust
        timeouts: profile_timeouts(&profile.native_config),
```

Extend `build_ensure_session_command` signature with a trailing 13th argument and set the JSON:

```rust
    runtime_generation: Option<u64>,
    timeouts: Option<AgentTimeouts>,
) -> Result<serde_json::Value, String> {
```

Add before the `permission_snapshot` block (after the `codex_needs_proxy` block):

```rust
    if let Some(timeouts) = timeouts {
        cmd["timeouts"] = serde_json::to_value(timeouts)
            .map_err(|error| format!("无法序列化 Agent 超时配置: {}", error))?;
    }
```

Update the production call sites to pass `runtime_config.timeouts`:
- `ensure_agent_session` (line ~2609): append `runtime_config.timeouts,` as the last argument.
- `start_agent_session` (line ~2697): append `runtime_config.timeouts,` as the last argument.

Update the three existing test call sites (`builds_opencode_command_with_provider_credentials` at ~4229, the `claude_command` at ~4251, and `refuses_to_build_ensure_command_when_managed_runtime_is_missing` at ~4287) to pass a trailing `None`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib agent::commands`
Expected: PASS — new test passes; existing command tests still pass.

Run: `cd src-tauri && cargo test --lib provider_profiles`
Expected: PASS — existing profile serialization/deserialization tests pass with the new defaulted field.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/provider_profiles/types.rs src-tauri/src/agent/commands.rs
git commit -m "feat(config): carry agent timeouts through ensure_session"
```

---

## Task 6: Frontend types (no UI)

**Files:**
- Modify: `src/types/provider.ts`

- [ ] **Step 1: Write the type additions**

Add the `AgentTimeouts` interface after the `OpenCodeModel` interface:

```ts
export interface AgentTimeouts {
  idle_timeout_ms?: number;
  approval_timeout_ms?: number;
  question_timeout_ms?: number;
}
```

Add `timeouts?: AgentTimeouts | null;` to each of the three `NativeProfileConfig` variants (`claude_code`, `codex`, `opencode`) in the `NativeProfileConfig` union type.

Add `timeouts?: AgentTimeouts | null;` to each of the three variants of `AgentProviderProfileUpsert['native_config']`.

- [ ] **Step 2: Verify type-check**

Run: `npm run build`
Expected: PASS (type-check + Vite build). No behavior change; no UI is added per decision F.

- [ ] **Step 3: Commit**

```bash
git add src/types/provider.ts
git commit -m "feat(config): add agent timeouts to profile types"
```

---

## Task 7: Claude runtime — idle guard + interactive request policy

**Files:**
- Modify: `src-tauri/sidecar/src/index.ts`
- Modify: `src-tauri/sidecar/src/index.test.ts`
- Test: `src-tauri/sidecar/src/index-interactive.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `src-tauri/sidecar/src/index-interactive.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  expireClaudeToolResponses,
  resolveClaudeToolResponse,
  waitForClaudeToolResponse,
} from './index.js';

describe('Claude interactive response waits', () => {
  it('waits indefinitely when timeoutMs is 0 (default approval/question)', async () => {
    const pending = waitForClaudeToolResponse('tool-1', 'session-1', 0);
    const outcome = pending.then((result) => result);
    expect(resolveClaudeToolResponse('tool-1', 'once')).toBe(true);
    await expect(outcome).resolves.toEqual({ kind: 'answered', value: 'once' });
  });

  it('expires after a configured timeoutMs', async () => {
    vi.useFakeTimers();
    try {
      const pending = waitForClaudeToolResponse('tool-2', 'session-1', 25);
      const outcome = pending.then((result) => result);
      await vi.advanceTimersByTimeAsync(26);
      await expect(outcome).resolves.toEqual({ kind: 'expired' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires all pending responses for a session on reset', async () => {
    const pending = waitForClaudeToolResponse('tool-3', 'session-1', 0);
    const outcome = pending.then((result) => result);
    expect(expireClaudeToolResponses('session-1')).toBe(1);
    await expect(outcome).resolves.toEqual({ kind: 'expired' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri/sidecar && npx vitest run src/index-interactive.test.ts`
Expected: FAIL — `waitForClaudeToolResponse` is not exported, and with `timeoutMs: 0` it currently arms `setTimeout(fn, 0)` so the first test resolves `{ kind: 'expired' }` instead of `answered`.

- [ ] **Step 3: Write the implementation**

**`src-tauri/sidecar/src/index.ts`:**

Export the three module-level functions by adding the `export` keyword (they already exist at lines 145/165/194):

```ts
export function waitForClaudeToolResponse(...) { ... }
export function resolveClaudeToolResponse(...) { ... }
export function expireClaudeToolResponses(...) { ... }
```

Make `waitForClaudeToolResponse` skip the timer for `timeoutMs <= 0`:

```ts
export function waitForClaudeToolResponse(
  toolUseId: string,
  sessionId?: string,
  timeoutMs = MESSAGE_TIMEOUT_MS,
  onExpired?: () => void,
): Promise<PendingToolResponseResult> {
  return new Promise((resolve) => {
    const pending: PendingToolResponseResultEntry = {
      sessionId,
      onExpired,
      resolve,
    };
    if (timeoutMs > 0) {
      pending.timeoutTimer = setTimeout(() => {
        expireClaudeToolResponse(toolUseId);
      }, timeoutMs);
      if (pending.timeoutTimer.unref) pending.timeoutTimer.unref();
    }
    pendingToolResponses.set(toolUseId, pending);
  });
}
```

Update the `pendingToolResponses` map entry type (lines 120-125) so `timeoutTimer`/`onExpired` stay optional (already are) and add a named type alias above the map:

```ts
type PendingClaudeToolResponse = {
  sessionId?: string;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  onExpired?: () => void;
  resolve: (value: PendingToolResponseResult) => void;
};
```

Change the `pendingToolResponses` declaration from the inline object type to `Map<string, PendingClaudeToolResponse>`.

**Guard wiring in `ClaudeSessionRuntime`:**

In `startPersistentQuery`, immediately before `void this.consumeQuery(this.queryHandle, this.config.sessionId, prompt, inputPayload, includeImages);`:

```ts
    this.turnIdleGuard = createTurnIdleGuard({
      idleTimeoutMs: this.timeouts.idle_timeout_ms,
    });
```

In `consumeQuery`, replace the `nextMessage` body so it uses the guard:

```ts
    const nextMessage = async () => {
      if (!this.turnActive) {
        return iterator.next();
      }
      if (this.turnIdleGuard?.isExpired()) {
        throw new Error(`Query timed out: no message received for ${this.timeouts.idle_timeout_ms / 1000}s (after msg #${msgCount})`);
      }
      return await nextWithTimeout(
        () => iterator.next(),
        this.turnIdleGuard?.remainingIdleMs() ?? MESSAGE_TIMEOUT_MS,
        () => {
          if (this.abortController?.signal.aborted) {
            return { done: true, value: undefined };
          }
          throw new Error(`Query timed out: no message received for ${this.timeouts.idle_timeout_ms / 1000}s (after msg #${msgCount})`);
        },
        compacting ? [new Promise<IteratorResult<unknown>>((resolve) => {
          compactTimer = setTimeout(() => {
            process.stderr.write(`[sidecar] Compact timeout: no message after ${COMPACT_TIMEOUT_MS}ms, treating turn as complete\n`);
            emit({
              type: 'system_event',
              subtype: 'compact_boundary',
              compact_metadata: { trigger: 'manual', pre_tokens: 0 },
              session_id: appSessionId || '',
              uuid: `compact-timeout-${Date.now()}`,
            });
            resolve({ done: true, value: undefined });
          }, COMPACT_TIMEOUT_MS);
          if (compactTimer.unref) compactTimer.unref();
        })] : [],
      );
    };
```

In the loop body, right after the `if (result.done) { break; }` guard, add:

```ts
        this.turnIdleGuard?.reset();
```

In `finishTurn()`, dispose the guard:

```ts
  private finishTurn(): void {
    if (!this.turnActive) {
      return;
    }
    this.turnActive = false;
    this.turnIdleGuard?.dispose();
    this.turnIdleGuard = undefined;
    emit({ type: 'sidecar_query_done' });
    this.turnEventNormalizer = null;
  }
```

Add the suspend/resume wrapper method next to `emitClaudeInteractionTimeout`:

```ts
  private async waitForInteractiveResponse(
    toolUseId: string,
    timeoutMs: number,
    onExpired?: () => void,
  ): Promise<PendingToolResponseResult> {
    this.turnIdleGuard?.suspend();
    try {
      return await waitForClaudeToolResponse(toolUseId, this.config?.sessionId, timeoutMs, onExpired);
    } finally {
      this.turnIdleGuard?.resume();
    }
  }
```

At the very top of `canUseTool` (inside `buildOptions`, before the `EnterPlanMode` check), add the progress renewal:

```ts
      canUseTool: async (toolName: string, input: Record<string, unknown>, opts: { toolUseID: string }) => {
        this.turnIdleGuard?.reset();
        if (toolName === 'EnterPlanMode') {
```

Replace the three `waitForClaudeToolResponse(...)` call sites with the wrapper using the configured timeouts:

- `AskUserQuestion` (was line ~784):

```ts
          const response = await this.waitForInteractiveResponse(
            toolUseId,
            this.timeouts.question_timeout_ms,
            () => this.emitClaudeInteractionTimeout(toolUseId),
          );
```

- `ExitPlanMode` (was line ~825):

```ts
          const response = await this.waitForInteractiveResponse(
            toolUseId,
            this.timeouts.approval_timeout_ms,
            () => this.emitClaudeInteractionTimeout(toolUseId),
          );
```

- The remaining permission wait (was line ~903):

```ts
          const response = await this.waitForInteractiveResponse(
            toolUseId,
            this.timeouts.approval_timeout_ms,
            () => this.emitClaudeInteractionTimeout(toolUseId),
          );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri/sidecar && npx vitest run src/index-interactive.test.ts`
Expected: PASS (3 tests).

Run: `cd src-tauri/sidecar && npx vitest run src/index.test.ts src/claudeQueryTimeout.test.ts`
Expected: PASS — no regressions (the idle-timeout integration is exercised through the guard unit tests; the existing query-timeout text/format is preserved).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/sidecar/src/index.ts src-tauri/sidecar/src/index.test.ts src-tauri/sidecar/src/index-interactive.test.ts
git commit -m "feat(sidecar): drive Claude turn idle timeout and interactive waits from config"
```

---

## Task 8: Codex runtime — idle guard + proxy question timeout

**Files:**
- Modify: `src-tauri/sidecar/src/codexRuntime.ts`
- Modify: `src-tauri/sidecar/src/codexCompatProxy.ts`
- Modify: `src-tauri/sidecar/src/codexRuntime.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the tests module in `src-tauri/sidecar/src/codexRuntime.test.ts`:

```ts
it('aborts an idle Codex turn after the configured idle timeout', async () => {
  vi.useFakeTimers();
  const writes: string[] = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

  try {
    const runtime = new CodexSessionRuntime();
    const internal = runtime as unknown as {
      config: { sessionId: string; cwd: string; model: string; usesCompatProxy?: boolean };
      thread: {
        id: string;
        runStreamed: () => Promise<{ events: AsyncGenerator<ThreadEvent> }>;
      };
      timeouts: { idle_timeout_ms: number };
      abortController: AbortController | null;
    };
    internal.config = { sessionId: 'session-1', cwd: 'D:/repo', model: 'gpt-5' };
    internal.timeouts = { idle_timeout_ms: 25 };

    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    let yields = 0;
    const events = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        if (yields === 0) {
          yields += 1;
          return { done: false, value: { type: 'turn.started' } as ThreadEvent };
        }
        await gate;
        return { done: true, value: undefined };
      },
      async return() {
        return { done: true, value: undefined };
      },
      async throw(error?: unknown) {
        throw error;
      },
    } as AsyncGenerator<ThreadEvent>;
    internal.thread = {
      id: 'codex-thread-1',
      runStreamed: async () => ({ events }),
    };

    const runPromise = (runtime as unknown as {
      runInput: (prompt: string, inputPayload: undefined, includeImages: boolean) => Promise<void>;
    }).runInput('hello', undefined, false);

    await vi.advanceTimersByTimeAsync(40);
    expect(internal.abortController?.signal.aborted).toBe(true);
    released();
    await runPromise;
    expect(writes.some((line) => line.includes('Turn idle timeout'))).toBe(true);
  } finally {
    stdoutSpy.mockRestore();
    vi.useRealTimers();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri/sidecar && npx vitest run src/codexRuntime.test.ts -t "idle Codex turn"`
Expected: FAIL — no guard exists; after 40ms the stream is not aborted (`abortController.signal.aborted` is `false`).

- [ ] **Step 3: Write the implementation**

**`src-tauri/sidecar/src/codexRuntime.ts`:**

Add the module-level guard bridge + question-timeout getter (near `export let activeSessionId = '';`):

```ts
let activeTurnGuard: TurnIdleGuard | null = null;

/** Suspends the active turn idle guard while an interactive wait is pending. */
export function suspendActiveTurnGuard(): void {
  activeTurnGuard?.suspend();
}

/** Resumes the active turn idle guard after an interactive wait resolves. */
export function resumeActiveTurnGuard(): void {
  activeTurnGuard?.resume();
}

/** Question timeout for the compat-proxy interactive path (0 = infinite). */
export function getActiveCodexQuestionTimeoutMs(): number {
  return activeCodexRuntime?.timeouts.question_timeout_ms ?? 0;
}
```

Add a module constant (near `DEFAULT_SHELL_COMMAND_TIMEOUT_MS`):

```ts
const TURN_IDLE_TIMEOUT_MESSAGE = 'Turn idle timeout: no progress events received';
```

In `runInput`, right after `this.abortController = new AbortController();`:

```ts
    this.idleTimedOut = false;
    this.turnIdleGuard = createTurnIdleGuard({
      idleTimeoutMs: this.timeouts.idle_timeout_ms,
      onExpired: () => {
        this.idleTimedOut = true;
        process.stderr.write('[codex] Turn idle timeout fired; aborting stream\n');
        this.abortController?.abort();
      },
    });
    activeTurnGuard = this.turnIdleGuard;
```

In the `for await` loop, right after the abort/forceBreak check that guards the top of each iteration (the one just before `if (event.type === 'turn.completed')`):

```ts
          this.turnIdleGuard?.reset();
```

In the `finally` block, at the very start (before the usage/outcome logic), dispose the guard; then add the idle-timeout outcome branch before the existing `else if (!retryingWithoutImages && !this.abortController?.signal.aborted)` branch:

```ts
    } finally {
      this.turnIdleGuard?.dispose();
      this.turnIdleGuard = undefined;
      activeTurnGuard = null;

      if (!retryingWithoutImages && !this.abortController?.signal.aborted && turnCompleted && !turnFailed) {
        // ... existing completed outcome (unchanged) ...
      } else if (!retryingWithoutImages && this.idleTimedOut) {
        this.emitTurnOutcome({ outcome: 'interrupted', reason: TURN_IDLE_TIMEOUT_MESSAGE });
        process.stderr.write('[codex] Turn ended by idle timeout\n');
      } else if (!retryingWithoutImages && !this.abortController?.signal.aborted) {
        // ... existing interrupted/failed outcome (unchanged) ...
      }
      // ... existing lifecycle log / cleanup (unchanged) ...
    }
```

Note: keep the original `else if (!retryingWithoutImages && !this.abortController?.signal.aborted) { this.emitTurnOutcome(...); ... }` branch intact below the new idle branch; the diff is insertion-only plus the leading guard disposal.

**`src-tauri/sidecar/src/codexCompatProxy.ts`:**

Update the dynamic import in `resolveInteractiveUserInputToolCalls`:

```ts
  const { emit: emitEvent, emitActiveCodexTurnEvent, activeSessionId, getActiveCodexQuestionTimeoutMs, suspendActiveTurnGuard, resumeActiveTurnGuard } = await import('./codexRuntime.js');
```

Replace the interactive wait block:

```ts
      suspendActiveTurnGuard();
      try {
        response = await waitForInteractiveToolResponse(toolCall.id, {
          sessionId: activeSessionId,
          timeoutMs: getActiveCodexQuestionTimeoutMs(),
        });
      } finally {
        resumeActiveTurnGuard();
      }
      if (isInteractiveToolTimeoutResponse(response)) {
        isError = true;
        emitActiveCodexTurnEvent({
          kind: 'error', subtype: 'user_input_timeout', message: INTERACTIVE_USER_INPUT_TIMEOUT_MESSAGE,
        });
      }
```

Remove the now-unused constant `INTERACTIVE_USER_INPUT_TIMEOUT_MS` (line 22). Keep `INTERACTIVE_USER_INPUT_TIMEOUT_MESSAGE`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri/sidecar && npx vitest run src/codexRuntime.test.ts`
Expected: PASS — new idle test passes; existing Codex tests pass.

Run: `cd src-tauri/sidecar && npx vitest run src/codexCompatProxy.test.ts`
Expected: PASS — blocked-path tests unaffected; the direct `waitForInteractiveToolResponse` timeout test still passes because it passes `timeoutMs` explicitly.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/sidecar/src/codexRuntime.ts src-tauri/sidecar/src/codexCompatProxy.ts src-tauri/sidecar/src/codexRuntime.test.ts
git commit -m "feat(sidecar): enforce Codex turn idle timeout and configurable question waits"
```

---

## Task 9: OpenCode runtime — remove total-duration timeout, add idle guard + permission/question policy

**Files:**
- Modify: `src-tauri/sidecar/src/opencodeRuntime.ts`
- Modify: `src-tauri/sidecar/src/opencodePermissions.ts`
- Modify: `src-tauri/sidecar/src/opencodeRuntime.test.ts`

- [ ] **Step 1: Write the failing tests**

Rewrite the existing test at `src-tauri/sidecar/src/opencodeRuntime.test.ts` (the one titled `'aborts and emits a terminal error when the provider prompt exceeds its timeout'`, ~line 183) and change the `createConfig` helper to accept overrides.

Replace `createConfig` with:

```ts
function createConfig(overrides: Partial<OpenCodeSessionConfig> = {}): OpenCodeSessionConfig {
  return {
    cwd: 'D:/workspace/demo',
    sessionId: 'codemux-session-1',
    runtimeGeneration: 1,
    provider: 'codemux-openai',
    model: 'gpt-5',
    credentialSource: 'codemux',
    apiKey: 'secret-key',
    baseUrl: 'https://provider.example/v1',
    runtimeRef: sdkMocks.runtimeRef,
    ...overrides,
  };
}
```

Replace the old timeout test with:

```ts
it('aborts and emits a terminal timeout error when no progress events arrive before the idle timeout', async () => {
  vi.useFakeTimers();
  try {
    const { port, client } = createPort();
    client.prompt.mockResolvedValue(undefined);
    client.subscribe = vi.fn().mockResolvedValue({ close: vi.fn() });
    const emitted: unknown[] = [];
    const runtime = new OpenCodeRuntime(createConfig({ timeouts: { idle_timeout_ms: 25 } }), port, {
      emitEvent: (event) => emitted.push(event),
      eventIdFactory: () => 'event-timeout',
    } as any);

    await runtime.start();
    const sendPromise = runtime.sendInput('hello');
    await vi.advanceTimersByTimeAsync(25);
    await sendPromise;

    expect(client.abort).toHaveBeenCalledWith('opencode-new');
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'error', subtype: 'timeout' }),
      expect.objectContaining({ type: 'turn_finished', outcome: 'failed' }),
    ]));
  } finally {
    vi.useRealTimers();
  }
});
```

Add a suspend-on-permission test:

```ts
it('does not expire the turn while a permission is awaiting approval', async () => {
  vi.useFakeTimers();
  try {
    const { port, client } = createPort();
    client.prompt.mockResolvedValue(undefined);
    client.respondToPermission.mockResolvedValue(true);
    let onEvent: (event: unknown) => void = () => undefined;
    client.subscribe = vi.fn().mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
      onEvent = input.onEvent;
      return { close: vi.fn() };
    });
    const emitted: unknown[] = [];
    const runtime = new OpenCodeRuntime(createConfig({ timeouts: { idle_timeout_ms: 25, approval_timeout_ms: 0 } }), port, {
      emitEvent: (event) => emitted.push(event),
      eventIdFactory: () => 'event-id',
    } as any);

    await runtime.start();
    const sendPromise = runtime.sendInput('hello');
    onEvent({
      type: 'permission.asked',
      properties: { id: 'perm-1', sessionID: 'opencode-new', type: 'write', title: 'edit file' },
    });

    await vi.advanceTimersByTimeAsync(2000);
    expect(client.abort).not.toHaveBeenCalled();
    expect(emitted.some((event) => (event as { type?: string }).type === 'turn_finished')).toBe(false);

    onEvent({ type: 'session.idle', properties: { sessionID: 'opencode-new' } });
    await sendPromise;
  } finally {
    vi.useRealTimers();
  }
});
```

Add permission-registry tests in `src-tauri/sidecar/src/opencodePermissions.test.ts`:

```ts
it('waits indefinitely when no timeoutMs is provided (approval default)', async () => {
  const registry = new OpenCodePermissionRegistry({ nativeResponseTimeoutMs: 1_000 });
  const record = registry.upsert({
    requestId: 'perm-infinite',
    codeMuxSessionId: 'session-1',
    permissionType: 'write',
    raw: {},
    respond: async () => true,
  });
  expect(record.record?.deadline).toBe(Infinity);
  await registry.respond('perm-infinite', 'session-1', 'once');
  expect(registry.hasPending('session-1')).toBe(false);
});

it('hasPending reports only pending entries for the given session', async () => {
  const registry = new OpenCodePermissionRegistry({ timeoutMs: 1_000 });
  registry.upsert({
    requestId: 'perm-a',
    codeMuxSessionId: 'session-1',
    permissionType: 'write',
    raw: {},
    respond: async () => true,
  });
  registry.upsert({
    requestId: 'perm-b',
    codeMuxSessionId: 'session-2',
    permissionType: 'bash',
    raw: {},
    respond: async () => true,
  });
  expect(registry.hasPending('session-1')).toBe(true);
  expect(registry.hasPending('session-2')).toBe(true);
  await registry.respond('perm-a', 'session-1', 'once');
  expect(registry.hasPending('session-1')).toBe(false);
  expect(registry.hasPending('session-2')).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri/sidecar && npx vitest run src/opencodeRuntime.test.ts`
Expected: FAIL — `timeouts` on the config has no effect (idle timeout does not fire), and `approval_timeout_ms` does not suspend anything.

Run: `cd src-tauri/sidecar && npx vitest run src/opencodePermissions.test.ts`
Expected: FAIL — default `deadline` is `now + 300000`, not `Infinity`; `hasPending` does not exist.

- [ ] **Step 3: Write the implementation**

**`src-tauri/sidecar/src/opencodeRuntime.ts`:**

Add imports:

```ts
import { resolveTurnTimeouts, type ResolvedTurnTimeouts, type TurnTimeouts } from './turnTimeouts.js';
import { createTurnIdleGuard, type TurnIdleGuard } from './turnIdleGuard.js';
```

Remove `DEFAULT_PROMPT_TIMEOUT_MS` (line 24) and the `promptTimeoutMs` option/field/validation:
- Delete `export const DEFAULT_PROMPT_TIMEOUT_MS = 600_000;`
- Delete `promptTimeoutMs?: number;` from `OpenCodeRuntimeOptions`.
- Delete `private readonly promptTimeoutMs: number;`
- Delete `this.promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;`
- Delete the `if (!Number.isFinite(this.promptTimeoutMs) || this.promptTimeoutMs <= 0) { throw new RangeError(...) }` block.

Add fields to the class:

```ts
  private readonly timeouts: ResolvedTurnTimeouts;
  private turnIdleGuard: TurnIdleGuard | undefined;
  private idleTimedOut = false;
  private readonly questionTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
```

In the constructor, replace the permission registry construction and add the timeouts resolution:

```ts
    this.timeouts = resolveTurnTimeouts(config.timeouts);
    this.permissions = new OpenCodePermissionRegistry({
      timeoutMs:
        options.permissionTimeoutMs
        ?? (this.timeouts.approval_timeout_ms > 0 ? this.timeouts.approval_timeout_ms : undefined),
      nativeResponseTimeoutMs: options.nativeResponseTimeoutMs,
    });
```

Remove the `awaitPromptWithTimeout` method entirely (lines 577-597).

In `sendInput`, after `this.beginTurnEventState();`, create the guard:

```ts
    this.idleTimedOut = false;
    this.turnIdleGuard = createTurnIdleGuard({
      idleTimeoutMs: this.timeouts.idle_timeout_ms,
      onExpired: () => {
        this.idleTimedOut = true;
        writeLog('[opencode-task]', `turn idle timeout after ${this.timeouts.idle_timeout_ms}ms; aborting session`);
        void this.client?.abort(sessionId).catch(() => undefined);
        this.handleSdkEvent({ type: 'session.error', properties: { sessionID: sessionId, error: { name: 'OpenCodeIdleTimeoutError', data: { message: `No progress events for ${this.timeouts.idle_timeout_ms}ms; turn idle timed out` } } } });
      },
    });
```

Replace the handled-task creation:

```ts
    const handledTask = task.catch((error) => {
      if (isAbortError(error) || this.idleTimedOut) {
        writeLog('[opencode-task]', `sendInput settled (abort or idle timeout): ${errorMessage(error)}`);
        return;
      }
      writeLog('[opencode-task]', `sendInput ERROR propagating: ${errorMessage(error)}`);
      throw error;
    });
```

In the `sendInput` `finally` block, at the start, dispose the guard:

```ts
    } finally {
      this.turnIdleGuard?.dispose();
      this.turnIdleGuard = undefined;
      this.idleTimedOut = false;
      if (this.pendingTurnCompletion?.sessionId === sessionId) {
        ...
      }
      ...
    }
```

Add the sync helper near `handleSdkEvent`:

```ts
  private syncGuardWithInteractiveState(): void {
    const hasPendingInteraction =
      this.pendingQuestionIds.size > 0 || this.permissions.hasPending(this.config.sessionId);
    if (hasPendingInteraction) {
      this.turnIdleGuard?.suspend();
    } else {
      this.turnIdleGuard?.reset();
    }
  }
```

At the top of `handleSdkEvent`, right after the `permissionClosing` early return (line 418-420), add:

```ts
    this.syncGuardWithInteractiveState();
```

At the end of `handlePermissionEvent` (after `this.eventSequence += 1;`), add:

```ts
    this.syncGuardWithInteractiveState();
```

In `handleQuestionEvent`, add the optional question timeout and the sync at the end (after `this.eventSequence += 1;`):

```ts
    if (this.timeouts.question_timeout_ms > 0) {
      const timer = setTimeout(() => {
        this.questionTimeouts.delete(requestId);
        void this.respondToQuestion(requestId, []).catch(() => undefined);
      }, this.timeouts.question_timeout_ms);
      timer.unref?.();
      this.questionTimeouts.set(requestId, timer);
    }
    this.syncGuardWithInteractiveState();
```

Update `respondToPermission` to re-sync after resolving:

```ts
  respondToPermission(requestId: string, response: OpenCodePermissionResponse, codeMuxSessionId = this.config.sessionId): Promise<void> {
    return this.permissions.respond(requestId, codeMuxSessionId, response)
      .finally(() => this.syncGuardWithInteractiveState());
  }
```

Update `respondToQuestion` to clear the per-question timer and re-sync:

```ts
  async respondToQuestion(requestId: string, answers: string[][]): Promise<void> {
    this.pendingQuestionIds.delete(requestId);
    const timer = this.questionTimeouts.get(requestId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.questionTimeouts.delete(requestId);
    }
    const client = this.client;
    if (client?.respondToQuestion) {
      await client.respondToQuestion({ requestId, answers, directory: this.config.cwd });
      this.emitToolFinished(requestId, JSON.stringify({ answers }));
    }
    this.syncGuardWithInteractiveState();
  }
```

In `clearEventState`, clear any scheduled question timers:

```ts
  private clearEventState(): void {
    for (const timer of this.questionTimeouts.values()) {
      clearTimeout(timer);
    }
    this.questionTimeouts.clear();
    this.seenEventIds.clear();
    ...
  }
```

Remove the now-unused `isPromptTimeoutError` function (lines 938-940).

**`src-tauri/sidecar/src/opencodePermissions.ts`:**

Make the timeout optional (undefined = infinite) and add `hasPending`:

- Change the field type: `private readonly timeoutMs: number | undefined;`
- Constructor:

```ts
    this.timeoutMs = options.timeoutMs;
    this.nativeResponseTimeoutMs = options.nativeResponseTimeoutMs ?? 30_000;
    this.expiredTombstoneTtlMs =
      options.expiredTombstoneTtlMs
      ?? (this.timeoutMs === undefined ? 60_000 : Math.max(this.timeoutMs, 60_000));
    this.maxExpiredTombstones = options.maxExpiredTombstones ?? 1_024;
    if (this.timeoutMs !== undefined && (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0)) {
      throw new RangeError('OpenCode permission timeout must be a positive finite number');
    }
    if (!Number.isFinite(this.expiredTombstoneTtlMs) || this.expiredTombstoneTtlMs <= 0) {
      throw new RangeError('OpenCode expired permission tombstone TTL must be a positive finite number');
    }
    if (!Number.isFinite(this.nativeResponseTimeoutMs) || this.nativeResponseTimeoutMs <= 0) {
      throw new RangeError('OpenCode native permission response timeout must be a positive finite number');
    }
    if (!Number.isInteger(this.maxExpiredTombstones) || this.maxExpiredTombstones <= 0) {
      throw new RangeError('OpenCode expired permission tombstone limit must be a positive integer');
    }
```

- In `upsert`, change the deadline:

```ts
      deadline: this.timeoutMs === undefined ? Infinity : now + this.timeoutMs,
```

- In `scheduleTimeout`, skip infinite deadlines (avoid `setTimeout(..., Infinity)` clamping to 1ms):

```ts
  private scheduleTimeout(entry: PermissionEntry): void {
    if (!Number.isFinite(entry.deadline)) {
      return;
    }
    const remainingMs = entry.deadline - Date.now();
    ...
  }
```

- Add `hasPending` after the `get` method:

```ts
  hasPending(codeMuxSessionId: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.codeMuxSessionId === codeMuxSessionId && entry.state !== 'cancelled') {
        return true;
      }
    }
    return false;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri/sidecar && npx vitest run src/opencodeRuntime.test.ts`
Expected: PASS — idle timeout test passes; suspend-on-permission test passes; existing OpenCode runtime tests pass.

Run: `cd src-tauri/sidecar && npx vitest run src/opencodePermissions.test.ts`
Expected: PASS — new tests pass; existing permission registry tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/sidecar/src/opencodeRuntime.ts src-tauri/sidecar/src/opencodePermissions.ts src-tauri/sidecar/src/opencodeRuntime.test.ts src-tauri/sidecar/src/opencodePermissions.test.ts
git commit -m "feat(sidecar): OpenCode turn idle timeout and interactive request policy"
```

---

## Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Sidecar tests**

Run: `cd src-tauri/sidecar && npx vitest run`
Expected: PASS (all sidecar tests).

- [ ] **Step 2: Root tests + type-check**

Run: `npx vitest run`
Expected: PASS (all root TS/React tests).

Run: `npm run build`
Expected: PASS — `tsc` type-check plus Vite build (validates the `src/types/provider.ts` changes).

- [ ] **Step 3: Rust checks**

Run: `cd src-tauri && cargo fmt --all -- --check`
Expected: PASS.

Run: `cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings`
Expected: PASS.

Run: `cd src-tauri && cargo check --all-targets --all-features`
Expected: PASS.

Run: `cd src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 4: Commit any stragglers and record verification**

```bash
git status
git commit -m "chore: verify turn timeout and interactive request policy changes"
```

- [ ] **Step 5: Manual smoke (optional)**

Run: `npm run tauri dev`, start a Claude Code session, leave it idle past `idle_timeout_ms`, and confirm the turn ends as a recoverable failure (session can be re-prompted). Then start an OpenCode session, trigger a permission prompt, and confirm it waits indefinitely.

---

## Self-Review

**Spec coverage (ADR 0004 decisions):**
- A (dual-track, interactive = infinite, unattended optional): approval/question default `0` in `turnTimeouts.ts` → infinite waits in Claude (Task 7), Codex proxy (Task 8), OpenCode registry (Task 9); idle timeout default `300000` everywhere.
- B (pure idle, no total duration, default 5 min, covers all three runtimes): `DEFAULT_IDLE_TIMEOUT_MS` + guard in all three runtimes; OpenCode `DEFAULT_PROMPT_TIMEOUT_MS`/`awaitPromptWithTimeout` removed (Task 9).
- C (expiry aborts current turn, recoverable, no auto-retry): Claude throws the existing `Query timed out` failure → warmup path; Codex aborts the stream and emits `interrupted`; OpenCode aborts the session and emits `session.error` → `failed`. No retry logic added anywhere.
- D (approval default infinite + optional `approval_timeout_ms`, auto-reject only the pending request): OpenCode registry now supports `timeoutMs: undefined` (infinite) and `approval_timeout_ms` maps into it; Claude `ExitPlanMode`/permission waits use `approval_timeout_ms`; expiry only affects that pending request.
- E (pending approvals/questions suspend the idle guard): OpenCode `syncGuardWithInteractiveState` (permissions + `pendingQuestionIds`), Claude `waitForInteractiveResponse` suspend/resume, Codex `suspendActiveTurnGuard`/`resumeActiveTurnGuard` around the proxy wait.
- F (`timeouts` key with three fields, profile settings → `ensure_session` + env fallback, no UI): `TurnTimeouts`/`AgentTimeouts` identical shapes; Rust `build_ensure_session_command` emits `cmd["timeouts"]`; env fallback in `turnTimeouts.ts`; no UI (frontend task is type-only).
- G (shared no-I/O state machine reused by all three runtimes): `turnIdleGuard.ts` consumed by Claude (pull), OpenCode (push), Codex (in-stream).

**Placeholder scan:** no TBD/TODO; every code step shows complete code.

**Type consistency:** `idle_timeout_ms` / `approval_timeout_ms` / `question_timeout_ms` are used identically in `turnTimeouts.ts`, `types.ts`, `opencodeRuntime.ts`, `codexRuntime.ts`, `index.ts`, Rust `AgentTimeouts`, and frontend `AgentTimeouts`. Guard method names (`reset`/`suspend`/`resume`/`isExpired`/`remainingIdleMs`/`dispose`) match Task 2's definition everywhere.
