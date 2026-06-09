# assistant-ui Runtime Adapter Migration Design

Date: 2026-06-08
Status: Approved for design, pending implementation plan

## Summary

Migrate the main AI conversation experience to assistant-ui using the ExternalStoreRuntime approach. The existing CodeMUX agent store, Tauri SSE bridge, Claude Agent SDK sidecar, session persistence, provider settings, preview panel, todo tracking, and changed-file summaries remain the source of truth. assistant-ui becomes the conversation runtime/view adapter and component framework for the thread and composer.

This is a gradual UI + runtime adaptation, not a backend protocol rewrite.

## Goals

- Replace the current chat transcript and composer shell with assistant-ui primitives/components.
- Adapt existing `agentStore.events[sessionId]` into assistant-ui-compatible thread messages.
- Keep current sending, streaming, interrupt, persistence, slash command, and provider selection behavior intact.
- Preserve project-specific renderers for tool calls, thinking blocks, terminal output, diffs, todo updates, and changed files.
- Keep the old `AgentMessageList` and `AgentInput` available during the first migration phase for rollback and comparison.

## Non-Goals

- Do not change the Rust/Tauri backend protocol in the first phase.
- Do not change database schema or persisted message format in the first phase.
- Do not replace provider configuration or Claude Agent SDK sidecar behavior.
- Do not enable branching, editing, regenerate, or assistant-ui cloud persistence in the first phase.
- Do not force every CodeMUX-specific event into a generic text message.

## Recommended Approach

Use assistant-ui's `ExternalStoreRuntime` because CodeMUX already owns chat state through Zustand and persistent session/event storage. The runtime adapter should expose assistant-ui messages and callbacks while delegating real behavior back to the existing store and APIs.

High-level flow:

1. Existing Tauri/SSE events continue to populate `agentStore.events[sessionId]`.
2. A new adapter converts those events into assistant-ui `ThreadMessageLike` values.
3. `useExternalStoreRuntime` receives converted messages and callbacks.
4. `AssistantRuntimeProvider` wraps the new thread UI.
5. assistant-ui primitives render the transcript and composer.
6. Sending a new message calls the existing `startQuery` path.
7. Stopping generation calls the existing `interrupt(sessionId)` path.

## Proposed File Structure

```text
src/components/agent/assistant-ui/
  CodeMuxAssistantRuntime.tsx
  CodeMuxThread.tsx
  CodeMuxComposer.tsx
  CodeMuxMessage.tsx
  CodeMuxMessageParts.tsx
  CodeMuxToolFallback.tsx
  convertAgentEvents.ts
```

The exact names can change during implementation, but the migration should keep the adapter and rendering code isolated from the existing components.

## Runtime Adapter Design

Create a hook similar to `useCodeMuxAssistantRuntime(sessionId, options)`.

Responsibilities:

- Read `events` from `useAgentStore((s) => s.events[sessionId])`.
- Read `running` from `useAgentStore((s) => s.isRunning[sessionId])`.
- Convert CodeMUX event records to assistant-ui messages.
- Provide `onNew` to submit user messages through the existing `handleSend/startQuery` flow.
- Provide stop behavior by calling `interrupt(sessionId)` where assistant-ui supports cancellation controls.
- Avoid writing duplicate assistant-ui state back into the store unless needed for a specific supported callback.

The adapter should initially expose only the capabilities CodeMUX can safely support. Optional assistant-ui capabilities such as message editing, branching, or regeneration should remain disabled until the persisted event model supports them.

## Message Conversion Design

The conversion layer should be deterministic and loss-aware:

- User input events become user messages with text parts.
- Assistant text events become assistant messages with text/markdown parts.
- Streaming assistant chunks should merge into the active assistant message rather than creating one message per chunk.
- Thinking/reasoning events become reasoning parts or grouped custom parts.
- Tool calls become tool-call parts with stable tool call IDs when available.
- Tool results attach to matching tool-call parts when a parent/tool ID is available.
- Terminal, diff, file-change, todo, and ask-user-question events should retain their current specialized UI through custom renderers or assistant-ui tool fallback renderers.
- Unknown event shapes should render through a safe fallback rather than being dropped.

The first implementation should prioritize preserving visible behavior over enabling every assistant-ui feature.

## Component Migration Design

`AgentPanel` should stay responsible for the broader workspace UI:

- Session title and rename dialog.
- Provider/project selection behavior.
- Preview panel toggle.
- Context usage progress.
- Todo list and changed files side sections.
- Empty/missing provider/project states.

The assistant-ui subtree should replace only the central conversation region:

- Transcript viewport.
- Message rows.
- Assistant/user action affordances supported by the runtime.
- Composer textarea/input.
- Send/stop button state.

Existing renderers should be reused where they preserve CodeMUX-specific behavior:

- `MarkdownRenderer`
- `ToolCallCard`
- `ThinkingBlock`
- `TerminalBlock`
- `DiffBlock`
- `AskUserQuestionCard`

## Slash Command Handling

The current `AgentInput` owns slash command UX. During migration there are two viable implementation details:

1. Keep the slash command menu as a CodeMUX-specific composer extension around assistant-ui's composer primitives.
2. Temporarily wrap/reuse the existing slash command logic while moving the transcript first.

The preferred first-phase path is to preserve current slash command behavior even if the composer is not fully idiomatic assistant-ui on day one. After stability, slash commands can be reworked as assistant-ui mentions or composer attachments if that improves UX.

## Styling Direction

Use assistant-ui/Radix-compatible structure while preserving CodeMUX's current dark developer-tool aesthetic:

- Keep Tailwind as the styling system.
- Use existing shadcn/Radix-style UI conventions where possible.
- Preserve compact density suitable for coding-agent output.
- Ensure code blocks, terminal output, diffs, and tool cards remain readable in long sessions.
- Avoid a generic ChatGPT clone look; the UI should still feel like CodeMUX.

## Migration Phases

### Phase 1: Adapter Foundation

- Install assistant-ui dependencies.
- Add isolated adapter and conversion utilities.
- Render converted historical messages in a development-only or side-by-side path.
- Confirm no changes to persisted event data are required.

### Phase 2: Thread Replacement

- Build the assistant-ui thread component.
- Reuse existing message part renderers through custom message/tool renderers.
- Replace `AgentMessageList` in `AgentPanel` once historical and streaming messages render correctly.

### Phase 3: Composer Replacement

- Integrate assistant-ui composer primitives.
- Preserve existing send flow, disabled states, cwd/project behavior, and provider validation.
- Preserve slash command menu behavior.
- Wire stop/cancel behavior to existing `interrupt`.

### Phase 4: Feature Hardening

- Validate streaming, stop generation, tool calls, tool results, terminal output, diffs, thinking blocks, ask-user prompts, empty sessions, and historical sessions.
- Keep unsupported assistant-ui features disabled.
- Remove or archive old UI components only after parity is confirmed.

## Validation Plan

Manual validation should cover:

- Starting a new session and sending a prompt.
- Loading an existing session with historical messages.
- Streaming assistant output without duplicate message rows.
- Stopping an active response.
- Rendering tool calls and tool results.
- Rendering thinking/reasoning sections.
- Rendering terminal and diff blocks.
- Rendering todo and changed-file summaries.
- Using slash commands.
- Handling missing provider configuration.
- Switching sessions and projects.

Automated validation, if practical, should focus on pure conversion utilities first because they can be tested without Tauri or network state.

## Risks and Mitigations

- Risk: assistant-ui message conversion drops uncommon event shapes.
  - Mitigation: add a fallback renderer and conversion fixtures for representative events.

- Risk: streaming creates duplicate or fragmented messages.
  - Mitigation: group chunks by stable message/tool IDs and test active-stream conversion separately.

- Risk: composer migration regresses slash commands.
  - Mitigation: preserve current slash command code in phase 1 and migrate it later only after parity.

- Risk: assistant-ui optional capabilities appear enabled but are unsupported by CodeMUX persistence.
  - Mitigation: only provide callbacks for capabilities that are truly supported.

- Risk: styling drifts into a generic assistant clone.
  - Mitigation: reuse CodeMUX-specific renderers and keep compact coding-agent visual density.

## Documentation Sources

- https://www.assistant-ui.com/llms.txt
- https://www.assistant-ui.com/docs/runtimes/custom/overview.mdx
- https://www.assistant-ui.com/docs/runtimes/custom/external-store.mdx
- https://www.assistant-ui.com/docs/api-reference/primitives/thread.mdx
- https://www.assistant-ui.com/docs/guides/chain-of-thought.mdx

## Open Implementation Decisions

- Exact assistant-ui package set and peer dependency versions.
- Whether the first implementation should use prebuilt assistant-ui components or mostly primitives.
- Whether slash commands should remain a custom menu or become assistant-ui mentions in a later phase.
- Whether conversion utilities should receive dedicated unit tests in the current test setup or start as manually validated pure functions.
