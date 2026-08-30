import type { SubagentStatus } from './codeMuxProtocol.js';
import type { TurnSourceEvent } from './turnEventNormalizer.js';
import {
  adaptAppServerItem,
  buildCodexToolResultContent,
  buildCodexToolUseContent,
  isCodexToolResultError,
} from './runtimeEvents.js';

/**
 * Pure Codex adapter seam (spec seam 1): app-server notifications in,
 * observations / projected TurnSourceEvents out. Stateful routing (child
 * thread registry, pending buffer, fold) lives in codexSubagentSource.ts.
 */

/** Parent-side `collabAgentToolCall` item: the declaration + status signal. */
export type CodexCollabItemInfo = {
  id: string;
  tool: string | null;
  prompt: string | null;
  /** Adapted item status: in_progress / completed / failed / declined. */
  status: string | null;
  /** Child agent threads this collab call addresses. */
  receiverThreadIds: string[];
  /** Child thread id → raw CollabAgentState.status. */
  agentsStates: Record<string, string>;
};

/** Parent-side `subAgentActivity` item: lightweight child lifecycle marker. */
export type CodexSubAgentActivityInfo = {
  id: string;
  kind: 'started' | 'interacted' | 'interrupted';
  agentThreadId: string | null;
  agentPath: string | null;
};

export function extractCodexCollabItem(rawItem: unknown): CodexCollabItemInfo | null {
  const item = asRecord(rawItem);
  if (!item || item.type !== 'collabAgentToolCall') {
    return null;
  }
  const id = asString(item.id);
  if (!id) {
    return null;
  }
  return {
    id,
    tool: asString(item.tool) ?? null,
    prompt: asString(item.prompt) ?? null,
    status: asString(item.status) ?? null,
    receiverThreadIds: Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : [],
    agentsStates: extractAgentsStates(item.agentsStates),
  };
}

export function extractCodexSubAgentActivity(rawItem: unknown): CodexSubAgentActivityInfo | null {
  const item = asRecord(rawItem);
  if (!item || item.type !== 'subAgentActivity') {
    return null;
  }
  const id = asString(item.id);
  if (!id) {
    return null;
  }
  const kind = asString(item.kind);
  return {
    id,
    kind: kind === 'started' || kind === 'interacted' || kind === 'interrupted' ? kind : 'interacted',
    agentThreadId: asString(item.agentThreadId) ?? null,
    agentPath: asString(item.agentPath) ?? null,
  };
}

function extractAgentsStates(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  const states: Record<string, string> = {};
  for (const [threadId, state] of Object.entries(record)) {
    if (typeof state === 'string') {
      states[threadId] = state;
      continue;
    }
    const status = asRecord(state)?.status;
    if (typeof status === 'string' && status.length > 0) {
      states[threadId] = status;
    }
  }
  return states;
}

/**
 * Child-level CollabAgentState.status → CodeMUX status. Mirrors the mapping
 * Paseo validated against real codex: `errored` stays running (a child turn
 * may retry), `shutdown` is a cooperative close (canceled), `notFound` failed.
 */
export function mapCodexCollabChildStatus(value: string): SubagentStatus | undefined {
  switch (value) {
    case 'pendingInit':
    case 'running':
    case 'inProgress':
      return 'running';
    case 'completed':
      return 'completed';
    case 'interrupted':
    case 'shutdown':
      return 'canceled';
    case 'notFound':
      return 'failed';
    case 'errored':
      return 'running';
    default:
      return undefined;
  }
}

/**
 * Aggregate a collab item into one descriptor status. Child states win; the
 * item status only decides when no child state is known. `in_progress`
 * returns undefined on purpose — running is the fold's default and repeated
 * running upserts are noise.
 */
export function aggregateCollabAgentStatus(info: CodexCollabItemInfo): SubagentStatus | undefined {
  if (info.status === 'failed') return 'failed';
  if (info.status === 'declined') return 'canceled';
  const childStatuses = Object.values(info.agentsStates)
    .map(mapCodexCollabChildStatus)
    .filter((status): status is SubagentStatus => status !== undefined);
  if (childStatuses.includes('failed')) return 'failed';
  if (childStatuses.includes('canceled')) return 'canceled';
  if (childStatuses.length > 0) {
    return childStatuses.every((status) => status === 'completed') ? 'completed' : 'running';
  }
  if (info.status === 'completed') return 'completed';
  return undefined;
}

/** Child thread `turn/completed` status → CodeMUX terminal status. */
export function mapCodexChildTurnStatus(value: unknown): SubagentStatus | undefined {
  switch (value) {
    case 'completed':
      return 'completed';
    case 'interrupted':
    case 'cancelled':
      return 'canceled';
    case 'failed':
      return 'failed';
    default:
      return undefined;
  }
}

/** Per-child-thread streaming state: item ids already announced via content_started. */
export type CodexChildProjectionState = {
  streamingItems: Map<string, 'text' | 'thinking'>;
};

export function createCodexChildProjectionState(): CodexChildProjectionState {
  return { streamingItems: new Map() };
}

/**
 * Project one child-thread app-server notification into TurnSourceEvents for
 * the subagent timeline. Nested collab calls (grandchildren) are skipped —
 * the v1 spec scopes the panel to one track per direct child.
 */
export function projectCodexChildNotification(
  method: string,
  params: Record<string, unknown>,
  state: CodexChildProjectionState,
  context: { workdir?: string } = {},
): TurnSourceEvent[] {
  switch (method) {
    case 'item/started': {
      const item = adaptAppServerItem(asRecord(params.item));
      if (!item) return [];
      if (item.type === 'agent_message' || item.type === 'reasoning' || item.type === 'plan') {
        // content_started is emitted lazily on the first delta.
        return [];
      }
      if (item.type === 'collab_agent_tool_call') return [];
      const toolUse = buildCodexToolUseContent(item, { workdir: context.workdir });
      return toolUse?.type === 'tool_use'
        ? [{ kind: 'tool_started', toolUseId: toolUse.id, name: toolUse.name, input: toolUse.input }]
        : [];
    }
    case 'item/completed': {
      const item = adaptAppServerItem(asRecord(params.item));
      if (!item) return [];
      const events: TurnSourceEvent[] = [];
      if (state.streamingItems.delete(item.id)) {
        events.push({ kind: 'content_finished', index: 0 });
      }
      if (item.type === 'agent_message') {
        if (item.text?.trim()) {
          events.push({
            kind: 'assistant_message',
            content: [{ type: 'text', text: item.text }],
            providerMessageId: item.id,
          });
        }
        return events;
      }
      if (item.type === 'reasoning') {
        if (item.text?.trim()) {
          events.push({
            kind: 'assistant_message',
            content: [{ type: 'thinking', thinking: item.text }],
            providerMessageId: item.id,
          });
        }
        return events;
      }
      if (item.type === 'plan' || item.type === 'collab_agent_tool_call') return events;
      const result = buildCodexToolResultContent(item);
      if (result !== null) {
        events.push({
          kind: 'tool_finished',
          toolUseId: item.id,
          content: result,
          isError: isCodexToolResultError(item),
        });
      }
      return events;
    }
    case 'item/agentMessage/delta': {
      const itemId = asString(params.itemId);
      const delta = params.delta;
      if (!itemId || typeof delta !== 'string') return [];
      return streamingDeltaEvents(state, itemId, 'text', delta);
    }
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta': {
      const itemId = asString(params.itemId);
      const delta = params.delta;
      if (!itemId || typeof delta !== 'string') return [];
      return streamingDeltaEvents(state, itemId, 'thinking', delta);
    }
    case 'error': {
      if (params.willRetry === true) return [];
      const message = asRecord(params.error)?.message;
      return [{ kind: 'error', subtype: 'runtime', message: typeof message === 'string' ? message : 'Unknown app-server error' }];
    }
    default:
      return [];
  }
}

function streamingDeltaEvents(
  state: CodexChildProjectionState,
  itemId: string,
  kind: 'text' | 'thinking',
  delta: string,
): TurnSourceEvent[] {
  const events: TurnSourceEvent[] = [];
  if (!state.streamingItems.has(itemId)) {
    events.push({ kind: 'content_started', index: 0, contentKind: kind === 'thinking' ? 'reasoning' : 'text' });
  }
  state.streamingItems.set(itemId, kind);
  events.push({ kind: kind === 'thinking' ? 'reasoning_delta' : 'text_delta', index: 0, text: delta });
  return events;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
