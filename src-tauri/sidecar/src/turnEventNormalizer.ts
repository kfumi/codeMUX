import type { CodeMuxRuntimeEvent, CodeMuxTurnEvent } from './codeMuxProtocol.js';

export type TurnSourceEvent =
  | { kind: 'assistant_message'; content: Array<Record<string, unknown>> }
  | { kind: 'user_input_requested'; toolUseId: string; questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string; value?: unknown }>; multiSelect?: boolean; allowOther?: boolean }> }
  | { kind: 'permission_requested'; requestId: string; permissionId?: string; permissionType: string; description: string; metadata?: Record<string, unknown> }
  | { kind: 'content_started'; index: number; contentKind: 'text' | 'reasoning' }
  | { kind: 'text_delta' | 'reasoning_delta'; index: number; text: string }
  | { kind: 'content_finished'; index: number }
  | { kind: 'tool_started'; toolUseId: string; name: string; input: Record<string, unknown> }
  | { kind: 'tool_finished'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'error'; subtype: string; message: string };

export type TurnOutcome = {
  outcome: 'completed' | 'failed' | 'interrupted' | 'cancelled';
  reason?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    reasoning_output_tokens: number;
  };
  durationMs?: number;
};

export class TurnEventNormalizer {
  private sequence = 0;
  private finished = false;
  private readonly startedToolIds = new Set<string>();
  private readonly finishedToolIds = new Set<string>();
  private readonly requestedInputIds = new Set<string>();
  private readonly requestedPermissionIds = new Set<string>();

  constructor(
    private readonly sessionId: string,
    private readonly eventIdFactory: () => string = () => crypto.randomUUID(),
  ) {}

  accept(source: TurnSourceEvent): CodeMuxRuntimeEvent[] {
    if (this.finished) return [];
    if (source.kind === 'assistant_message') {
      return [this.withSequence({
        type: 'assistant_message', session_id: this.sessionId, content: source.content,
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
      if (this.startedToolIds.has(source.toolUseId)) return [];
      this.startedToolIds.add(source.toolUseId);
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
    if (source.kind === 'error') {
      return [this.withSequence({
        type: 'error', session_id: this.sessionId, subtype: source.subtype,
        error: source.message, event_id: this.eventIdFactory(), sequence: 0,
      })];
    }
    return [];
  }

  finish(outcome: TurnOutcome): CodeMuxTurnEvent[] {
    if (this.finished) return [];
    this.finished = true;
    return [this.withSequence({
      type: 'turn_finished', session_id: this.sessionId, outcome: outcome.outcome,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(outcome.usage ? { usage: outcome.usage } : {}),
      ...(outcome.durationMs !== undefined ? { duration_ms: outcome.durationMs } : {}),
      event_id: this.eventIdFactory(), sequence: 0,
    })];
  }

  private withSequence<T extends CodeMuxRuntimeEvent>(event: T): T {
    return { ...event, sequence: this.sequence++ } as T;
  }
}
