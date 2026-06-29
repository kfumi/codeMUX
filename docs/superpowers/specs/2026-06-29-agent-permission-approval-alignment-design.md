# Agent Permission Approval Alignment Design

## Context

codeMUX already has a first-pass permission system for Claude Code and Codex:

- Frontend permission presets live in `src/lib/agentPermissions.ts` and `src/components/agent/AgentPermissionSelector.tsx`.
- Session-level `permission_config` and `plan_mode` are persisted in SQLite and injected into sidecar `ensure_session` commands by `src-tauri/src/agent/commands.rs`.
- Claude Code uses the Anthropic SDK `permissionMode`, `allowDangerouslySkipPermissions`, and a `canUseTool` hook that currently emits `ask_user_question` events for approvals.
- Codex uses the Codex SDK `sandboxMode`, `approvalPolicy`, and `networkAccessEnabled` in `src-tauri/sidecar/src/codexRuntime.ts`.

The reference guide in `docs/ai-agent-permission-approval-guide.md` describes a fuller production design with synthetic approval requests, batch approval, remember rules, `modeBlocked` diagnostics, and history cleanup. For this phase, the chosen scope is medium alignment: keep the current sidecar architecture, improve the permission policy semantics, and reuse the existing interactive card/tool-response channel for approvals.

## Goals

1. Align permission presets with the guide's core safety principle: changes should be confirmed before execution unless the user selected full access.
2. Make Codex plan mode enforce read-only execution even if the stored Codex permission config allows writes or full access.
3. Keep Claude approvals routed through the existing SDK `canUseTool` hook, but make them clearer and more structured in the UI.
4. Audit Codex SDK event types for approval-like events and document the result in code comments or tests. If the installed SDK exposes an interactive approval event, map it into the same approval response flow.
5. Fix mojibake in permission and approval UI copy touched by this feature.
6. Add focused tests for frontend permission mapping, sidecar permission mapping, and approval UI behavior.

## Non-Goals

- Do not implement the full synthetic approval/resume marker flow from the guide.
- Do not add batch approval, Always Allow command memory, or history denoising in this phase.
- Do not introduce the guide's separate Rust app-server enforcement layer in this phase.
- Do not redesign the chat UI outside the approval card and permission selector copy.

## Recommended Approach

Use an adapter layer on top of the existing sidecar runtimes.

For Claude Code, continue relying on SDK-native `canUseTool` decisions. The hook emits a structured `ask_user_question` event with approval metadata embedded in the question payload. The existing frontend card remains the interaction surface, and `tool_response` returns the user's allow/deny answer.

For Codex, make the SDK thread options authoritative:

- Default/request approval: `workspace-write` + `on-request`, network off.
- Auto edit: `workspace-write` + `on-request`, network off for this phase, because the guide emphasizes confirmation before change.
- Full access: `danger-full-access` + `never`, network on.
- Plan mode: always `read-only` + `on-request`, network off, regardless of stored config.

If Codex emits interactive approval request events, map them into the same `ask_user_question` event family and wait for `tool_response`. If the installed SDK does not expose such an event, the implementation must still lock down options and emit clear diagnostics for blocked or failed approval-related SDK events.

## Data Flow

1. User selects a permission preset in `AgentPermissionSelector`.
2. The selection is persisted on the session by `update_session_permissions`.
3. `ensure_agent_session` reads `permission_config` and `plan_mode` from SQLite and sends them to the sidecar.
4. The sidecar resolves effective permission options:
   - `buildClaudePermissionOptions(config, planMode)`
   - `buildCodexThreadPermissionOptions(config, planMode)`
5. Runtime starts with effective SDK settings.
6. For Claude tool approvals, `canUseTool` emits `ask_user_question` with approval options.
7. Frontend renders the approval card and sends the selected response with `send_tool_response`.
8. Sidecar allows or denies the tool and the SDK continues.

## Component Changes

### `src/lib/agentPermissions.ts`

- Keep the public types stable.
- Update Codex `auto_edit` mapping to preserve confirmation-before-change semantics for medium alignment.
- Make `resolveEffectivePermissionConfig('codex', ..., 'on')` return an effective read-only/on-request config for UI and tests.

### `src-tauri/sidecar/src/agentPermissions.ts`

- Make `buildCodexThreadPermissionOptions(config, 'on')` return:
  - `sandboxMode: 'read-only'`
  - `approvalPolicy: 'on-request'`
  - `networkAccessEnabled: false`
- Keep full access dangerous only when plan mode is off.
- Add a small helper to describe effective permission mode for status logging and tests.

### `src/components/agent/AgentPermissionSelector.tsx`

- Replace mojibake labels and descriptions with clear Chinese copy.
- For Codex plan mode, show a read-only/plan indicator rather than implying full access is active.
- Keep the selector compact and reuse current button/menu behavior.

### `src-tauri/sidecar/src/index.ts`

- Update Claude approval prompts with readable Chinese text.
- Classify common tool approvals:
  - File tools: Write/Edit/MultiEdit/NotebookEdit show file path and action.
  - Bash shows the command.
  - Other tools show the tool name.
- Preserve `AskUserQuestion` behavior for real model questions.

### `src/stores/agentStore.ts` and approval card rendering

- Prefer minimal changes. If the current `AskUserQuestionCard` can display the approval metadata cleanly, only update copy and parsing.
- If metadata is needed, extend the existing `ask_user_question` event shape with optional fields, while keeping backward compatibility.

### `src-tauri/sidecar/src/codexRuntime.ts`

- Audit SDK `ThreadEvent` handling for approval-like item types or event names.
- If present, map them to `ask_user_question` and resolve via the existing interactive response registry.
- If not present, keep handling through SDK policy options and ensure blocked/failure states are shown as structured errors or status events.
- Record the SDK event-shape finding in a focused test or a short comment near the event switch, so future upgrades know whether interactive Codex approvals are supported.

## Error Handling

- Invalid stored permission configs continue to fall back to safe defaults.
- Plan mode always wins over unsafe Codex settings.
- If a user denies a Claude approval, return SDK `deny` with a readable denial message.
- If Codex emits an approval event that cannot be correlated to a response id, emit a sidecar error with enough context to debug, but do not auto-allow.

## Testing

Add or update tests:

- `src/lib/agentPermissions.test.ts`
  - Codex plan mode resolves to read-only/on-request.
  - Codex auto edit follows the selected medium-alignment policy.
- `src-tauri/sidecar/src/agentPermissions.test.ts`
  - Codex plan mode overrides danger-full-access.
  - Claude plan mode still overrides bypass permissions.
- `src/components/agent/AgentPermissionSelector.test.tsx`
  - Chinese labels render correctly.
  - Codex plan mode does not present misleading full-access active state.
- Sidecar runtime tests for Codex approval event mapping if the SDK exposes an event shape; otherwise, a test or assertion covering the diagnostic fallback.

## Rollout Notes

This phase intentionally keeps the existing session schema and sidecar command format. Existing sessions continue to work because malformed or missing configs fall back to safe defaults. The main visible behavior change is that Codex plan mode becomes truly read-only, and Codex auto edit no longer silently implies no approval.
