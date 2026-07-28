import type { CodeMuxRuntimeEvent, CodeMuxTurnEvent } from './codeMuxProtocol.js';

export type TurnSourceEvent =
  | { kind: 'assistant_message'; content: Array<Record<string, unknown>> }
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
    return [this.withSequence({
      type: 'error', session_id: this.sessionId, subtype: source.subtype,
      error: source.message, event_id: this.eventIdFactory(), sequence: 0,
    })];
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
