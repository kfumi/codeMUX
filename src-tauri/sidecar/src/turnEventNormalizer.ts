import type { CodeMuxRuntimeEvent, CodeMuxTurnEvent } from './codeMuxProtocol.js';

export type TurnSourceEvent =
  | {
      kind: 'assistant_message';
      content: Array<Record<string, unknown>>;
      stopReason?: string | null;
      providerMessageId?: string;
      providerTurnId?: string;
      supersedesProviderMessageIds?: string[];
      /** Provider model that produced the message, when the runtime reports one. */
      model?: string;
    }
  | { kind: 'user_input_requested'; toolUseId: string; questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string; value?: unknown }>; multiSelect?: boolean; allowOther?: boolean; presentation?: 'plan-approval'; inputPlaceholder?: string }> }
  | { kind: 'permission_requested'; requestId: string; permissionId?: string; permissionType: string; description: string; metadata?: Record<string, unknown> }
  | { kind: 'content_started'; index: number; contentKind: 'text' | 'reasoning' }
  | { kind: 'text_delta' | 'reasoning_delta'; index: number; text: string }
  | { kind: 'content_finished'; index: number }
  | { kind: 'tool_started'; toolUseId: string; name: string; input: Record<string, unknown> }
  | { kind: 'tool_finished'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'user_message'; content: string | Array<Record<string, unknown>> }
  | { kind: 'error'; subtype: string; message: string };

export type TurnUsage = {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_output_tokens: number;
};

export type TurnOutcome = {
  outcome: 'completed' | 'failed' | 'interrupted' | 'cancelled';
  reason?: string;
  durationMs?: number;
  usage?: TurnUsage;
};

export type TurnEventNormalizerOptions = {
  /**
   * When true, a repeated `tool_started` for an already-started tool_use_id
   * refreshes the stored input (merged over the previous one) and re-emits the
   * event instead of being dropped. OpenCode tool parts arrive with an empty
   * `state.input` at `pending` and stream the real input in later part
   * updates; the subagent timeline must persist the refreshed input.
   */
  refreshToolInput?: boolean;
};

export class TurnEventNormalizer {
  private sequence = 0;
  private finished = false;
  private readonly startedToolIds = new Set<string>();
  private readonly startedToolInputs = new Map<string, Record<string, unknown>>();
  private readonly finishedToolIds = new Set<string>();
  private readonly requestedInputIds = new Set<string>();
  private readonly requestedPermissionIds = new Set<string>();
  private readonly assistantMessageIds = new Set<string>();

  constructor(
    private readonly sessionId: string,
    private readonly eventIdFactory: () => string = () => crypto.randomUUID(),
    private readonly options: TurnEventNormalizerOptions = {},
  ) {}

  accept(source: TurnSourceEvent): CodeMuxRuntimeEvent[] {
    if (this.finished) return [];
    if (source.kind === 'assistant_message') {
      if (source.providerMessageId && this.assistantMessageIds.has(source.providerMessageId)) {
        return [];
      }
      if (source.providerMessageId) {
        this.assistantMessageIds.add(source.providerMessageId);
      }
      return [this.withSequence({
        type: 'assistant_message', session_id: this.sessionId, content: source.content,
        ...(source.stopReason !== undefined ? { stop_reason: source.stopReason } : {}),
        ...(source.model ? { model: source.model } : {}),
        ...(source.providerMessageId ? { provider_message_id: source.providerMessageId } : {}),
        ...(source.providerTurnId ? { provider_turn_id: source.providerTurnId } : {}),
        ...(source.supersedesProviderMessageIds?.length
          ? { supersedes_provider_message_ids: source.supersedesProviderMessageIds }
          : {}),
        event_id: this.eventIdFactory(), sequence: 0,
      })];
    }
    if (source.kind === 'user_input_requested') {
      if (this.requestedInputIds.has(source.toolUseId)) return [];
      this.requestedInputIds.add(source.toolUseId);
      return [this.withSequence({
        type: 'user_input_requested', session_id: this.sessionId, tool_use_id: source.toolUseId,
        questions: source.questions, event_id: this.eventIdFactory(), sequence: 0,
      })];
    }
    if (source.kind === 'permission_requested') {
      if (this.requestedPermissionIds.has(source.requestId)) return [];
      this.requestedPermissionIds.add(source.requestId);
      return [this.withSequence({
        type: 'permission_requested', session_id: this.sessionId, request_id: source.requestId,
        ...(source.permissionId ? { permission_id: source.permissionId } : {}),
        permission_type: source.permissionType, description: source.description,
        ...(source.metadata ? { metadata: source.metadata } : {}),
        event_id: this.eventIdFactory(), sequence: 0,
      })];
    }
    if (source.kind === 'content_started') {
      return [this.withSequence({
        type: 'content_started', session_id: this.sessionId, index: source.index,
        content_kind: source.contentKind, event_id: this.eventIdFactory(), sequence: 0,
      })];
    }
    if (source.kind === 'text_delta' || source.kind === 'reasoning_delta') {
      return [this.withSequence({
        type: source.kind, session_id: this.sessionId, index: source.index, text: source.text,
        event_id: this.eventIdFactory(), sequence: 0,
      })];
    }
    if (source.kind === 'content_finished') {
      return [this.withSequence({
        type: 'content_finished', session_id: this.sessionId, index: source.index,
        event_id: this.eventIdFactory(), sequence: 0,
      })];
    }
    if (source.kind === 'tool_started') {
      const previousInput = this.startedToolInputs.get(source.toolUseId);
      if (previousInput) {
        if (!this.options.refreshToolInput) return [];
        const merged = mergeToolInputs(previousInput, source.input);
        if (sameToolInputs(previousInput, merged)) return [];
        this.startedToolInputs.set(source.toolUseId, merged);
        return [this.withSequence({
          type: 'tool_started', session_id: this.sessionId, tool_use_id: source.toolUseId,
          name: source.name, input: merged, event_id: this.eventIdFactory(), sequence: 0,
        })];
      }
      this.startedToolIds.add(source.toolUseId);
      this.startedToolInputs.set(source.toolUseId, source.input);
      return [this.withSequence({
        type: 'tool_started', session_id: this.sessionId, tool_use_id: source.toolUseId,
        name: source.name, input: source.input, event_id: this.eventIdFactory(), sequence: 0,
      })];
    }
    if (source.kind === 'tool_finished') {
      if (this.finishedToolIds.has(source.toolUseId)) return [];
      this.finishedToolIds.add(source.toolUseId);
      return [this.withSequence({
        type: 'tool_finished', session_id: this.sessionId, tool_use_id: source.toolUseId, content: source.content,
        is_error: source.isError, event_id: this.eventIdFactory(), sequence: 0,
      })];
    }
    if (source.kind === 'user_message') {
      return [this.withSequence({
        type: 'user_message', session_id: this.sessionId, content: source.content,
        event_id: this.eventIdFactory(), sequence: 0,
      })];
    }
    if (source.kind === 'error') {
      return [this.withSequence({
        type: 'error', session_id: this.sessionId, subtype: source.subtype,
        error: source.message, event_id: this.eventIdFactory(), sequence: 0,
      })];
    }
    return [];
  }

  finish(outcome: TurnOutcome, flags?: { synthetic?: boolean }): CodeMuxTurnEvent[] {
    if (this.finished) return [];
    this.finished = true;
    return [this.withSequence({
      type: 'turn_finished', session_id: this.sessionId, outcome: outcome.outcome,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(outcome.usage ? { usage: outcome.usage } : {}),
      ...(outcome.durationMs !== undefined ? { duration_ms: outcome.durationMs } : {}),
      ...(flags?.synthetic ? { synthetic: true } : {}),
      event_id: this.eventIdFactory(), sequence: 0,
    })];
  }

  private withSequence<T extends CodeMuxRuntimeEvent>(event: T): T {
    return { ...event, sequence: this.sequence++ } as T;
  }
}

function mergeToolInputs(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    merged[key] = value;
  }
  return merged;
}

function sameToolInputs(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) => a[key] === b[key]);
}
