# Multi-Agent Runtime and Codex Integration Design

Date: 2026-06-10
Status: Approved for design, pending implementation plan

## Summary

Upgrade CodeMUX from a Claude-centered coding assistant app into a multi-agent coding platform with a shared session model, shared UI shell, and pluggable runtime adapters. The first new agent to integrate is `Codex`, using the Codex SDK. `Claude Code` remains the default agent for new conversations.

This design separates:

- `Agent identity`: which coding tool/runtime powers the session
- `Provider/model configuration`: which backend/model the agent uses
- `Shared UI/runtime contracts`: what the frontend and Tauri command layer expect from any agent

The product behavior for the first release is:

- New conversations default to `Claude Code`
- Agent choice happens when creating a new conversation
- A conversation is permanently bound to one agent after creation
- The new-conversation entry uses the input-adjacent selector pattern (`visual option A`)
- Codex ships in phases: first the main conversation path, then parity work

## Goals

- Add `Codex` as a first-class coding agent via the Codex SDK.
- Redesign the runtime architecture so Claude Code, Codex, and future agents can coexist cleanly.
- Persist the selected agent per session.
- Keep the existing shared conversation UI where possible.
- Preserve the current Claude behavior while wrapping it in the new abstraction.
- Support phased capability rollout so not every agent must ship with identical features on day one.

## Non-Goals

- Do not allow switching the bound agent inside an existing session.
- Do not fully rewrite the current Claude implementation before Codex is integrated.
- Do not build a fully dynamic external plugin system for agents in this phase.
- Do not require every agent to support the full Claude event/cost/MCP feature set in phase 1.
- Do not reintroduce a separate generic chat mode.

## Product Decisions

- Default agent for a new conversation: `claude_code`
- Agent selection granularity: `new session only`
- New-conversation selector UI: `input-adjacent selector` (visual option A)
- Codex rollout strategy: `phased`
- Configuration strategy: `hybrid`
  - Shared provider/model config remains centralized
  - Each agent can also define agent-specific runtime config

## Recommended Architecture

Use a shared multi-agent runtime model with adapters.

High-level layers:

1. `Agent Registry`
   - Canonical list of supported agents and their metadata
2. `Session Model`
   - Stores the agent bound to each conversation
3. `Runtime Factory`
   - Resolves the session agent into a concrete runtime adapter
4. `Runtime Adapter`
   - Claude Code adapter, Codex adapter, future Gemini/OpenCode adapters
5. `Unified Event Model`
   - Shared event stream consumed by the existing frontend conversation shell

This keeps Codex from becoming a second hard-coded branch and avoids scattering agent-specific conditionals across `AgentPanel`, stores, Tauri commands, and sidecars.

## Data Model Changes

### Session

Add `agent_kind` to the session model.

Example values:

- `claude_code`
- `codex`
- `gemini_cli`
- `opencode`

Existing fields remain:

- `provider_id`
- `model`
- `mode`
- `project_id`

Meaning after the redesign:

- `agent_kind` answers: which coding runtime owns this session?
- `provider_id` and `model` answer: which provider/model config does this session use?

`provider_id` must no longer be treated as the identity of the runtime itself.

### Provider

Keep `Provider` focused on shared backend/model configuration.

Current/expected fields include:

- `id`
- `name`
- `api_key`
- `anthropic_base_url`
- `openai_base_url`
- `default_model`
- pricing metadata
- context metadata

This layer remains shared across agents where appropriate.

### Agent Config

Add a new config section keyed by agent kind for runtime-specific configuration.

Examples:

- `claude_code`
  - executable resolution policy
  - resume/session recovery behavior
  - MCP compatibility toggles
- `codex`
  - Codex SDK runtime mode
  - provider/model mapping strategy
  - capability toggles or runtime compatibility settings
- future agents
  - their own runtime-specific options

### Agent Defaults

Add product-level defaults separate from session state:

- `default_agent_kind`
- optional per-agent default provider strategy
- optional UI defaults for new session creation

## App Config Shape

Recommended shape:

```ts
type AppConfig = {
  providers: Provider[];
  agent_configs: Record<AgentKind, AgentConfig>;
  agent_defaults: {
    default_agent_kind: AgentKind;
  };
  active_provider_id: string | null;
  theme: Theme;
};
```

The exact schema can be adjusted to match the current Rust/TypeScript config layout, but the separation of responsibilities should remain.

## Agent Registry

Define a shared registry in frontend and backend-friendly shapes.

Each entry should include:

- `kind`
- `label`
- `icon`
- `description`
- `status`
- `default_provider_strategy`
- `capabilities`

Capabilities should be declarative. Examples:

- `supports_resume`
- `supports_tools`
- `supports_file_snapshots`
- `supports_cost`
- `supports_context_window`
- `supports_mcp`
- `supports_ask_user_question`

The registry should be the source of truth for:

- the new conversation selector menu
- session badges/icons
- runtime factory resolution
- capability-based UI enablement and degradation

## Runtime Abstraction

Introduce a shared runtime service contract. The command names can stay close to current Tauri names, but they should become agent-agnostic at the orchestration layer.

Core operations:

- `ensure_session`
- `start_session`
- `send_input`
- `interrupt`
- `shutdown`
- `reset_session`
- `load_session_events`

Each runtime adapter is responsible for:

1. `bootstrap`
   - Prepare the agent runtime or sidecar
2. `command mapping`
   - Translate shared runtime operations into agent-specific SDK/runtime calls
3. `event normalization`
   - Convert raw agent events to a shared CodeMUX event shape
4. `capability declaration`
   - Declare supported features so the UI can degrade safely

## Runtime Factory

Add a factory/service resolver in Tauri that selects an adapter by `agent_kind`.

Recommended direction:

- `ClaudeCodeAdapter`
- `CodexAdapter`
- future adapters as needed

The factory should sit between Tauri commands and agent-specific runtime code. The UI and stores should not need to know whether a session uses a Claude sidecar or a Codex SDK-backed runtime.

## Claude Migration Strategy

Do not rewrite the current Claude implementation from scratch in phase 1.

Instead:

- keep the existing Claude sidecar/runtime behavior
- wrap it in a `ClaudeCodeAdapter`
- make it conform to the new runtime contract

This minimizes risk while allowing Codex to be added cleanly.

## Codex Integration Strategy

Codex should be added as a peer adapter, not as a special case inside the Claude path.

`CodexAdapter` should be responsible for:

- Codex session bootstrap
- Codex SDK invocation
- mapping Codex events to shared events
- handling interruption/shutdown/reset where supported
- history/recovery behavior in phases

The first implementation should prioritize the main task flow over perfect parity.

## Unified Event Model

Standardize internal runtime events into a shared event schema consumed by the existing conversation UI.

Recommended categories:

- `lifecycle`
  - `ready`
  - `running`
  - `interrupted`
  - `completed`
  - `failed`
- `message`
  - `user`
  - `assistant`
  - `reasoning`
  - `system`
- `tool`
  - `tool_call`
  - `tool_result`
  - `ask_user_question`
- `workspace`
  - `file_snapshot`
  - `diff`
  - `changed_files`
- `usage`
  - `tokens`
  - `cost`
  - `context_window`
  - `runtime_status`

The exact event payloads can evolve, but every adapter should target this internal shape instead of exposing raw SDK events directly to the UI.

## Frontend Interaction Design

### New Conversation Entry

Adopt visual option `A`.

Behavior:

- The empty-state composer shows the currently selected new-session agent on the left side of the input.
- The placeholder text reflects the current choice, for example:
  - `给 Claude Code 发送消息`
  - `给 Codex 发送消息`
- Clicking the agent icon opens a menu with available agents.

### Scope of Selection

- The selector affects only the next session to be created.
- It does not change existing sessions.

### First Send Flow

If the user sends a message from the empty state:

1. Create a new session using the currently selected `agent_kind`
2. Bind the session to the chosen agent
3. Start the selected runtime
4. Send the prompt

### Existing Sessions

- Show the bound agent icon/badge in the session header
- Show a small agent icon in the session list
- Do not expose a direct in-session agent switch control

## Frontend State Design

Split pre-session choice from persisted session state.

### Draft State

Add transient new-session draft state such as:

- `selectedAgentKind`
- optional `selectedProviderId`
- optional `draftProjectId`

This state exists before a session is created.

### Persisted Session State

Persist on session creation:

- `session.id`
- `session.agent_kind`
- `session.provider_id`
- `session.model`

## Component Direction

Recommended additions:

- `AgentSelector`
  - shared selector used by the empty-state composer
- `NewSessionComposer`
  - empty-state entry point that uses `AgentSelector`
- `AgentBadge`
  - reusable session header/list badge
- `SessionCreateController`
  - orchestrates the create-then-send flow

This keeps the selection logic focused and reusable.

## Capability-Based Degradation

The UI must respect declared agent capabilities.

Rules:

- If a capability is unsupported, hide or degrade the related UI path
- Do not expose controls that only fail at runtime

Examples:

- no `supports_cost` -> hide cost display
- no `supports_resume` -> do not imply session recovery behavior
- no `supports_tools` -> do not render tool-oriented affordances
- limited history support -> fall back to text/system history only

This is important for Codex phase 1 and future Gemini/OpenCode adapters.

## Migration Plan

### Database

Add `agent_kind` to `sessions`.

Migration behavior:

- Existing sessions backfill to `claude_code`
- Existing `provider_id` and `model` remain intact
- Existing agent sessions continue to open normally

### Config

Expand config storage to include:

- `agent_configs`
- `agent_defaults`

Provide defaults so existing users are migrated without manual setup.

### Existing Stores and Commands

Update TypeScript and Rust session/config types so `agent_kind` is available everywhere a session is created, loaded, or displayed.

## Phased Delivery

### Phase 1: Core Multi-Agent Foundation

- Add `agent_kind` to session schema and types
- Add agent registry
- Add agent defaults/config structure
- Implement input-adjacent new-session selector
- Update session creation to bind the selected agent
- Wrap current Claude runtime in `ClaudeCodeAdapter`

### Phase 2: Codex Main Path

- Implement `CodexAdapter`
- Create/start/send/interruption support
- Stream Codex results into the shared UI
- Show Codex badges/icons in session header/list

### Phase 3: Capability Hardening

- Standardize advanced events further
- Improve Codex history/recovery behavior
- Add better usage/cost/context integration where supported
- Expand file/diff/tool event mapping

### Phase 4: Additional Agents

- Add Gemini/OpenCode adapters using the same contract

## Error Handling

Group failures into three categories:

- `configuration errors`
  - missing API key
  - invalid provider
  - missing model
- `runtime errors`
  - SDK bootstrap failure
  - stale session
  - interrupt/reset failure
- `capability errors`
  - unsupported feature for this agent

User-visible errors should identify:

- the agent involved
- the stage that failed
- the next recommended action where possible

## Testing Strategy

### Unit Tests

- agent registry resolution
- runtime factory routing
- event normalization per adapter
- session/config migration helpers

### Integration Tests

- create Claude session with default agent
- create Codex session from selector
- first-send auto-create flow
- session header/list agent badges
- interruption and deletion cleanup paths

### UI Validation

- empty-state selector behavior
- placeholder text updates
- menu selection persistence for next session
- no in-session switching affordance

### Regression Validation

- existing Claude sessions still open
- current preview/project/session flows still work
- current slash-command and side-panel behavior do not regress

## Risks and Mitigations

- Risk: new abstraction adds complexity before Codex value is visible
  - Mitigation: keep the abstraction narrow and immediately use it for Claude + Codex

- Risk: Codex raw events do not map neatly to current Claude-oriented UI
  - Mitigation: normalize into shared event categories and degrade unsupported surfaces

- Risk: provider identity and agent identity stay entangled
  - Mitigation: persist `agent_kind` explicitly and keep provider config separate

- Risk: first-send orchestration becomes fragile
  - Mitigation: isolate session creation and runtime start in a dedicated controller/service

- Risk: existing Claude flows regress during the refactor
  - Mitigation: wrap the existing Claude runtime first instead of replacing it

## Final Recommendation

Implement a shared multi-agent runtime architecture with:

- explicit per-session `agent_kind`
- a shared agent registry
- shared provider configuration plus agent-specific runtime config
- adapter-based runtime orchestration
- capability-based UI degradation

Ship Codex in phases, starting with the main conversation path and preserving Claude Code as the default and most complete experience during the transition.
