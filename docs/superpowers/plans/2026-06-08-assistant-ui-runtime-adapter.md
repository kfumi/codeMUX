# assistant-ui Runtime Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CodeMUX's central AI conversation transcript and composer with assistant-ui using `ExternalStoreRuntime`, while preserving existing Zustand/Tauri/SSE agent behavior.

**Architecture:** CodeMUX remains the owner of persisted agent events in `useAgentStore`. A new adapter layer converts `AgentMessage[]` into assistant-ui thread messages, and assistant-ui primitives render the transcript/composer. Existing CodeMUX renderers remain available for markdown, thinking, tool calls, terminal output, diffs, and question cards.

**Tech Stack:** React 18, TypeScript, Zustand, Tauri v2, Tailwind CSS, Radix-style components, `@assistant-ui/react@0.14.14`.

---

## File Structure

- Modify: `package.json` — add `@assistant-ui/react` dependency.
- Modify: `package-lock.json` — lock dependency after install.
- Create: `src/components/agent/assistant-ui/convertAgentEvents.ts` — pure conversion from CodeMUX `AgentMessage[]` to assistant-ui thread-message-like records.
- Create: `src/components/agent/assistant-ui/CodeMuxAssistantRuntime.tsx` — hook/provider bridge around `useExternalStoreRuntime`.
- Create: `src/components/agent/assistant-ui/CodeMuxMessageParts.tsx` — custom rendering for text, reasoning, tool, terminal, diff, and fallback parts.
- Create: `src/components/agent/assistant-ui/CodeMuxThread.tsx` — assistant-ui thread viewport/messages/footer structure.
- Create: `src/components/agent/assistant-ui/CodeMuxComposer.tsx` — assistant-ui-compatible composer preserving CodeMUX slash-command behavior.
- Modify: `src/components/agent/AgentPanel.tsx` — swap central message/input region to the new assistant-ui runtime subtree.
- Keep: `src/components/agent/AgentMessageList.tsx` and `src/components/agent/AgentInput.tsx` — rollback references for first phase.

There is no existing test runner in `package.json`; validation uses `npm run build` plus manual Tauri UI checks. Pure conversion code should be written so it can receive tests later without React/Tauri dependencies.

---

### Task 1: Add assistant-ui Dependency

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install the runtime package**

Run:

```powershell
npm install @assistant-ui/react@0.14.14
```

Expected:

- `package.json` includes `"@assistant-ui/react": "^0.14.14"` or an npm-equivalent semver entry.
- `package-lock.json` includes the resolved package tree.

- [ ] **Step 2: Verify dependency installation without code changes**

Run:

```powershell
npm ls @assistant-ui/react
```

Expected:

```text
CodeMUX@0.1.0
`-- @assistant-ui/react@0.14.14
```

- [ ] **Step 3: Check worktree state**

Run:

```powershell
git status --short package.json package-lock.json
```

Expected:

```text
 M package-lock.json
 M package.json
```

Do not commit unless the user explicitly asks for commits.

---

### Task 2: Build Event Conversion Utility

**Files:**
- Create: `src/components/agent/assistant-ui/convertAgentEvents.ts`

- [ ] **Step 1: Create the converter file with explicit local types**

Create `src/components/agent/assistant-ui/convertAgentEvents.ts` with this implementation skeleton:

```ts
import type { AgentMessage } from '../../../stores/agentStore';
import type { ContentBlock } from '../../../types/agent';

type CodeMUXMessageRole = 'user' | 'assistant' | 'system';

type CodeMUXTextPart = {
  type: 'text';
  text: string;
};

type CodeMUXReasoningPart = {
  type: 'reasoning';
  text: string;
};

type CodeMUXToolCallPart = {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
};

type CodeMUXCustomPart = {
  type: 'data-codemux-event';
  eventKind: AgentMessage['kind'];
  event: AgentMessage;
};

export type CodeMUXAssistantPart =
  | CodeMUXTextPart
  | CodeMUXReasoningPart
  | CodeMUXToolCallPart
  | CodeMUXCustomPart;

export type CodeMUXAssistantMessage = {
  id: string;
  role: CodeMUXMessageRole;
  content: CodeMUXAssistantPart[];
  metadata?: {
    sourceEventIndex: number;
    sourceKind: AgentMessage['kind'];
  };
};

export function convertAgentEventsToAssistantMessages(events: AgentMessage[]): CodeMUXAssistantMessage[] {
  const messages: CodeMUXAssistantMessage[] = [];
  const toolCallById = new Map<string, CodeMUXToolCallPart>();

  events.forEach((event, index) => {
    if (event.kind === 'user') {
      const text = event.data.content.trim();
      if (text.length > 0) {
        messages.push(createMessage(`user-${index}`, 'user', [{ type: 'text', text }], event, index));
      }
      return;
    }

    if (event.kind === 'assistant') {
      const parts = convertAssistantContent(event.data.message.content, toolCallById);
      if (parts.length > 0) {
        messages.push(createMessage(event.data.uuid || `assistant-${index}`, 'assistant', parts, event, index));
      }
      return;
    }

    if (event.kind === 'tool_result') {
      const customPart: CodeMuxCustomPart = { type: 'data-codemux-event', eventKind: event.kind, event };
      attachToolResults(event, toolCallById, customPart);
      messages.push(createMessage(event.data.uuid || `tool-result-${index}`, 'assistant', [customPart], event, index));
      return;
    }

    if (shouldRenderCustomEvent(event.kind)) {
      messages.push(
        createMessage(`event-${event.kind}-${index}`, 'system', [{ type: 'data-codemux-event', eventKind: event.kind, event }], event, index),
      );
    }
  });

  return messages;
}

function createMessage(
  id: string,
  role: CodeMUXMessageRole,
  content: CodeMUXAssistantPart[],
  event: AgentMessage,
  index: number,
): CodeMUXAssistantMessage {
  return {
    id,
    role,
    content,
    metadata: {
      sourceEventIndex: index,
      sourceKind: event.kind,
    },
  };
}

function convertAssistantContent(
  content: ContentBlock[],
  toolCallById: Map<string, CodeMUXToolCallPart>,
): CodeMUXAssistantPart[] {
  return content.flatMap((block) => {
    if (block.type === 'text' && block.text) {
      return [{ type: 'text', text: block.text } satisfies CodeMUXTextPart];
    }

    if (block.type === 'thinking' && block.thinking) {
      return [{ type: 'reasoning', text: block.thinking } satisfies CodeMUXReasoningPart];
    }

    if (block.type === 'tool_use') {
      const toolCallId = block.id || `${block.name || 'tool'}-${toolCallById.size}`;
      const toolPart: CodeMUXToolCallPart = {
        type: 'tool-call',
        toolCallId,
        toolName: block.name || 'tool',
        args: block.input || {},
      };
      toolCallById.set(toolCallId, toolPart);
      return [toolPart];
    }

    return [];
  });
}

function attachToolResults(
  event: Extract<AgentMessage, { kind: 'tool_result' }>,
  toolCallById: Map<string, CodeMUXToolCallPart>,
  fallbackPart: CodeMUXCustomPart,
): void {
  for (const result of event.data.message.content) {
    const toolPart = toolCallById.get(result.tool_use_id);
    if (toolPart) {
      toolPart.result = result.content;
    } else {
      fallbackPart.event = event;
    }
  }
}

function shouldRenderCustomEvent(kind: AgentMessage['kind']): boolean {
  return ['error', 'api_retry', 'ask_user_question', 'compact', 'mcp_status', 'streaming', 'file_snapshot', 'raw'].includes(kind);
}
```

- [ ] **Step 2: Export only pure conversion primitives**

Confirm the file does not import React, Tauri APIs, Zustand hooks, or UI components. It should remain a pure TypeScript module.

Run:

```powershell
Select-String -Path src\components\agent\assistant-ui\convertAgentEvents.ts -Pattern "react|tauri|useAgentStore|jsx|tsx"
```

Expected: no matches.

- [ ] **Step 3: Build-check the converter**

Run:

```powershell
npm run build
```

Expected: build may fail later because assistant-ui components are not yet created, but this task should not introduce TypeScript syntax errors in `convertAgentEvents.ts`. If the only changes so far are Task 1 and Task 2, expected final result is `tsc && vite build` passing.

---

### Task 3: Add Runtime Provider Hook

**Files:**
- Create: `src/components/agent/assistant-ui/CodeMuxAssistantRuntime.tsx`

- [ ] **Step 1: Create runtime provider wrapper**

Create `src/components/agent/assistant-ui/CodeMuxAssistantRuntime.tsx`:

```tsx
import { ReactNode, useMemo } from 'react';
import { AssistantRuntimeProvider, useExternalStoreRuntime } from '@assistant-ui/react';
import { useAgentStore } from '../../../stores/agentStore';
import { convertAgentEventsToAssistantMessages } from './convertAgentEvents';

interface CodeMUXAssistantRuntimeProviderProps {
  sessionId: string;
  onSend: (content: string) => Promise<void>;
  children: ReactNode;
}

export function CodeMUXAssistantRuntimeProvider({ sessionId, onSend, children }: CodeMUXAssistantRuntimeProviderProps) {
  const events = useAgentStore((state) => state.events[sessionId] || []);
  const convertedMessages = useMemo(() => convertAgentEventsToAssistantMessages(events), [events]);

  const runtime = useExternalStoreRuntime({
    messages: convertedMessages,
    onNew: async (message) => {
      const content = message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim();

      if (content.length > 0) {
        await onSend(content);
      }
    },
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
```

- [ ] **Step 2: If TypeScript rejects local message shape, add a narrow mapping function**

If `useExternalStoreRuntime` requires an imported assistant-ui message type, update the file by importing the documented type and mapping fields at the runtime boundary:

```tsx
import type { ThreadMessageLike } from '@assistant-ui/react';

const runtimeMessages = convertedMessages.map((message): ThreadMessageLike => ({
  id: message.id,
  role: message.role === 'system' ? 'assistant' : message.role,
  content: message.content,
  metadata: message.metadata,
}));
```

Then pass `messages: runtimeMessages`.

- [ ] **Step 3: Build-check runtime typings**

Run:

```powershell
npm run build
```

Expected: any failure should identify exact assistant-ui type names or content-part shape issues. Fix only the type boundary in `CodeMUXAssistantRuntime.tsx` or `convertAgentEvents.ts`.

---

### Task 4: Add Message Part Renderers

**Files:**
- Create: `src/components/agent/assistant-ui/CodeMuxMessageParts.tsx`

- [ ] **Step 1: Create renderer components that reuse existing CodeMUX UI**

Create `src/components/agent/assistant-ui/CodeMuxMessageParts.tsx`:

```tsx
import { MarkdownRenderer } from '../MarkdownRenderer';
import { ThinkingBlock } from '../ThinkingBlock';
import { ToolCallCard } from '../ToolCallCard';
import { TerminalBlock } from '../TerminalBlock';
import { DiffBlock } from '../DiffBlock';
import { AskUserQuestionCard } from '../AskUserQuestionCard';
import type { CodeMUXAssistantPart } from './convertAgentEvents';

interface CodeMUXMessagePartProps {
  part: CodeMUXAssistantPart;
}

export function CodeMUXMessagePart({ part }: CodeMUXMessagePartProps) {
  if (part.type === 'text') {
    return <MarkdownRenderer content={part.text} />;
  }

  if (part.type === 'reasoning') {
    return <ThinkingBlock thinking={part.text} />;
  }

  if (part.type === 'tool-call') {
    return <ToolCallCard block={{ type: 'tool_use', id: part.toolCallId, name: part.toolName, input: part.args }} result={part.result} />;
  }

  if (part.eventKind === 'ask_user_question') {
    return <AskUserQuestionCard data={part.event.data} />;
  }

  if (part.eventKind === 'streaming') {
    return <CodeMUXEventFallback title="Streaming event" data={part.event.data} />;
  }

  if (part.eventKind === 'raw') {
    return <CodeMUXEventFallback title="Raw agent event" data={part.event.data} />;
  }

  return <CodeMUXEventFallback title={part.eventKind} data={part.event} />;
}

function CodeMUXEventFallback({ title, data }: { title: string; data: unknown }) {
  return (
    <details className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
      <summary className="cursor-pointer text-foreground">{title}</summary>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}

export { TerminalBlock, DiffBlock };
```

- [ ] **Step 2: Fix prop mismatches against existing renderers**

Open each existing renderer signature and adjust only the wrapper calls in `CodeMUXMessageParts.tsx`:

```powershell
Get-Content src\components\agent\ToolCallCard.tsx -TotalCount 80
Get-Content src\components\agent\ThinkingBlock.tsx -TotalCount 80
Get-Content src\components\agent\AskUserQuestionCard.tsx -TotalCount 80
```

Expected: the wrapper compiles without changing existing renderer public behavior.

- [ ] **Step 3: Build-check renderer integration**

Run:

```powershell
npm run build
```

Expected: TypeScript passes for renderer imports and props, or failures point to wrapper prop adaptation only.

---

### Task 5: Add assistant-ui Thread Component

**Files:**
- Create: `src/components/agent/assistant-ui/CodeMuxThread.tsx`

- [ ] **Step 1: Create a thread shell using assistant-ui primitives**

Create `src/components/agent/assistant-ui/CodeMuxThread.tsx`:

```tsx
import { ThreadPrimitive, MessagePrimitive } from '@assistant-ui/react';
import { cn } from '../../../lib/utils';
import { CodeMuxMessagePart } from './CodeMuxMessageParts';

export function CodeMUXThread() {
  return (
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
      <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-4 py-5">
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        <ThreadPrimitive.ViewportFooter className="sticky bottom-0 h-4" />
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="mx-auto mb-4 flex max-w-4xl justify-end">
      <div className="max-w-[80%] rounded-2xl bg-primary px-4 py-2 text-sm text-primary-foreground shadow-sm">
        <MessagePrimitive.Content components={{ Text: UserText }} />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="mx-auto mb-5 flex max-w-4xl justify-start">
      <div className="min-w-0 max-w-full space-y-3 text-sm text-foreground">
        <MessagePrimitive.Content components={{ Text: AssistantText, Reasoning: AssistantReasoning, ToolCall: AssistantToolCall }} />
      </div>
    </MessagePrimitive.Root>
  );
}

function UserText({ text }: { text: string }) {
  return <span className="whitespace-pre-wrap break-words">{text}</span>;
}

function AssistantText({ text }: { text: string }) {
  return <CodeMUXMessagePart part={{ type: 'text', text }} />;
}

function AssistantReasoning({ text }: { text: string }) {
  return <CodeMUXMessagePart part={{ type: 'reasoning', text }} />;
}

function AssistantToolCall(props: { toolCallId: string; toolName: string; args: Record<string, unknown>; result?: unknown }) {
  return <CodeMUXMessagePart part={{ type: 'tool-call', ...props }} />;
}
```

- [ ] **Step 2: Adapt component names if assistant-ui API differs**

If `ThreadPrimitive.Messages` or `MessagePrimitive.Content` component override names differ in `@assistant-ui/react@0.14.14`, use the installed package typings to adjust only this file:

```powershell
rg "declare namespace ThreadPrimitive|Messages" node_modules\@assistant-ui\react -n
rg "declare namespace MessagePrimitive|Content" node_modules\@assistant-ui\react -n
```

Expected: `CodeMUXThread.tsx` compiles with the installed primitive API.

- [ ] **Step 3: Keep styling compact**

Confirm the class names preserve CodeMUX density:

```powershell
Select-String -Path src\components\agent\assistant-ui\CodeMUXThread.tsx -Pattern "max-w-4xl|text-sm|overflow-y-auto|space-y-3"
```

Expected: all four patterns are present.

---

### Task 6: Add Composer With Slash Command Preservation

**Files:**
- Create: `src/components/agent/assistant-ui/CodeMuxComposer.tsx`

- [ ] **Step 1: Start with a compatibility composer**

Create `src/components/agent/assistant-ui/CodeMuxComposer.tsx`:

```tsx
import type { SlashCommand } from '../../../lib/slashCommands';
import { AgentInput } from '../AgentInput';

interface CodeMUXComposerProps {
  onSend: (content: string) => Promise<void>;
  onCommand: (command: SlashCommand, args: string) => void | Promise<void>;
  onStop?: () => void;
  isLoading: boolean;
  modelName?: string;
}

export function CodeMUXComposer(props: CodeMUXComposerProps) {
  return <AgentInput {...props} />;
}
```

This deliberately keeps slash commands stable in the first migration phase while the transcript/runtime moves to assistant-ui.

- [ ] **Step 2: Add a follow-up note in the file header only if needed**

If a reviewer asks why this wraps `AgentInput`, use this exact short comment above the component:

```tsx
// First-phase compatibility wrapper: keeps slash commands stable while assistant-ui takes over the thread runtime.
```

Do not add the comment unless the intent is unclear during review.

- [ ] **Step 3: Build-check composer wrapper**

Run:

```powershell
npm run build
```

Expected: no TypeScript errors from `CodeMUXComposer.tsx`.

---

### Task 7: Wire Runtime and Thread Into AgentPanel

**Files:**
- Modify: `src/components/agent/AgentPanel.tsx`

- [ ] **Step 1: Add imports**

Add imports near the existing agent component imports:

```tsx
import { CodeMuxAssistantRuntimeProvider } from './assistant-ui/CodeMuxAssistantRuntime';
import { CodeMuxThread } from './assistant-ui/CodeMuxThread';
import { CodeMuxComposer } from './assistant-ui/CodeMuxComposer';
```

- [ ] **Step 2: Replace only the central message/input subtree**

Find the JSX that renders `AgentMessageList` and `AgentInput`. Replace that central region with:

```tsx
<CodeMUXAssistantRuntimeProvider sessionId={sessionId} onSend={handleSend}>
  <div className="flex min-h-0 flex-1 flex-col">
    <CodeMUXThread />
    <div className="border-t border-border bg-background/95 p-4">
      <CodeMUXComposer
        onSend={handleSend}
        onCommand={handleCommand}
        onStop={() => interrupt(sessionId)}
        isLoading={running}
        modelName={activeProvider?.model}
      />
    </div>
  </div>
</CodeMuxAssistantRuntimeProvider>
```

Keep the surrounding title bar, context progress, todo list, changed files list, preview toggle, dialogs, and provider validation logic unchanged.

- [ ] **Step 3: Remove unused imports after the replacement**

Remove these imports only if TypeScript reports them as unused:

```tsx
import { AgentMessageList } from './AgentMessageList';
import { AgentInput } from './AgentInput';
```

Do not delete the component files.

- [ ] **Step 4: Build-check AgentPanel integration**

Run:

```powershell
npm run build
```

Expected: TypeScript passes or reports assistant-ui API mismatches isolated to the new adapter/thread files.

---

### Task 8: Validate Manual AI Interaction Paths

**Files:**
- No source edits unless validation exposes a migration regression.

- [ ] **Step 1: Start the frontend**

Run:

```powershell
npm run dev
```

Expected: Vite starts and prints a local URL, usually `http://localhost:5173/`.

- [ ] **Step 2: Open the app in the in-app browser**

Use Browser plugin to navigate to the Vite URL.

Expected:

- The main layout renders.
- Existing session list/sidebar still appears.
- The chat area uses the new assistant-ui thread shell.

- [ ] **Step 3: Validate historical messages**

Open an existing session with stored events.

Expected:

- User messages render on the right.
- Assistant markdown renders with existing markdown styling.
- Tool/thinking/fallback events are visible and not silently dropped.

- [ ] **Step 4: Validate sending and stopping**

Send a short prompt, then stop an active response if the model streams long enough.

Expected:

- Prompt goes through existing provider validation.
- `startQuery` still runs.
- Streaming output appears or at minimum final assistant output appears.
- Stop button calls `interrupt(sessionId)`.

- [ ] **Step 5: Validate slash commands**

Type `/` in the composer.

Expected:

- Existing slash command menu appears.
- Selecting a command calls the existing `handleCommand` path.

---

### Task 9: Final Build and Worktree Review

**Files:**
- Review all changed files.

- [ ] **Step 1: Run production build**

Run:

```powershell
npm run build
```

Expected:

- `tsc` passes.
- `vite build` completes.

- [ ] **Step 2: Review changed files**

Run:

```powershell
git status --short
git diff -- package.json package-lock.json src\components\agent\AgentPanel.tsx src\components\agent\assistant-ui
```

Expected:

- Dependency changes are limited to assistant-ui.
- New files are isolated under `src/components/agent/assistant-ui/`.
- `AgentPanel.tsx` only changes the central conversation subtree and imports.
- Old `AgentMessageList.tsx` and `AgentInput.tsx` still exist.

- [ ] **Step 3: Summarize verification**

Prepare a handoff summary containing:

```text
Implemented assistant-ui ExternalStoreRuntime adapter.
Build: npm run build -> PASS
Manual checks: historical messages, send, stop, slash commands -> PASS or list exact failures
Changed files: package.json, package-lock.json, AgentPanel.tsx, assistant-ui adapter files
```

Do not commit unless the user explicitly asks for commits.
