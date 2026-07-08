# Codex Strict-Local Plan Mode Design

## Context

CodeMUX currently implements Codex plan mode as a lightweight combination of:

- `planMode: "on" | "off"` stored on the app session.
- A `$plan` text prefix added in the sidecar before `Thread.runStreamed()`.
- Codex SDK thread permissions switched to `read-only`, `on-request`, and `network-off` while plan mode is on, matching desktop-cc-gui strict-local.

`desktop-cc-gui` uses a stronger collaboration-mode model. It treats plan mode as a runtime policy with normalized `code` and `plan` modes, injected developer instructions, request-user-input rules, thread-scoped state, and strict-local enforcement. This design adapts that behavior to CodeMUX's current React + Tauri + TypeScript sidecar architecture without switching away from the OpenAI Codex SDK.

## Goals

- Make Codex plan mode a strict runtime policy rather than a prompt prefix.
- Align CodeMUX with the `desktop-cc-gui` strict-local behavior for Codex:
  - `code` mode blocks follow-up question tools.
  - `plan` mode blocks repository-mutating work.
  - `plan` mode requires structured user-input requests for blockers.
- Preserve the existing UI entry point and session persistence model.
- Keep the change scoped to the Codex runtime path.
- Add focused tests that lock down policy resolution, sidecar event behavior, and non-Codex isolation.

## Non-Goals

- Do not replace the Codex SDK runtime with the `desktop-cc-gui` app-server protocol.
- Do not redesign the permission selector UI in this phase.
- Do not change Claude Code permission behavior.
- Do not implement desktop-cc-gui follower channels or multi-window runtime synchronization.
- Do not add a new frontend settings panel unless needed by implementation tests.

## Current Implementation Summary

Current CodeMUX touchpoints:

- Frontend permission mapping lives in `src/lib/agentPermissions.ts`.
- The session-level plan flag is displayed and changed through `src/components/agent/AgentPermissionSelector.tsx`.
- `src/components/agent/AgentPanel.tsx` passes `planMode` to the sidecar in `ensure_session`.
- Sidecar permissions are resolved in `src-tauri/sidecar/src/agentPermissions.ts`.
- Codex input is prefixed by `applyCodexPlanPrefix()` in `src-tauri/sidecar/src/codexRuntime.ts`.
- Chat-completions proxy request-user-input handling lives in `src-tauri/sidecar/src/codexCompatProxy.ts` and uses `interactiveToolResponses.ts`.
- The existing frontend card for structured questions is `src/components/agent/AskUserQuestionCard.tsx`.

## desktop-cc-gui Behavior To Adapt

The relevant `desktop-cc-gui` design has these parts:

- Normalize incoming mode values to `code` or `plan`; map `default` to `code`.
- Resolve a `CodexCollaborationPolicy` with selected mode, effective mode, profile, fallback reason, policy version, user-input policy, and directives.
- Use a strict-local profile:
  - In `code` mode, `requestUserInput` is blocked and converted to `collaboration/modeBlocked`.
  - In `plan` mode, repo-mutating operations are blocked and surfaced as `collaboration/modeBlocked`.
  - In `plan` mode, blockers and missing input must use structured user-input tools rather than plain assistant questions.
- Inject runtime policy into developer instructions instead of depending on a user-visible prompt prefix.
- Keep mode state thread-scoped to avoid drift between UI selection and runtime behavior.

## Proposed Architecture

### 1. Sidecar Collaboration Policy Module

Add `src-tauri/sidecar/src/codexCollaborationPolicy.ts`.

It will export:

- `CodexCollaborationMode = "code" | "plan"`.
- `CodexCollaborationProfile = "strict-local"`.
- `CodexRequestUserInputPolicy = "allow" | "block"`.
- `resolveCodexCollaborationPolicy(input)`.
- `buildCodexCollaborationDirectives(policy)`.
- `applyCodexCollaborationPolicyToInput(payload, policy)`.
- `isCodexModeBlockedEventCandidate(itemOrToolCall, policy)`.

Policy resolution rules:

- `planMode === "on"` resolves to `plan`.
- `planMode === "off"` or missing resolves to `code`.
- Any future explicit `collaborationMode` value of `default` resolves to `code`.
- Invalid values fall back to the previous session mode if available; otherwise `code`.

The policy object will include a version string such as `codemux-codex-collaboration-policy/v1` so emitted diagnostics can be traced.

### 2. Replace `$plan` As The Primary Mechanism

`CodexSessionRuntime.runInput()` will build a policy before creating the Codex SDK input.

For `plan`, the sidecar will prepend policy directives to the input as a developer/system-style instruction block supported by the SDK input format. If the SDK input entry format cannot carry developer instructions directly, the sidecar will prepend a clearly delimited policy block to the first text entry as a fallback.

The existing `$plan` prefix will no longer be the canonical plan-mode mechanism. Tests should assert the policy block/directives rather than `$plan`. A compatibility helper may remain only to avoid breaking users who manually type `$plan`.

### 3. Strict-Local Request User Input Enforcement

The chat-compat proxy already intercepts `request_user_input`, `askUserQuestion`, and `AskUserQuestion` tool calls.

Add strict-local enforcement there:

- In `code` mode, interactive question tool calls are blocked.
- The proxy emits a structured `mode_blocked` or `sidecar_stream_status` event carrying:
  - blocked method/tool name
  - effective mode
  - reason code `request_user_input_blocked_in_default_mode`
  - suggestion to switch to Plan mode
- The tool call is answered with an empty/cancelled result so the upstream continuation can settle instead of hanging.

In `plan` mode, the same interactive tools are allowed and continue through the current `ask_user_question` UI.

### 4. Strict-Local Plan Mutation Enforcement

Codex SDK event handling will check plan-mode items before rendering them as normal tool activity.

Blocked in `plan` mode:

- `file_change` items.
- `command_execution` items whose command is repo-mutating, especially `git add`, `git commit`, `git push`, `git pull`, `git merge`, `git rebase`, `git reset`, `git clean`, `git checkout`, `git switch`, `git restore`, `git apply`, `git rm`, `git mv`, and similar write actions.
- Tool names or item types that clearly represent `apply_patch` or file mutation.

When blocked, the runtime will emit a diagnostic event and avoid presenting the action as successful. If the SDK sandbox already denies the operation, the sidecar will translate that denial into the same user-facing mode-blocked shape.

The thread options will continue to enforce `read-only`, `on-request`, and `network-off` in plan mode as a second line of defense.

### 5. Frontend State Mapping

Keep the current permission selector unchanged for this phase:

- "计划模式" maps to `planMode: "on"` and runtime mode `plan`.
- "完全访问" maps to `planMode: "off"` and runtime mode `code`.

Frontend event parsing will recognize the new mode-blocked diagnostic shape and render it through the existing tool/status surfaces. If the current event parser can already show `sidecar_stream_status`, no new component is required.

### 6. Request User Input UI

Reuse `AskUserQuestionCard`.

Plan mode behavior:

- `request_user_input` and `askUserQuestion` show the existing question card.
- Submit sends the selected answers through `agentApi.sendToolResponse`.
- Cancel sends cancellation markers and lets the runtime settle.

Code mode behavior:

- The question card should not appear for blocked request-user-input calls.
- A compact diagnostic should explain that structured user input is blocked in code mode and that the user can switch to plan mode.

### 7. Testing Strategy

Add or update sidecar tests:

- Policy resolves `on` to `plan` and `off` to `code`.
- Plan mode injects strict-local directives.
- Code mode injects code-mode directives and blocks request-user-input.
- Plan mode allows request-user-input through the existing question flow.
- Plan mode blocks repo-mutating `command_execution`.
- Plan mode blocks `file_change`.
- Existing Codex permission options still resolve to `read-only` in plan mode.
- Existing non-plan Codex behavior remains unchanged except for the code-mode no-question rule.

Add frontend tests only if event parsing/rendering needs changes.

## Data Flow

1. User selects Codex plan mode in the existing permission selector.
2. Frontend persists `planMode: "on"` on the session.
3. `AgentPanel` sends `planMode` in `ensure_session`.
4. Sidecar resolves strict-local policy during `ensure()`.
5. Sidecar configures SDK thread permissions from the effective mode.
6. On each turn, sidecar injects collaboration directives into the SDK input.
7. SDK stream events pass through strict-local enforcement:
   - allowed events render normally;
   - blocked events emit mode-blocked diagnostics;
   - allowed plan-mode user-input tools use the current interactive question path.

## Error Handling

- Invalid mode values fall back to `code` and include a fallback reason in diagnostics.
- If a blocked interactive tool cannot be auto-settled, emit `sidecar_error` with the blocked tool ID.
- If a plan-mode mutation is detected after the SDK has already rejected it, prefer a mode-blocked diagnostic over a raw low-level sandbox error when possible.
- If policy injection cannot use structured SDK developer instructions, use the text fallback and log the fallback path in stderr for diagnostics.

## Rollout

This change is Codex-only. It is acceptable for strict-local to be the default because the user explicitly selected that behavior. If implementation reveals a Codex SDK limitation that makes hard blocking unreliable, the fallback is to:

- keep read-only SDK permissions;
- keep strict directives;
- emit mode-blocked diagnostics for detected attempts;
- document the SDK limitation in tests and comments.

## Acceptance Criteria

- Codex plan mode no longer depends on `$plan` as its primary behavior.
- In Codex code mode, model attempts to call `request_user_input` or `askUserQuestion` are blocked and surfaced as mode-blocked diagnostics.
- In Codex plan mode, request-user-input tools are allowed and use the existing question card.
- In Codex plan mode, file mutations and repo-mutating commands are blocked or translated into mode-blocked diagnostics.
- Claude Code behavior is unchanged.
- Relevant Vitest coverage passes for sidecar policy and Codex runtime behavior.
