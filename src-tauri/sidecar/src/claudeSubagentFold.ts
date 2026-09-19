import type { CodeMuxRuntimeEvent, CodeMuxSubagentEvent, CodeMuxSubagentUpsertEvent, SubagentStatus } from './codeMuxProtocol.js';
import { TurnEventNormalizer } from './turnEventNormalizer.js';
import type { SubagentObservation } from './claudeSubagentObservations.js';

const TERMINAL_STATUSES: ReadonlySet<SubagentStatus> = new Set(['completed', 'failed', 'canceled']);

export type SubagentDescriptorState = {
  provider: string;
  title?: string | null;
  description?: string | null;
  status: SubagentStatus;
  tool_call_id: string;
  subtitle?: string | null;
};

export type SubagentFoldEntry = {
  subagentId: string;
  descriptor: SubagentDescriptorState;
  isBackgrounded?: boolean;
  seenBackgroundedPatch: boolean;
  /** Set once the timeline's first user_message (the task prompt) was emitted. */
  announcedPrompt: boolean;
  /** One normalizer per subagent keeps the per-timeline sequence monotonic. */
  normalizer: TurnEventNormalizer;
};

export type SubagentFoldState = {
  taskToSubagent: Record<string, string>;
  aliasToSubagent: Record<string, string>;
  subagents: Record<string, SubagentFoldEntry>;
  /** Maps a sidechain frame uuid to parent_tool_use_id for parentUuid resolution. */
  sidechainUuidToParentToolUseId: Record<string, string>;
};

export type SubagentFoldContext = {
  sessionId?: string;
  newEventId?: () => string;
  timestamp?: () => string;
  /**
   * Emit refreshed `tool_started` events when a later observation carries more
   * complete input for an already-started tool (OpenCode streams tool input
   * after the first part update). Claude sidechains keep drop semantics.
   */
  refreshToolInput?: boolean;
};

export type SubagentFoldResult = {
  events: CodeMuxSubagentEvent[];
  state: SubagentFoldState;
};

export function createEmptySubagentFoldState(): SubagentFoldState {
  return { taskToSubagent: {}, aliasToSubagent: {}, subagents: {}, sidechainUuidToParentToolUseId: {} };
}

function defaultEventId(): string {
  return crypto.randomUUID();
}

function defaultTimestamp(): string {
  return new Date().toISOString();
}

function cloneState(state: SubagentFoldState): SubagentFoldState {
  return {
    taskToSubagent: { ...state.taskToSubagent },
    aliasToSubagent: { ...state.aliasToSubagent },
    sidechainUuidToParentToolUseId: { ...state.sidechainUuidToParentToolUseId },
    subagents: Object.fromEntries(
      Object.entries(state.subagents).map(([id, entry]) => [id, { ...entry, descriptor: { ...entry.descriptor } }]),
    ),
  };
}

function resolveTimelineParentToolUseId(
  state: SubagentFoldState,
  observation: Extract<SubagentObservation, { kind: 'timeline' }>,
): string | undefined {
  if (observation.sidechainMessageUuid && observation.parentToolUseId) {
    state.sidechainUuidToParentToolUseId[observation.sidechainMessageUuid] = observation.parentToolUseId;
  }
  if (observation.parentToolUseId) {
    return observation.parentToolUseId;
  }
  if (observation.parentUuid) {
    return state.sidechainUuidToParentToolUseId[observation.parentUuid];
  }
  return undefined;
}

function cloneForWrite(state: SubagentFoldState, subagentId: string): { state: SubagentFoldState; entry: SubagentFoldEntry } {
  const next = cloneState(state);
  const entry = next.subagents[subagentId];
  if (!entry) {
    throw new Error(`subagent entry missing: ${subagentId}`);
  }
  return { state: next, entry };
}

function upsertEvent(
  entry: SubagentFoldEntry,
  patch: Partial<Pick<SubagentDescriptorState, 'title' | 'description' | 'status' | 'tool_call_id' | 'subtitle'>>,
  sessionId: string | undefined,
  newEventId: () => string,
  timestamp: () => string,
): CodeMuxSubagentUpsertEvent {
  return {
    type: 'subagent_upsert',
    ...(sessionId ? { session_id: sessionId } : {}),
    subagent_id: entry.subagentId,
    provider: entry.descriptor.provider,
    ...patch,
    event_id: newEventId(),
    timestamp: timestamp(),
  };
}

function timelineEvents(
  entry: SubagentFoldEntry,
  sourceEvents: SubagentObservation & { kind: 'timeline' },
  sessionId: string | undefined,
  newEventId: () => string,
  timestamp: () => string,
): CodeMuxSubagentEvent[] {
  const events: CodeMuxSubagentEvent[] = [];
  for (const sourceEvent of sourceEvents.events) {
    for (const normalized of entry.normalizer.accept(sourceEvent)) {
      const at = timestamp();
      // The wire format carries transport timestamps on parent-path events
      // (the batcher stamps them); the protocol union simply doesn't declare
      // the optional field, so widen it here for the persisted row.
      const withTimestamp = { ...normalized, timestamp: at } as CodeMuxRuntimeEvent & { timestamp: string };
      events.push({
        type: 'subagent_timeline',
        ...(sessionId ? { session_id: sessionId } : {}),
        subagent_id: entry.subagentId,
        event: withTimestamp,
        event_id: newEventId(),
        timestamp: at,
      });
    }
  }
  return events;
}

function resolveSubagentIdForTask(state: SubagentFoldState, taskId: string): SubagentFoldEntry | undefined {
  const subagentId = state.taskToSubagent[taskId];
  return subagentId ? state.subagents[subagentId] : undefined;
}

function isTerminal(status: SubagentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Apply a status patch with the sticky rule: terminal descriptors never go back to running. */
function applyStatus(entry: SubagentFoldEntry, status: SubagentStatus): SubagentStatus | undefined {
  if (entry.descriptor.status === status) return undefined;
  if (isTerminal(entry.descriptor.status) && status === 'running') return undefined;
  entry.descriptor.status = status;
  return status;
}

/**
 * Pure fold: observations + previous state in, domain events + next state out.
 * Shared by the live sidecar path and test fixtures.
 */
export function foldSubagentObservations(
  observations: SubagentObservation[],
  previousState: SubagentFoldState,
  context: SubagentFoldContext = {},
): SubagentFoldResult {
  const newEventId = context.newEventId ?? defaultEventId;
  const timestamp = context.timestamp ?? defaultTimestamp;
  const sessionId = context.sessionId;
  let state = previousState;
  const events: CodeMuxSubagentEvent[] = [];

  for (const observation of observations) {
    switch (observation.kind) {
      case 'declared': {
        const existingId = state.aliasToSubagent[observation.toolUseIds[0]] ?? state.taskToSubagent[observation.taskId];
        if (existingId && state.subagents[existingId]) {
          // Re-announcement for a known task: record new tool_use_id aliases, sticky-merge fields.
          const cloned = cloneForWrite(state, existingId);
          state = cloned.state;
          const entry = cloned.entry;
          const patch: Parameters<typeof upsertEvent>[1] = {};
          if (observation.title !== undefined && observation.title !== entry.descriptor.title) {
            entry.descriptor.title = observation.title;
            patch.title = observation.title;
          }
          if (observation.description !== undefined && observation.description !== entry.descriptor.description) {
            entry.descriptor.description = observation.description;
            patch.description = observation.description;
          }

          if (observation.subtitle !== undefined && observation.subtitle !== entry.descriptor.subtitle) {
            entry.descriptor.subtitle = observation.subtitle;
            patch.subtitle = observation.subtitle;
          }
          const status = applyStatus(entry, 'running');
          if (status) patch.status = status;
          for (const toolUseId of observation.toolUseIds) {
            state.aliasToSubagent[toolUseId] = existingId;
          }
          state.taskToSubagent[observation.taskId] = existingId;
          if (Object.keys(patch).length > 0) {
            events.push(upsertEvent(entry, patch, sessionId, newEventId, timestamp));
          }
          if (!entry.announcedPrompt && observation.prompt) {
            entry.announcedPrompt = true;
            events.push(...timelineEvents(
              entry,
              { kind: 'timeline', events: [{ kind: 'user_message', content: observation.prompt }] },
              sessionId,
              newEventId,
              timestamp,
            ));
          }
          break;
        }

        const subagentId = observation.toolUseIds[0];
        if (state.subagents[subagentId]) {
          // Canonical id already taken by a different task; treat as alias collision and drop.
          break;
        }
        const cloned = cloneState(state);
        state = cloned;
        const entry: SubagentFoldEntry = {
          subagentId,
          descriptor: {
            provider: observation.provider ?? 'claude',
            title: observation.title ?? null,
            description: observation.description ?? null,
            status: 'running',
            tool_call_id: subagentId,
            subtitle: observation.subtitle ?? null,
          },
          isBackgrounded: undefined,
          seenBackgroundedPatch: false,
          announcedPrompt: false,
          normalizer: new TurnEventNormalizer(sessionId ?? '', newEventId, { refreshToolInput: context.refreshToolInput === true }),
        };
        state.subagents[subagentId] = entry;
        for (const toolUseId of observation.toolUseIds) {
          state.aliasToSubagent[toolUseId] = subagentId;
        }
        state.taskToSubagent[observation.taskId] = subagentId;
        events.push(upsertEvent(entry, {
          title: observation.title ?? null,
          description: observation.description ?? null,
          status: 'running',
          ...(observation.subtitle ? { subtitle: observation.subtitle } : {}),
          tool_call_id: subagentId,
        }, sessionId, newEventId, timestamp));
        if (observation.prompt) {
          entry.announcedPrompt = true;
          events.push(...timelineEvents(
            entry,
            { kind: 'timeline', events: [{ kind: 'user_message', content: observation.prompt }] },
            sessionId,
            newEventId,
            timestamp,
          ));
        }
        break;
      }
      case 'status': {
        const entry = resolveSubagentIdForTask(state, observation.taskId);
        if (!entry) break;
        const cloned = cloneForWrite(state, entry.subagentId);
        state = cloned.state;
        const status = applyStatus(cloned.entry, observation.status);
        if (status) {
          events.push(upsertEvent(cloned.entry, { status }, sessionId, newEventId, timestamp));
        }
        break;
      }
      case 'subtitle': {
        const entry = resolveSubagentIdForTask(state, observation.taskId);
        if (!entry) break;
        if (entry.descriptor.subtitle === observation.subtitle) break;
        const cloned = cloneForWrite(state, entry.subagentId);
        state = cloned.state;
        cloned.entry.descriptor.subtitle = observation.subtitle;
        events.push(upsertEvent(cloned.entry, { subtitle: observation.subtitle }, sessionId, newEventId, timestamp));
        break;
      }
      case 'backgrounded': {
        const entry = resolveSubagentIdForTask(state, observation.taskId);
        if (!entry) break;
        const cloned = cloneForWrite(state, entry.subagentId);
        state = cloned.state;
        cloned.entry.isBackgrounded = observation.isBackgrounded;
        cloned.entry.seenBackgroundedPatch = true;
        break;
      }
      case 'timeline': {
        const parentToolUseId = resolveTimelineParentToolUseId(state, observation);
        const subagentId = parentToolUseId
          ? state.aliasToSubagent[parentToolUseId]
          : undefined;
        const entry = subagentId ? state.subagents[subagentId] : undefined;
        if (!entry) break;
        const cloned = cloneForWrite(state, entry.subagentId);
        state = cloned.state;
        events.push(...timelineEvents(cloned.entry, observation, sessionId, newEventId, timestamp));
        break;
      }
    }
  }

  return { events, state };
}

function transitionRunning(
  previousState: SubagentFoldState,
  sessionId: string | undefined,
  newEventId: () => string,
  timestamp: () => string,
  mode: 'cancel_foreground' | 'fail_running',
): SubagentFoldResult {
  const state = cloneState(previousState);
  const events: CodeMuxSubagentEvent[] = [];
  const terminalStatus: SubagentStatus = mode === 'fail_running' ? 'failed' : 'canceled';
  for (const entry of Object.values(state.subagents)) {
    if (entry.descriptor.status !== 'running') continue;
    if (mode === 'cancel_foreground') {
      // Only explicitly non-backgrounded children are foreground-cancellable;
      // backgrounded children and children that never reported a patch keep running.
      if (!(entry.seenBackgroundedPatch && entry.isBackgrounded === false)) continue;
    }
    entry.descriptor.status = terminalStatus;
    events.push(upsertEvent(entry, { status: terminalStatus }, sessionId, newEventId, timestamp));
  }
  return { events, state };
}

/** Parent turn ended: cancel explicitly-foreground running children. */
export function foldCancelRunningForegroundTasks(
  state: SubagentFoldState,
  context: SubagentFoldContext = {},
): SubagentFoldResult {
  return transitionRunning(
    state,
    context.sessionId,
    context.newEventId ?? defaultEventId,
    context.timestamp ?? defaultTimestamp,
    'cancel_foreground',
  );
}

/** User Stop / query abort / process loss: every running child becomes failed. */
export function foldFailRunningTasks(
  state: SubagentFoldState,
  context: SubagentFoldContext = {},
): SubagentFoldResult {
  return transitionRunning(
    state,
    context.sessionId,
    context.newEventId ?? defaultEventId,
    context.timestamp ?? defaultTimestamp,
    'fail_running',
  );
}

export function hasRunningSubagents(state: SubagentFoldState): boolean {
  return Object.values(state.subagents).some((entry) => entry.descriptor.status === 'running');
}
