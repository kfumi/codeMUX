# Codex Strict-Local Plan Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework Codex plan mode so CodeMUX enforces desktop-cc-gui style strict-local collaboration semantics in the existing Codex SDK sidecar.

**Architecture:** Add a focused sidecar policy module that normalizes `planMode` into `code` or `plan`, injects strict-local directives into Codex input, and exposes helpers for blocking forbidden tool behavior. Wire that module into `codexRuntime.ts` and `codexCompatProxy.ts`, keeping existing frontend controls while adding a compact diagnostic path for mode-blocked events.

**Tech Stack:** TypeScript sidecar, Vitest, OpenAI Codex SDK, existing React event rendering.

---

## File Structure

- Create `src-tauri/sidecar/src/codexCollaborationPolicy.ts`: owns strict-local policy resolution, directive text, input injection, blocked-event construction, and command mutation detection.
- Create `src-tauri/sidecar/src/codexCollaborationPolicy.test.ts`: unit tests for policy behavior and mutation detection.
- Modify `src-tauri/sidecar/src/codexRuntime.ts`: resolve/store policy, replace `$plan` primary path with directive injection, block plan-mode mutation events, and emit mode-blocked diagnostics.
- Modify `src-tauri/sidecar/src/codexRuntime.test.ts`: update plan-mode input expectations and add blocked event tests.
- Modify `src-tauri/sidecar/src/codexCompatProxy.ts`: block interactive user-input tool calls in code mode, allow them in plan mode.
- Modify `src-tauri/sidecar/src/codexCompatProxy.test.ts`: add strict-local request-user-input blocking tests.
- Modify frontend event parsing only if manual inspection shows `sidecar_stream_status` is not visible enough. Prefer no frontend changes.

## Task 1: Add Codex Collaboration Policy Module

**Files:**
- Create: `src-tauri/sidecar/src/codexCollaborationPolicy.ts`
- Create: `src-tauri/sidecar/src/codexCollaborationPolicy.test.ts`

- [ ] **Step 1: Write failing policy tests**

Create `src-tauri/sidecar/src/codexCollaborationPolicy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  applyCodexCollaborationPolicyToInput,
  buildCodexModeBlockedEvent,
  detectPlanModeBlockedMethod,
  resolveCodexCollaborationPolicy,
} from './codexCollaborationPolicy.js';

describe('codexCollaborationPolicy', () => {
  it('resolves planMode on to strict-local plan mode', () => {
    expect(resolveCodexCollaborationPolicy({ planMode: 'on' })).toMatchObject({
      selectedMode: 'plan',
      effectiveMode: 'plan',
      profile: 'strict-local',
      requestUserInputPolicy: 'allow',
      fallbackReason: null,
    });
  });

  it('resolves missing or off planMode to code mode that blocks user input tools', () => {
    expect(resolveCodexCollaborationPolicy({ planMode: 'off' })).toMatchObject({
      selectedMode: 'code',
      effectiveMode: 'code',
      requestUserInputPolicy: 'block',
    });
    expect(resolveCodexCollaborationPolicy({})).toMatchObject({
      effectiveMode: 'code',
      fallbackReason: 'missing_mode_in_request_default_code',
    });
  });

  it('injects plan directives into the first text input entry', () => {
    const policy = resolveCodexCollaborationPolicy({ planMode: 'on' });
    expect(applyCodexCollaborationPolicyToInput(
      [{ type: 'text', text: 'Design the feature.' }],
      policy,
    )).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('Execution policy (plan mode): work in planning-only style.'),
      },
    ]);
  });

  it('does not duplicate directives when applied twice', () => {
    const policy = resolveCodexCollaborationPolicy({ planMode: 'on' });
    const once = applyCodexCollaborationPolicyToInput([{ type: 'text', text: 'Plan it.' }], policy);
    const twice = applyCodexCollaborationPolicyToInput(once, policy);
    expect(twice).toEqual(once);
  });

  it('detects plan-mode file and repo mutation attempts', () => {
    expect(detectPlanModeBlockedMethod({
      type: 'file_change',
      id: 'patch-1',
      changes: [{ path: 'src/app.ts', kind: 'update' }],
    })).toBe('item/tool/apply_patch');

    expect(detectPlanModeBlockedMethod({
      type: 'command_execution',
      id: 'cmd-1',
      command: 'git commit -m "ship"',
      status: 'in_progress',
    })).toBe('item/tool/commandExecution:git commit');

    expect(detectPlanModeBlockedMethod({
      type: 'command_execution',
      id: 'cmd-2',
      command: 'git status --short',
      status: 'in_progress',
    })).toBeNull();
  });

  it('builds a mode-blocked diagnostic event', () => {
    expect(buildCodexModeBlockedEvent({
      blockedMethod: 'item/tool/requestUserInput',
      effectiveMode: 'code',
      reasonCode: 'request_user_input_blocked_in_default_mode',
      reason: 'requestUserInput is blocked while effective_mode=code',
      suggestion: 'Switch to Plan mode and resend the prompt when user input is needed.',
      requestId: 'tool-1',
    })).toEqual({
      type: 'sidecar_stream_status',
      message: expect.stringContaining('request_user_input_blocked_in_default_mode'),
      is_reconnecting: false,
      mode_blocked: {
        blocked_method: 'item/tool/requestUserInput',
        effective_mode: 'code',
        reason_code: 'request_user_input_blocked_in_default_mode',
        reason: 'requestUserInput is blocked while effective_mode=code',
        suggestion: 'Switch to Plan mode and resend the prompt when user input is needed.',
        request_id: 'tool-1',
      },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
cd src-tauri\sidecar
npx vitest run src/codexCollaborationPolicy.test.ts
```

Expected: FAIL because `codexCollaborationPolicy.ts` does not exist.

- [ ] **Step 3: Implement the policy module**

Create `src-tauri/sidecar/src/codexCollaborationPolicy.ts`:

```ts
import type { ThreadItem } from '@openai/codex-sdk';

import type { AgentInputPayload } from './agentInputPayload.js';
import type { AgentPlanMode } from './agentPermissions.js';

export const CODEX_COLLABORATION_POLICY_VERSION = 'codemux-codex-collaboration-policy/v1';

export type CodexCollaborationMode = 'code' | 'plan';
export type CodexCollaborationProfile = 'strict-local';
export type CodexRequestUserInputPolicy = 'allow' | 'block';

export type CodexCollaborationPolicy = {
  selectedMode: CodexCollaborationMode;
  effectiveMode: CodexCollaborationMode;
  profile: CodexCollaborationProfile;
  fallbackReason: string | null;
  policyVersion: typeof CODEX_COLLABORATION_POLICY_VERSION;
  requestUserInputPolicy: CodexRequestUserInputPolicy;
  directives: string[];
};

export type CodexModeBlockedEvent = {
  type: 'sidecar_stream_status';
  message: string;
  is_reconnecting: false;
  mode_blocked: {
    blocked_method: string;
    effective_mode: CodexCollaborationMode;
    reason_code: string;
    reason: string;
    suggestion: string;
    request_id: string | null;
  };
};

const POLICY_MARKER_START = '<codemux-codex-collaboration-policy>';
const POLICY_MARKER_END = '</codemux-codex-collaboration-policy>';

let activeCodexCollaborationPolicy = resolveCodexCollaborationPolicy({});

export function setActiveCodexCollaborationPolicy(policy: CodexCollaborationPolicy): void {
  activeCodexCollaborationPolicy = policy;
}

export function getActiveCodexCollaborationPolicy(): CodexCollaborationPolicy {
  return activeCodexCollaborationPolicy;
}

export function normalizeCodexCollaborationMode(value: unknown): CodexCollaborationMode | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'plan') return 'plan';
  if (normalized === 'code' || normalized === 'default') return 'code';
  return null;
}

export function resolveCodexCollaborationPolicy(input: {
  planMode?: AgentPlanMode;
  collaborationMode?: unknown;
  previousMode?: CodexCollaborationMode | null;
}): CodexCollaborationPolicy {
  const explicitMode = normalizeCodexCollaborationMode(input.collaborationMode);
  const selectedMode = explicitMode ?? (input.planMode === 'on' ? 'plan' : input.planMode === 'off' ? 'code' : null);
  const fallbackReason = selectedMode
    ? null
    : input.previousMode
      ? 'missing_mode_in_request_using_thread_state'
      : 'missing_mode_in_request_default_code';
  const effectiveMode = selectedMode ?? input.previousMode ?? 'code';
  const requestUserInputPolicy: CodexRequestUserInputPolicy = effectiveMode === 'code' ? 'block' : 'allow';

  return {
    selectedMode: effectiveMode,
    effectiveMode,
    profile: 'strict-local',
    fallbackReason,
    policyVersion: CODEX_COLLABORATION_POLICY_VERSION,
    requestUserInputPolicy,
    directives: buildCodexCollaborationDirectives(effectiveMode),
  };
}

export function buildCodexCollaborationDirectives(mode: CodexCollaborationMode): string[] {
  if (mode === 'code') {
    return [
      'Execution policy (default mode): keep execution autonomous. Do not ask the user follow-up questions and avoid requestUserInput / askuserquestion interactions. If details are missing, make minimal reasonable assumptions, proceed, and report assumptions briefly.',
    ];
  }

  return [
    'Execution policy (plan mode): work in planning-only style. You MAY inspect files and run read-only checks, but MUST NOT apply file edits or execute repository-mutating operations.',
    'Execution policy (plan mode): if a blocker appears (missing path/context, ambiguous scope, permission gap, or any prerequisite failure), you MUST immediately stop further work, call requestUserInput / askuserquestion with concrete options, and WAIT for user input before continuing. Do not silently continue with assumptions.',
    'Execution policy (plan mode): when you need extra user information (for example path, credentials, env value, target scope, preference, or any missing input), you MUST ask via requestUserInput / askuserquestion. Plain-text follow-up questions are NOT allowed.',
  ];
}

export function applyCodexCollaborationPolicyToPayload(
  payload: AgentInputPayload,
  policy: CodexCollaborationPolicy,
): AgentInputPayload {
  return {
    ...payload,
    text: injectPolicyText(payload.text, policy),
  };
}

export function applyCodexCollaborationPolicyToInput(
  input: unknown[],
  policy: CodexCollaborationPolicy,
): unknown[] {
  const policyBlock = renderPolicyBlock(policy);
  let injected = false;
  const next = input.map((entry) => {
    if (injected || !isRecord(entry) || entry.type !== 'text' || typeof entry.text !== 'string') {
      return entry;
    }
    injected = true;
    return {
      ...entry,
      text: entry.text.includes(POLICY_MARKER_START)
        ? entry.text
        : `${policyBlock}\n\n${entry.text}`.trim(),
    };
  });
  if (injected) return next;
  return [{ type: 'text', text: policyBlock }, ...input];
}

function injectPolicyText(text: string, policy: CodexCollaborationPolicy): string {
  if (text.includes(POLICY_MARKER_START)) return text;
  return `${renderPolicyBlock(policy)}\n\n${text}`.trim();
}

function renderPolicyBlock(policy: CodexCollaborationPolicy): string {
  return [
    POLICY_MARKER_START,
    `policy_version: ${policy.policyVersion}`,
    `profile: ${policy.profile}`,
    `effective_mode: ${policy.effectiveMode}`,
    `request_user_input_policy: ${policy.requestUserInputPolicy}`,
    ...policy.directives,
    POLICY_MARKER_END,
  ].join('\n');
}

export function detectPlanModeBlockedMethod(item: unknown): string | null {
  if (!isRecord(item)) return null;
  const itemType = String(item.type ?? '').toLowerCase();
  const itemName = String(item.name ?? '').toLowerCase();
  const itemToolType = String(item.toolType ?? item.tool_type ?? '').toLowerCase();
  if (
    itemType === 'file_change' ||
    itemType === 'apply_patch' ||
    itemName === 'apply_patch' ||
    itemToolType === 'filechange' ||
    itemToolType === 'apply_patch'
  ) {
    return 'item/tool/apply_patch';
  }

  if (itemType === 'command_execution' || itemToolType === 'commandexecution') {
    const tokens = normalizeCommandTokens(item.command);
    if (isRepoMutatingCommandTokens(tokens)) {
      return `item/tool/commandExecution:${tokens.slice(0, 2).join(' ')}`.trim();
    }
  }

  return null;
}

export function shouldBlockPlanModeItem(
  item: ThreadItem,
  policy: CodexCollaborationPolicy,
): string | null {
  if (policy.effectiveMode !== 'plan') return null;
  return detectPlanModeBlockedMethod(item);
}

export function isInteractiveUserInputToolName(name: unknown): boolean {
  return name === 'request_user_input' || name === 'askUserQuestion' || name === 'AskUserQuestion';
}

export function buildCodexModeBlockedEvent(input: {
  blockedMethod: string;
  effectiveMode: CodexCollaborationMode;
  reasonCode: string;
  reason: string;
  suggestion: string;
  requestId?: string | null;
}): CodexModeBlockedEvent {
  const requestId = input.requestId ?? null;
  return {
    type: 'sidecar_stream_status',
    message: `Codex collaboration mode blocked ${input.blockedMethod}: ${input.reasonCode}. ${input.reason}`,
    is_reconnecting: false,
    mode_blocked: {
      blocked_method: input.blockedMethod,
      effective_mode: input.effectiveMode,
      reason_code: input.reasonCode,
      reason: input.reason,
      suggestion: input.suggestion,
      request_id: requestId,
    },
  };
}

export function buildRequestUserInputBlockedEvent(toolUseId: string | null): CodexModeBlockedEvent {
  return buildCodexModeBlockedEvent({
    blockedMethod: 'item/tool/requestUserInput',
    effectiveMode: 'code',
    reasonCode: 'request_user_input_blocked_in_default_mode',
    reason: 'requestUserInput is blocked while effective_mode=code',
    suggestion: 'Switch to Plan mode and resend the prompt when user input is needed.',
    requestId: toolUseId,
  });
}

export function buildPlanMutationBlockedEvent(blockedMethod: string, itemId: string | null): CodexModeBlockedEvent {
  return buildCodexModeBlockedEvent({
    blockedMethod,
    effectiveMode: 'plan',
    reasonCode: 'plan_readonly_violation',
    reason: 'This operation is blocked while effective_mode=plan.',
    suggestion: 'Switch to full access mode and retry the write operation.',
    requestId: itemId,
  });
}

function normalizeCommandTokens(command: unknown): string[] {
  if (typeof command === 'string') {
    return command
      .split(/\s+/)
      .map((token) => token.trim().replace(/^["']|["']$/g, '').toLowerCase())
      .filter(Boolean);
  }
  if (Array.isArray(command)) {
    return command
      .filter((token): token is string => typeof token === 'string')
      .map((token) => token.trim().replace(/^["']|["']$/g, '').toLowerCase())
      .filter(Boolean);
  }
  return [];
}

function isRepoMutatingCommandTokens(tokens: string[]): boolean {
  if (tokens[0] !== 'git') return false;
  return new Set([
    'add',
    'commit',
    'push',
    'pull',
    'merge',
    'rebase',
    'cherry-pick',
    'revert',
    'reset',
    'stash',
    'am',
    'apply',
    'rm',
    'mv',
    'checkout',
    'switch',
    'restore',
    'clean',
    'tag',
    'branch',
    'fetch',
  ]).has(tokens[1] ?? '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
```

- [ ] **Step 4: Run policy tests**

Run:

```powershell
cd src-tauri\sidecar
npx vitest run src/codexCollaborationPolicy.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri\sidecar\src\codexCollaborationPolicy.ts src-tauri\sidecar\src\codexCollaborationPolicy.test.ts
git commit -m "feat(codex): add strict local collaboration policy"
```

## Task 2: Wire Policy Into Codex Runtime Input And Thread Options

**Files:**
- Modify: `src-tauri/sidecar/src/codexRuntime.ts`
- Modify: `src-tauri/sidecar/src/codexRuntime.test.ts`

- [ ] **Step 1: Update runtime tests for policy injection**

In `src-tauri/sidecar/src/codexRuntime.test.ts`, replace the three `$plan` prefix tests with:

```ts
  it('injects strict-local plan directives before streaming Codex input', async () => {
    const writes: string[] = [];
    let streamedInput: unknown;
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    try {
      const runtime = new CodexSessionRuntime();
      (runtime as unknown as {
        config: {
          sessionId: string;
          cwd: string;
          model: string;
          planMode: 'on';
        };
        thread: {
          id: string;
          runStreamed: (input: unknown) => Promise<{ events: AsyncGenerator<ThreadEvent> }>;
        };
      }).config = {
        sessionId: 'session-1',
        cwd: 'D:/repo',
        model: 'gpt-5',
        planMode: 'on',
      };
      (runtime as unknown as {
        thread: {
          id: string;
          runStreamed: (input: unknown) => Promise<{ events: AsyncGenerator<ThreadEvent> }>;
        };
      }).thread = {
        id: 'codex-thread-1',
        runStreamed: async (input) => {
          streamedInput = input;
          return {
            events: (async function* () {
              yield {
                type: 'turn.completed',
                usage: {
                  input_tokens: 1,
                  cached_input_tokens: 0,
                  output_tokens: 1,
                  reasoning_output_tokens: 0,
                },
              } as ThreadEvent;
            })(),
          };
        },
      };

      await (runtime as unknown as {
        runInput: (prompt: string, inputPayload: undefined, includeImages: boolean) => Promise<void>;
      }).runInput('build a login form', undefined, false);

      expect(streamedInput).toEqual([
        {
          type: 'text',
          text: expect.stringContaining('Execution policy (plan mode): work in planning-only style.'),
        },
      ]);
      expect(JSON.stringify(streamedInput)).toContain('build a login form');
      expect(JSON.stringify(streamedInput)).not.toContain('$plan build a login form');
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('injects code-mode autonomous directives when plan mode is off', async () => {
    const writes: string[] = [];
    let streamedInput: unknown;
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    try {
      const runtime = new CodexSessionRuntime();
      (runtime as unknown as {
        config: {
          sessionId: string;
          cwd: string;
          model: string;
          planMode: 'off';
        };
        thread: {
          id: string;
          runStreamed: (input: unknown) => Promise<{ events: AsyncGenerator<ThreadEvent> }>;
        };
      }).config = {
        sessionId: 'session-1',
        cwd: 'D:/repo',
        model: 'gpt-5',
        planMode: 'off',
      };
      (runtime as unknown as {
        thread: {
          id: string;
          runStreamed: (input: unknown) => Promise<{ events: AsyncGenerator<ThreadEvent> }>;
        };
      }).thread = {
        id: 'codex-thread-1',
        runStreamed: async (input) => {
          streamedInput = input;
          return {
            events: (async function* () {
              yield {
                type: 'turn.completed',
                usage: {
                  input_tokens: 1,
                  cached_input_tokens: 0,
                  output_tokens: 1,
                  reasoning_output_tokens: 0,
                },
              } as ThreadEvent;
            })(),
          };
        },
      };

      await (runtime as unknown as {
        runInput: (prompt: string, inputPayload: undefined, includeImages: boolean) => Promise<void>;
      }).runInput('fix the bug', undefined, false);

      expect(streamedInput).toEqual([
        {
          type: 'text',
          text: expect.stringContaining('Execution policy (default mode): keep execution autonomous.'),
        },
      ]);
      expect(JSON.stringify(streamedInput)).toContain('fix the bug');
    } finally {
      stdoutSpy.mockRestore();
    }
  });
```

- [ ] **Step 2: Run runtime tests to verify failure**

Run:

```powershell
cd src-tauri\sidecar
npx vitest run src/codexRuntime.test.ts
```

Expected: FAIL because `codexRuntime.ts` still uses `$plan`.

- [ ] **Step 3: Modify imports and config policy state**

In `src-tauri/sidecar/src/codexRuntime.ts`, add imports:

```ts
import {
  applyCodexCollaborationPolicyToInput,
  buildPlanMutationBlockedEvent,
  resolveCodexCollaborationPolicy,
  setActiveCodexCollaborationPolicy,
  shouldBlockPlanModeItem,
  type CodexCollaborationPolicy,
} from './codexCollaborationPolicy.js';
```

Add to `CodexSessionBootstrap`:

```ts
  collaborationPolicy?: CodexCollaborationPolicy;
```

In `ensure()`, after `requestedConfig` is created, resolve and store policy:

```ts
    const collaborationPolicy = resolveCodexCollaborationPolicy({
      planMode: requestedConfig.planMode,
      previousMode: this.config?.collaborationPolicy?.effectiveMode ?? null,
    });
    setActiveCodexCollaborationPolicy(collaborationPolicy);
```

Include `collaborationPolicy` in `this.config`:

```ts
    this.config = {
      ...requestedConfig,
      runtimeBaseUrl,
      collaborationPolicy,
    };
```

For early-return reuse, set the active policy before emitting ready:

```ts
      if (this.config.collaborationPolicy) {
        setActiveCodexCollaborationPolicy(this.config.collaborationPolicy);
      }
```

- [ ] **Step 4: Replace `$plan` payload path**

In `runInput()`, replace:

```ts
    const payload = applyCodexPlanPrefix(
      normalizeAgentInputPayload(prompt, inputPayload),
      this.config.planMode,
    );
```

with:

```ts
    const collaborationPolicy = this.config.collaborationPolicy
      ?? resolveCodexCollaborationPolicy({ planMode: this.config.planMode });
    const payload = normalizeAgentInputPayload(prompt, inputPayload);
```

Then replace the `runStreamed()` input call:

```ts
      const { events } = await this.thread.runStreamed(buildCodexInputEntries(payload, imagePaths, includeImages) as any, {
```

with:

```ts
      const codexInput = applyCodexCollaborationPolicyToInput(
        buildCodexInputEntries(payload, imagePaths, includeImages) as unknown[],
        collaborationPolicy,
      );
      const { events } = await this.thread.runStreamed(codexInput as any, {
```

Remove `CODEX_PLAN_PREFIX` and `applyCodexPlanPrefix()` from the bottom of the file.

- [ ] **Step 5: Run runtime tests**

Run:

```powershell
cd src-tauri\sidecar
npx vitest run src/codexRuntime.test.ts src/codexCollaborationPolicy.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src-tauri\sidecar\src\codexRuntime.ts src-tauri\sidecar\src\codexRuntime.test.ts
git commit -m "feat(codex): inject strict local collaboration directives"
```

## Task 3: Block Plan-Mode Mutating SDK Items

**Files:**
- Modify: `src-tauri/sidecar/src/codexRuntime.ts`
- Modify: `src-tauri/sidecar/src/codexRuntime.test.ts`

- [ ] **Step 1: Add failing runtime tests for blocked plan items**

Append to `src-tauri/sidecar/src/codexRuntime.test.ts`:

```ts
  it('blocks Codex file_change items while plan mode is active', () => {
    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    try {
      const runtime = new CodexSessionRuntime();
      (runtime as unknown as {
        config: {
          sessionId: string;
          cwd: string;
          model: string;
          planMode: 'on';
          collaborationPolicy: ReturnType<typeof import('./codexCollaborationPolicy.js').resolveCodexCollaborationPolicy>;
        };
      }).config = {
        sessionId: 'session-1',
        cwd: 'D:/repo',
        model: 'gpt-5',
        planMode: 'on',
        collaborationPolicy: resolveCodexCollaborationPolicy({ planMode: 'on' }),
      };

      const emitItemEvent = (
        runtime as unknown as {
          emitItemEvent: (
            sessionId: string,
            eventType: 'item.started' | 'item.updated' | 'item.completed',
            item: ThreadEvent extends { item: infer T } ? T : never,
            emitFailure: (message: string) => void,
          ) => void;
        }
      ).emitItemEvent.bind(runtime);

      emitItemEvent(
        'session-1',
        'item.completed',
        {
          id: 'patch-1',
          type: 'file_change',
          changes: [{ path: 'src/app.ts', kind: 'update' }],
          status: 'completed',
        },
        () => {},
      );

      const emittedEvents = writes
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));

      expect(emittedEvents).toEqual([
        expect.objectContaining({
          type: 'sidecar_stream_status',
          mode_blocked: expect.objectContaining({
            effective_mode: 'plan',
            reason_code: 'plan_readonly_violation',
            request_id: 'patch-1',
          }),
        }),
      ]);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('blocks repo-mutating Codex commands while plan mode is active', () => {
    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    try {
      const runtime = new CodexSessionRuntime();
      (runtime as unknown as {
        config: {
          sessionId: string;
          cwd: string;
          model: string;
          planMode: 'on';
          collaborationPolicy: ReturnType<typeof import('./codexCollaborationPolicy.js').resolveCodexCollaborationPolicy>;
        };
      }).config = {
        sessionId: 'session-1',
        cwd: 'D:/repo',
        model: 'gpt-5',
        planMode: 'on',
        collaborationPolicy: resolveCodexCollaborationPolicy({ planMode: 'on' }),
      };

      const emitItemEvent = (
        runtime as unknown as {
          emitItemEvent: (
            sessionId: string,
            eventType: 'item.started' | 'item.updated' | 'item.completed',
            item: ThreadEvent extends { item: infer T } ? T : never,
            emitFailure: (message: string) => void,
          ) => void;
        }
      ).emitItemEvent.bind(runtime);

      emitItemEvent(
        'session-1',
        'item.started',
        {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'git commit -m "ship"',
          aggregated_output: '',
          status: 'in_progress',
        },
        () => {},
      );

      const emittedEvents = writes
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));

      expect(emittedEvents).toEqual([
        expect.objectContaining({
          type: 'sidecar_stream_status',
          mode_blocked: expect.objectContaining({
            blocked_method: 'item/tool/commandExecution:git commit',
            effective_mode: 'plan',
          }),
        }),
      ]);
    } finally {
      stdoutSpy.mockRestore();
    }
  });
```

Also add this import at the top of the test file:

```ts
import { resolveCodexCollaborationPolicy } from './codexCollaborationPolicy.js';
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
cd src-tauri\sidecar
npx vitest run src/codexRuntime.test.ts
```

Expected: FAIL because mutation blocking is not wired into `emitItemEvent()`.

- [ ] **Step 3: Add blocking logic to `emitItemEvent()`**

In `src-tauri/sidecar/src/codexRuntime.ts`, at the top of `emitItemEvent()` after the error item branch or before normal tool mapping, add:

```ts
    const collaborationPolicy = this.config?.collaborationPolicy
      ?? resolveCodexCollaborationPolicy({ planMode: this.config?.planMode });
    const blockedMethod = shouldBlockPlanModeItem(item, collaborationPolicy);
    if (blockedMethod) {
      emit(buildPlanMutationBlockedEvent(blockedMethod, item.id ?? null));
      return;
    }
```

Place this before `const toolUse = buildCodexToolUseContent(...)` so blocked commands and file changes never render as normal successful tools.

- [ ] **Step 4: Run runtime tests**

Run:

```powershell
cd src-tauri\sidecar
npx vitest run src/codexRuntime.test.ts src/codexCollaborationPolicy.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri\sidecar\src\codexRuntime.ts src-tauri\sidecar\src\codexRuntime.test.ts
git commit -m "feat(codex): block plan mode mutations"
```

## Task 4: Block Request User Input Tools In Code Mode

**Files:**
- Modify: `src-tauri/sidecar/src/codexCompatProxy.ts`
- Modify: `src-tauri/sidecar/src/codexCompatProxy.test.ts`

- [ ] **Step 1: Add failing proxy test**

In `src-tauri/sidecar/src/codexCompatProxy.test.ts`, add a test near the existing request-user-input proxy tests:

```ts
  it('blocks request_user_input tool calls when strict-local code mode is active', async () => {
    const emittedEvents: unknown[] = [];
    vi.doMock('./codexRuntime.js', () => ({
      activeSessionId: 'session-1',
      emit: (event: unknown) => emittedEvents.push(event),
    }));
    const policy = await import('./codexCollaborationPolicy.js');
    policy.setActiveCodexCollaborationPolicy(policy.resolveCodexCollaborationPolicy({ planMode: 'off' }));

    const proxy = await createCodexCompatProxyServer({
      apiKey: 'test-key',
      baseUrl: upstreamBaseUrl,
      providerName: 'test-provider',
    }, testPort);

    try {
      upstream.enqueueChatStream([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'request_user_input',
                  arguments: JSON.stringify({
                    questions: [{
                      id: 'scope',
                      header: 'Scope',
                      question: 'Which scope?',
                      options: [{ label: 'A', description: 'Use A' }],
                    }],
                  }),
                },
              }],
            },
          }],
        },
        { choices: [{ finish_reason: 'tool_calls', delta: {} }] },
      ]);
      upstream.enqueueChatStream([
        { choices: [{ delta: { content: 'Continuing without user input.' } }] },
        { choices: [{ finish_reason: 'stop', delta: {} }] },
      ]);

      const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'test-model',
          stream: true,
          input: 'hello',
          tools: [{
            type: 'function',
            name: 'request_user_input',
            description: 'Ask the user',
            parameters: { type: 'object', properties: {} },
          }],
        }),
      });

      expect(response.status).toBe(200);
      expect(emittedEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'sidecar_stream_status',
            mode_blocked: expect.objectContaining({
              effective_mode: 'code',
              reason_code: 'request_user_input_blocked_in_default_mode',
            }),
          }),
        ]),
      );
      expect(emittedEvents).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'ask_user_question' }),
        ]),
      );
    } finally {
      await proxy.close();
    }
  });
```

If this file uses a different upstream helper name than `upstream`, adapt only the setup variables to match the surrounding tests; keep the assertions unchanged.

- [ ] **Step 2: Run proxy test to verify failure**

Run:

```powershell
cd src-tauri\sidecar
npx vitest run src/codexCompatProxy.test.ts -t "blocks request_user_input"
```

Expected: FAIL because the proxy still emits `ask_user_question` in code mode.

- [ ] **Step 3: Wire policy into `handleInteractiveUserInputToolCalls()`**

In `src-tauri/sidecar/src/codexCompatProxy.ts`, add imports:

```ts
import {
  buildRequestUserInputBlockedEvent,
  getActiveCodexCollaborationPolicy,
} from './codexCollaborationPolicy.js';
```

In `handleInteractiveUserInputToolCalls()`, before emitting `ask_user_question`, add:

```ts
    const activePolicy = getActiveCodexCollaborationPolicy();
    if (activePolicy.requestUserInputPolicy === 'block') {
      emitEvent(buildRequestUserInputBlockedEvent(toolCall.id || null));
      responses.push({
        answers: {},
        blocked: true,
        reason_code: 'request_user_input_blocked_in_default_mode',
      });
      emitEvent(buildToolResultEvent({
        sessionId: activeSessionId,
        toolUseId: toolCall.id,
        content: stringifyInteractiveToolResponse(responses[responses.length - 1]),
        isError: true,
      }));
      continue;
    }
```

Keep the existing question parsing and `waitForInteractiveToolResponse()` flow inside the non-blocked branch.

- [ ] **Step 4: Run proxy tests**

Run:

```powershell
cd src-tauri\sidecar
npx vitest run src/codexCompatProxy.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri\sidecar\src\codexCompatProxy.ts src-tauri\sidecar\src\codexCompatProxy.test.ts
git commit -m "feat(codex): block user input tools in code mode"
```

## Task 5: Frontend Diagnostic Compatibility Check

**Files:**
- Inspect: `src/stores/agentEventParsing.ts`
- Inspect: `src/components/agent/AgentMessageList.tsx`
- Modify only if needed: nearest existing parser/display file for `sidecar_stream_status`

- [ ] **Step 1: Run current parsing tests**

Run:

```powershell
npx vitest run src/stores/agentEventParsing.test.ts src/components/agent/AgentPanel.test.ts
```

Expected: PASS before frontend changes.

- [ ] **Step 2: Inspect event parser behavior**

Search:

```powershell
rg -n "sidecar_stream_status|mode_blocked|stream_status" src
```

If `sidecar_stream_status` already renders as a visible status/diagnostic, do not change frontend code.

- [ ] **Step 3: Add minimal parser support only if missing**

If the search shows `sidecar_stream_status` is ignored, update `src/stores/agentEventParsing.ts` so events with `type === "sidecar_stream_status"` become an agent status message. The shape should preserve `event.message` and optional `event.mode_blocked`.

Use this mapping:

```ts
if (event.type === 'sidecar_stream_status') {
  return {
    kind: 'system',
    id: crypto.randomUUID(),
    content: typeof event.message === 'string' ? event.message : 'Codex stream status update',
    metadata: {
      modeBlocked: event.mode_blocked ?? null,
    },
  };
}
```

Adapt field names to the existing parser return type. Do not introduce a new UI component if a system/status message already exists.

- [ ] **Step 4: Add or update parser test only if frontend code changed**

Add a test case in `src/stores/agentEventParsing.test.ts`:

```ts
it('preserves Codex mode-blocked stream diagnostics', () => {
  const parsed = parseAgentEvent({
    type: 'sidecar_stream_status',
    message: 'Codex collaboration mode blocked item/tool/requestUserInput',
    is_reconnecting: false,
    mode_blocked: {
      blocked_method: 'item/tool/requestUserInput',
      effective_mode: 'code',
      reason_code: 'request_user_input_blocked_in_default_mode',
      reason: 'requestUserInput is blocked while effective_mode=code',
      suggestion: 'Switch to Plan mode and resend the prompt when user input is needed.',
      request_id: 'tool-1',
    },
  });

  expect(JSON.stringify(parsed)).toContain('request_user_input_blocked_in_default_mode');
});
```

Adapt `parseAgentEvent` to the actual exported parser name.

- [ ] **Step 5: Run frontend tests**

Run:

```powershell
npx vitest run src/stores/agentEventParsing.test.ts src/components/agent/AgentPanel.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit if frontend changed**

If no frontend file changed, skip this commit. If frontend changed:

```powershell
git add src\stores\agentEventParsing.ts src\stores\agentEventParsing.test.ts
git commit -m "fix(ui): show codex mode blocked diagnostics"
```

## Task 6: Final Verification And Build

**Files:**
- No planned source edits.

- [ ] **Step 1: Run focused sidecar tests**

Run:

```powershell
cd src-tauri\sidecar
npx vitest run src/codexCollaborationPolicy.test.ts src/codexRuntime.test.ts src/codexCompatProxy.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run sidecar TypeScript build**

Run:

```powershell
cd src-tauri\sidecar
npm run build
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Run root frontend tests touched by plan mode**

Run:

```powershell
npx vitest run src/lib/agentPermissions.test.ts src/components/agent/AgentPermissionSelector.test.tsx src/stores/agentEventParsing.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run root build if time allows**

Run:

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 5: Inspect final diff**

Run:

```powershell
git status --short
git diff --stat HEAD
```

Expected: only Codex strict-local plan-mode files are changed.

- [ ] **Step 6: Final commit**

If any verification-only fixes were needed after the earlier commits:

```powershell
git add src-tauri\sidecar\src src\stores
git commit -m "test(codex): verify strict local plan mode"
```

If there are no remaining changes, do not create an empty commit.

## Self-Review

- Spec coverage:
  - Policy module covers strict-local mode resolution and directives.
  - Runtime injection replaces `$plan` as the primary mechanism.
  - Runtime event blocking covers plan-mode file and repo mutation attempts.
  - Proxy blocking covers code-mode `request_user_input` and `askUserQuestion`.
  - Existing permission selector remains unchanged.
  - Verification tasks cover sidecar and focused frontend tests.
- Placeholder scan: no open placeholders remain in the task steps.
- Type consistency:
  - Policy uses `selectedMode`, `effectiveMode`, `requestUserInputPolicy`, and `fallbackReason`.
  - Emitted diagnostic uses existing `sidecar_stream_status` plus a `mode_blocked` payload.
  - Runtime config stores `collaborationPolicy?: CodexCollaborationPolicy`.
