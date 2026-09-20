import type { CodeMuxSubagentEvent } from './codeMuxProtocol.js';
import type { SubagentObservation } from './claudeSubagentObservations.js';
import {
  createEmptySubagentFoldState,
  foldFailRunningTasks,
  foldSubagentObservations,
  hasRunningSubagents,
  type SubagentFoldContext,
  type SubagentFoldState,
} from './claudeSubagentFold.js';
import {
  createOpenCodeChildProjectionState,
  isOpenCodeTaskToolName,
  mapOpenCodeChildTerminalStatus,
  observeOpenCodeSubtaskPart,
  observeOpenCodeTaskToolPart,
  projectOpenCodeChildEvent,
  type OpenCodeChildProjectionState,
} from './opencodeSubagentObservations.js';

export type OpenCodeSubagentContext = {
  sessionId?: string;
};

/**
 * OpenCode task protocol adapter (spec seam 1): declares subagent tracks from
 * parent-session subtask/Task-tool parts, binds child sessions to their
 * canonical subagent id, and routes child-session traffic into the shared
 * observation fold. The canonical subagent id is the parent-side tool call id
 * of the first declaration signal — the same id the parent Task card uses as
 * its tool_use_id.
 */
export class OpenCodeSubagentSource {
  private foldState: SubagentFoldState = createEmptySubagentFoldState();
  /** Child OpenCode session id → canonical subagent id. */
  private readonly sessionToSubagent = new Map<string, string>();
  /** Child session id → projection state (streaming parts, message bookkeeping). */
  private readonly childStates = new Map<string, OpenCodeChildProjectionState>();
  /** Subtask declarations not yet bound to a child session, by assistant messageID. */
  private readonly unboundDeclarationsByMessageId = new Map<string, string>();
  /** Bindings and matched declarations by assistant messageID, for late subtask parts. */
  private readonly subagentsByMessageId = new Map<string, string>();

  constructor(private readonly eventIdFactory: () => string = () => crypto.randomUUID()) {}

  /**
   * Parent-session event: declaration signals from subtask / Task tool parts.
   * Everything else is ignored (the parent timeline projection is unchanged).
   */
  observeParentEvent(event: unknown, context: OpenCodeSubagentContext = {}): CodeMuxSubagentEvent[] {
    const record = asRecord(event);
    if (readString(record?.type) !== 'message.part.updated') return [];
    const part = asRecord(asRecord(record?.properties)?.part);
    if (!part) return [];

    const observations: SubagentObservation[] = [];
    let declaredMessageId: string | undefined;
    const partType = readString(part.type);
    if (partType === 'subtask') {
      const declaration = observeOpenCodeSubtaskPart(part);
      if (declaration) {
        declaredMessageId = readString(part.messageID);
        // A tool part may have bound this message's task before the subtask
        // part arrived; then the declaration only registers a part-id alias.
        const bound = declaredMessageId ? this.subagentsByMessageId.get(declaredMessageId) : undefined;
        if (bound) {
          observations.push({ kind: 'declared', taskId: bound, toolUseIds: [declaration.toolUseIds[0]], isWorkflow: false, provider: 'opencode' });
        } else {
          observations.push(declaration);
        }
      }
    } else if (partType === 'tool' && isOpenCodeTaskToolName(readString(part.tool) ?? '')) {
      const binding = observeOpenCodeTaskToolPart(part);
      if (binding) {
        observations.push(...this.observeTaskToolBinding(binding));
      }
    }
    if (observations.length === 0) return [];

    const result = this.fold(observations, context);
    if (declaredMessageId) {
      // The declaration may have merged into an existing track; resolve the
      // canonical id after folding so the unbound index is always accurate.
      const first = observations[0];
      const declarationId = first.kind === 'declared' ? first.toolUseIds[0] : undefined;      const subagentId = (declarationId && (this.foldState.aliasToSubagent[declarationId] ?? this.foldState.taskToSubagent[declarationId]))
        ?? undefined;
      if (subagentId) {
        this.subagentsByMessageId.set(declaredMessageId, subagentId);
        if (!this.boundChildSessionIds().has(subagentId)) {
          this.unboundDeclarationsByMessageId.set(declaredMessageId, subagentId);
        }
      }
    }
    return result;
  }

  /** Route one non-parent-session event into the child's timeline / lifecycle. */
  observeChildEvent(event: unknown, childSessionId: string, context: OpenCodeSubagentContext = {}): CodeMuxSubagentEvent[] {
    const subagentId = this.sessionToSubagent.get(childSessionId);
    if (!subagentId) return [];
    const record = asRecord(event);
    const type = readString(record?.type) ?? '';

    const childState = this.childState(childSessionId);
    const sourceEvents = projectOpenCodeChildEvent(event, childState, { eventIdFactory: this.eventIdFactory });
    const observations: SubagentObservation[] = [];
    if (sourceEvents.length > 0) {
      observations.push({ kind: 'timeline', parentToolUseId: subagentId, events: sourceEvents });
    }
    const status = mapOpenCodeChildTerminalStatus(type);
    if (status) {
      observations.push({ kind: 'status', taskId: subagentId, status });
    }
    if (observations.length === 0) return [];
    return this.fold(observations, context);
  }

  isChildSession(sessionId: string): boolean {
    return this.sessionToSubagent.has(sessionId);
  }

  hasRunningTasks(): boolean {
    return hasRunningSubagents(this.foldState);
  }

  /** Mark one child session's subagent as failed (e.g. provider quota escalation). */
  failSession(childSessionId: string, context: OpenCodeSubagentContext = {}): CodeMuxSubagentEvent[] {
    const subagentId = this.sessionToSubagent.get(childSessionId);
    if (!subagentId) return [];
    return this.fold([{ kind: 'status', taskId: subagentId, status: 'failed' }], context);
  }

  /** User Stop / interrupt / runtime dispose: every running child becomes failed. */
  failRunningTasks(context: OpenCodeSubagentContext = {}): CodeMuxSubagentEvent[] {
    const result = foldFailRunningTasks(this.foldState, this.foldContext(context));
    this.foldState = result.state;
    return result.events;
  }

  /** Session teardown only. */
  reset(): void {
    this.foldState = createEmptySubagentFoldState();
    this.sessionToSubagent.clear();
    this.childStates.clear();
    this.unboundDeclarationsByMessageId.clear();
    this.subagentsByMessageId.clear();
  }

  private observeTaskToolBinding(binding: NonNullable<ReturnType<typeof observeOpenCodeTaskToolPart>>): SubagentObservation[] {
    const existing = this.foldState.aliasToSubagent[binding.toolUseId];
    if (existing) {
      this.sessionToSubagent.set(binding.childSessionId, existing);
      this.rememberBindingByMessageId(binding.messageId, existing);
      return [];
    }

    // Match a subtask declaration from the same assistant message (its part id
    // can differ from the tool part's callID across OpenCode versions).
    const matched = binding.messageId ? this.unboundDeclarationsByMessageId.get(binding.messageId) : undefined;
    if (matched && this.foldState.subagents[matched]) {
      this.sessionToSubagent.set(binding.childSessionId, matched);
      this.rememberBindingByMessageId(binding.messageId, matched);
      return [{ kind: 'declared', taskId: matched, toolUseIds: [binding.toolUseId], isWorkflow: false, provider: 'opencode' }];
    }

    this.sessionToSubagent.set(binding.childSessionId, binding.toolUseId);
    this.rememberBindingByMessageId(binding.messageId, binding.toolUseId);
    if (binding.declaration) return [binding.declaration];
    // Task tool part without a subtask part: still declare so the card is
    // clickable, with whatever the tool input offers (possibly no fields).
    return [{ kind: 'declared', taskId: binding.toolUseId, toolUseIds: [binding.toolUseId], isWorkflow: false, provider: 'opencode' }];
  }

  private rememberBindingByMessageId(messageId: string | undefined, subagentId: string): void {
    if (!messageId) return;
    this.subagentsByMessageId.set(messageId, subagentId);
    if (this.unboundDeclarationsByMessageId.get(messageId) === subagentId) {
      this.unboundDeclarationsByMessageId.delete(messageId);
    }
  }

  private boundChildSessionIds(): Set<string> {
    return new Set(this.sessionToSubagent.values());
  }

  private childState(childSessionId: string): OpenCodeChildProjectionState {
    let state = this.childStates.get(childSessionId);
    if (!state) {
      state = createOpenCodeChildProjectionState();
      this.childStates.set(childSessionId, state);
    }
    return state;
  }

  private fold(observations: SubagentObservation[], context: OpenCodeSubagentContext): CodeMuxSubagentEvent[] {
    const result = foldSubagentObservations(observations, this.foldState, this.foldContext(context));
    this.foldState = result.state;
    return result.events;
  }

  private foldContext(context: OpenCodeSubagentContext): SubagentFoldContext {
    return {
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      // OpenCode tool parts stream their input after the first update.
      refreshToolInput: true,
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
