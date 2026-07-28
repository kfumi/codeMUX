import { describe, expect, it } from 'vitest';
import { getOpenCodeEventIdentity, getOpenCodePayloadKey, toCodeMuxEvent, type OpenCodeEventContext } from './opencodeEvents.js';

function context(overrides: Partial<OpenCodeEventContext> = {}): OpenCodeEventContext {
  return { agentId: 'agent-1', sessionId: 'codemux-session-1', agentSessionId: 'opencode-session-1', sequence: 7, eventIdFactory: () => 'test-event-id', durationMs: 123, usage: { input_tokens: 10, output_tokens: 4, reasoning_output_tokens: 2, cached_input_tokens: 3, cache_write_input_tokens: 1 }, ...overrides };
}

describe('OpenCode event normalization', () => {
  it('converts text deltas into assistant events with complete routing metadata', () => {
    const events = toCodeMuxEvent({ type: 'message.part.updated', properties: { part: { id: 'part-1', sessionID: 'opencode-session-1', messageID: 'message-1', type: 'text', text: 'Hello' }, delta: 'Hello' } }, context());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'assistant_message', agent_id: 'agent-1', session_id: 'codemux-session-1', agent_session_id: 'opencode-session-1', opencode_session_id: 'opencode-session-1', sequence: 7, content: [{ type: 'text', text: 'Hello' }] });
  });
  it('does not expose text parts belonging to a user message as assistant output', () => {
    const userMessageUpdated = {
      type: 'message.updated',
      properties: {
        sessionID: 'opencode-session-1',
        info: { id: 'user-message-1', role: 'user' },
      },
    };
    const userPartUpdated = {
      type: 'message.part.updated',
      properties: {
        sessionID: 'opencode-session-1',
        part: { id: 'part-user-1', sessionID: 'opencode-session-1', messageID: 'user-message-1', type: 'text', text: 'the original prompt' },
        delta: 'the original prompt',
      },
    };

    expect(toCodeMuxEvent(userMessageUpdated, context())).toEqual([]);
    expect(toCodeMuxEvent(userPartUpdated, context({ assistantMessageIds: new Set(), userMessageIds: new Set(['user-message-1']) }))).toEqual([]);
  });
  it('converts tool running, completed, and error states', () => {
    const base = { id: 'tool-part-1', sessionID: 'opencode-session-1', messageID: 'message-1', type: 'tool', callID: 'call-1', tool: 'bash' };
    const started = toCodeMuxEvent({ type: 'message.part.updated', properties: { part: { ...base, state: { status: 'running', input: { command: 'pwd' } } } } }, context());
    const completed = toCodeMuxEvent({ type: 'message.part.updated', properties: { part: { ...base, state: { status: 'completed', input: { command: 'pwd' }, output: '/tmp', title: 'pwd', metadata: {}, time: { start: 1, end: 2 } } } } }, context({ sequence: 8 }));
    const failed = toCodeMuxEvent({ type: 'message.part.updated', properties: { part: { ...base, state: { status: 'error', input: { command: 'pwd' }, error: 'permission denied', time: { start: 1, end: 2 } } } } }, context({ sequence: 9 }));
    expect(started[0]).toMatchObject({
      type: 'tool_started', session_id: 'codemux-session-1', tool_use_id: 'call-1',
      name: 'bash', input: { command: 'pwd' }, event_id: 'test-event-id', sequence: 7,
    });
    expect(completed[0]).toMatchObject({
      type: 'tool_finished', session_id: 'codemux-session-1', tool_use_id: 'call-1',
      content: '/tmp', is_error: false, event_id: 'test-event-id', sequence: 8,
    });
    expect(failed[0]).toMatchObject({
      type: 'tool_finished', session_id: 'codemux-session-1', tool_use_id: 'call-1',
      content: 'permission denied', is_error: true, event_id: 'test-event-id', sequence: 9,
    });
  });
  it('builds one unified turn outcome with protocol usage on session completion', () => {
    const events = toCodeMuxEvent({ type: 'session.idle', properties: { sessionID: 'opencode-session-1' } }, context());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'turn_finished', outcome: 'completed', agent_id: 'agent-1', session_id: 'codemux-session-1', agent_session_id: 'opencode-session-1', sequence: 7, usage: { input_tokens: 10, output_tokens: 4, cached_input_tokens: 3, reasoning_output_tokens: 2 }, duration_ms: 123, event_id: 'test-event-id' });
    expect(events[0]).not.toHaveProperty('usage.cache_write_input_tokens');
  });
  it('converts compaction part to compact_boundary system event', () => {
    const autoCompaction = toCodeMuxEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: 'opencode-session-1',
        part: {
          id: 'prt_compaction',
          messageID: 'msg_compaction',
          sessionID: 'opencode-session-1',
          type: 'compaction',
          auto: true,
          overflow: false,
        },
      },
    }, context());
    expect(autoCompaction).toHaveLength(1);
    expect(autoCompaction[0]).toMatchObject({
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      compact_metadata: {
        trigger: 'auto',
        pre_tokens: 0,
        overflow: false,
      },
    });

    const manualCompaction = toCodeMuxEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: 'opencode-session-1',
        part: {
          id: 'prt_compaction_manual',
          messageID: 'msg_compaction_manual',
          sessionID: 'opencode-session-1',
          type: 'compaction',
          auto: false,
          overflow: true,
        },
      },
    }, context());
    expect(manualCompaction).toHaveLength(1);
    expect(manualCompaction[0]).toMatchObject({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: {
        trigger: 'manual',
        overflow: true,
      },
    });
  });

  it('normalizes SDK errors, interruptions, and permission requests without dropping them', () => {
    const error = toCodeMuxEvent({ type: 'session.error', properties: { sessionID: 'opencode-session-1', error: { name: 'UnknownError', data: { message: 'upstream down' } } } }, context());
    const interrupted = toCodeMuxEvent({ type: 'session.error', properties: { sessionID: 'opencode-session-1', error: { name: 'MessageAbortedError', data: { message: 'aborted' } } } }, context({ sequence: 9 }));
    const permission = toCodeMuxEvent({ type: 'permission.updated', properties: { id: 'permission-1', sessionID: 'opencode-session-1', messageID: 'message-1', type: 'read', title: 'Read file', metadata: { path: 'a.txt' }, time: { created: 1 } } }, context({ sequence: 11 }));
    expect(error).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'error', error: 'upstream down', event_id: 'test-event-id' }), expect.objectContaining({ type: 'turn_finished', outcome: 'failed', reason: 'upstream down' })]));
    expect(interrupted).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'error', subtype: 'interrupted', event_id: 'test-event-id' }), expect.objectContaining({ type: 'turn_finished', outcome: 'interrupted', reason: 'aborted' })]));
    expect(permission[0]).toMatchObject({
      type: 'permission_requested', request_id: 'permission-1', permission_id: 'permission-1',
      permission_type: 'read', description: 'Read file', metadata: { path: 'a.txt' },
    });
  });
  it('emits an interrupted outcome without an error for explicit session interruption', () => {
    const events = toCodeMuxEvent({ type: 'session.aborted', properties: { sessionID: 'opencode-session-1' } }, context());
    expect(events).toEqual([expect.objectContaining({
      type: 'turn_finished', outcome: 'interrupted', reason: 'OpenCode session interrupted by user', event_id: 'test-event-id',
    })]);
  });
  it('returns a diagnostic for unknown events and exposes a stable identity for deduplication', () => {
    const event = { type: 'future.event', id: 'event-1', properties: { value: 1 } };
    const first = toCodeMuxEvent(event, context());
    const second = toCodeMuxEvent(event, context({ seenEventIds: new Set([getOpenCodeEventIdentity(event)]) }));
    expect(first[0]).toMatchObject({ type: 'diagnostic', subtype: 'unknown_event' });
    expect(second).toEqual([]);
    expect(getOpenCodeEventIdentity(event)).toBe(getOpenCodeEventIdentity(event));
  });

  it('uses the event session ID for terminal metadata when context has none', () => {
    const events = toCodeMuxEvent({ type: 'session.error', properties: { sessionID: 'event-session', error: { name: 'UnknownError', data: { message: 'failed' } } } }, context({ agentSessionId: undefined }));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'error', agent_session_id: 'event-session', opencode_session_id: 'event-session' }),
      expect.objectContaining({ type: 'turn_finished', agent_session_id: 'event-session', opencode_session_id: 'event-session' }),
    ]));
  });

  it('serializes structured tool output and suppresses terminal tool states supplied by context', () => {
    const completed = toCodeMuxEvent({ type: 'message.part.updated', properties: { part: { id: 'part-1', sessionID: 'opencode-session-1', messageID: 'message-1', type: 'tool', callID: 'call-1', tool: 'search', state: { status: 'completed', input: {}, output: { matches: ['a', 'b'] }, title: 'search', metadata: {}, time: { start: 1, end: 2 } } } } }, context());
    const lateRunning = toCodeMuxEvent({ type: 'message.part.updated', properties: { part: { id: 'part-1', sessionID: 'opencode-session-1', messageID: 'message-1', type: 'tool', callID: 'call-1', tool: 'search', state: { status: 'running', input: {} } } } }, context({ terminalToolIds: new Set(['call-1']) }));
    expect(completed[0]).toMatchObject({
      type: 'tool_finished', tool_use_id: 'call-1', content: '{"matches":["a","b"]}', is_error: false,
    });
    expect(lateRunning).toEqual([]);
  });

  it('replays identical conversion output with an injected event ID factory', () => {
    const event = { type: 'message.part.updated', properties: { sessionID: 'opencode-session-1', part: { id: 'part-1', type: 'text' }, delta: 'stable' } };
    const deterministicContext = context({ eventIdFactory: () => 'fixed-event-id' });
    expect(toCodeMuxEvent(event, deterministicContext)).toEqual(toCodeMuxEvent(event, deterministicContext));
  });

  it('diagnoses session-scoped events without an explicit session ID', () => {
    const events = toCodeMuxEvent({ type: 'message.part.updated', properties: { part: { id: 'part-1', type: 'text' }, delta: 'orphaned' } }, context());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'diagnostic', subtype: 'missing_session_id' });
  });
  it('deduplicates identical non-terminal payloads without dropping changed increments', () => {
    const first = { type: 'message.part.updated', properties: { sessionID: 'opencode-session-1', part: { id: 'part-1', type: 'text' }, delta: 'first' } };
    const replay = { type: 'message.part.updated', properties: { sessionID: 'opencode-session-1', part: { id: 'part-1', type: 'text' }, delta: 'first' } };
    const second = { type: 'message.part.updated', properties: { sessionID: 'opencode-session-1', part: { id: 'part-1', type: 'text' }, delta: 'second' } };
    const replayKey = getOpenCodePayloadKey(replay);
    expect(replayKey).toBe(getOpenCodePayloadKey(first));
    expect(getOpenCodePayloadKey(second)).not.toBe(replayKey);
    expect(toCodeMuxEvent(replay, context({ seenPayloadKeys: new Set([replayKey!]) }))).toEqual([]);
    expect(toCodeMuxEvent(second, context({ seenPayloadKeys: new Set([replayKey!]) }))).toHaveLength(1);
  });

  it('distinguishes oversized payloads that differ only in their tail', () => {
    const prefix = 'x'.repeat(70_000);
    const first = { type: 'future.event', properties: { sessionID: 'opencode-session-1', value: `${prefix}a` } };
    const second = { type: 'future.event', properties: { sessionID: 'opencode-session-1', value: `${prefix}b` } };
    const firstKey = getOpenCodePayloadKey(first);
    expect(getOpenCodePayloadKey(second)).not.toBe(firstKey);
    expect(toCodeMuxEvent(second, context({ seenPayloadKeys: new Set([firstKey]) }))).toHaveLength(1);
    expect(toCodeMuxEvent(first, context({ seenPayloadKeys: new Set([firstKey]) }))).toEqual([]);
  });
  it('bounds payload replay keys for oversized events', () => {
    const event = { type: 'future.event', properties: { sessionID: 'opencode-session-1', value: 'x'.repeat(200_000) } };
    const key = getOpenCodePayloadKey(event);
    expect(Buffer.byteLength(key, 'utf8')).toBeLessThan(512);
  });
  it('deduplicates identical unknown diagnostics by stable payload', () => {
    const event = { type: 'future.event', properties: { sessionID: 'opencode-session-1', value: { b: 2, a: 1 } } };
    const key = getOpenCodePayloadKey(event);
    expect(toCodeMuxEvent(event, context({ seenPayloadKeys: new Set([key!]) }))).toEqual([]);
  });
  describe('streaming via message.part.delta', () => {
    function streamingContext(overrides: Partial<OpenCodeEventContext> = {}): OpenCodeEventContext {
      return context({
        streamingParts: new Map(),
        nextSection: { kind: 'idle' },
        idleStreamKind: { kind: 'thinking' },
        ...overrides,
      });
    }

    it('streams field=text as thinking when nextSection is unknown (pre-reasoning-complete)', () => {
      const ctx = streamingContext();
      const first = toCodeMuxEvent({
        type: 'message.part.delta',
        properties: { sessionID: 'opencode-session-1', partID: 'part-1', messageID: 'msg-1', field: 'text', delta: 'Hel' },
      }, ctx);
      expect(first).toHaveLength(2);
      expect(first[0]).toMatchObject({ event: { type: 'content_block_start', content_block: { type: 'thinking', thinking: '' } } });
      expect(first[1]).toMatchObject({ event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Hel' } } });
      const second = toCodeMuxEvent({
        type: 'message.part.delta',
        properties: { sessionID: 'opencode-session-1', partID: 'part-1', messageID: 'msg-1', field: 'text', delta: 'lo' },
      }, ctx);
      expect(second).toHaveLength(1);
      expect(second[0]).toMatchObject({ event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'lo' } } });
    });

    it('flushes buffered field=text as assistant on message.part.updated for text type', () => {
      const parts = new Map<string, any>();
      parts.set('part-1', { kind: 'text', index: -1, started: false, buffered: true, deltaText: ['Hel', 'lo'] });
      const events = toCodeMuxEvent({
        type: 'message.part.updated',
        properties: { sessionID: 'opencode-session-1', part: { id: 'part-1', messageID: 'msg-1', sessionID: 'opencode-session-1', type: 'text', text: 'Hello' } },
      }, streamingContext({ streamingParts: parts }));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'assistant_message', content: [{ type: 'text', text: 'Hello' }] });
    });

    it('streams field=text as thinking then reclassifies on part.updated type=reasoning', () => {
      const parts = new Map<string, any>();
      const idleStreamKind = { kind: 'thinking' as const };
      const ctx = streamingContext({ streamingParts: parts, idleStreamKind });
      const first = toCodeMuxEvent({
        type: 'message.part.delta',
        properties: { sessionID: 'opencode-session-1', partID: 'prt-1', messageID: 'msg-1', field: 'text', delta: 'ap' },
      }, ctx);
      expect(first).toHaveLength(2);
      expect(first[0]).toMatchObject({ event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } });
      expect(first[1]).toMatchObject({ event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'ap' } } });

      const second = toCodeMuxEvent({
        type: 'message.part.delta',
        properties: { sessionID: 'opencode-session-1', partID: 'prt-1', messageID: 'msg-1', field: 'text', delta: 'prove.' },
      }, ctx);
      expect(second).toHaveLength(1);
      expect(second[0]).toMatchObject({ event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'prove.' } } });

      const done = toCodeMuxEvent({
        type: 'message.part.updated',
        properties: { sessionID: 'opencode-session-1', part: { id: 'prt-1', messageID: 'msg-1', sessionID: 'opencode-session-1', type: 'reasoning', text: 'approve.' } },
      }, ctx);
      expect(done).toHaveLength(2);
      expect(done[0]).toMatchObject({ event: { type: 'content_block_stop', index: 0 } });
      expect(done[1]).toMatchObject({ type: 'assistant_message', content: [{ type: 'thinking', thinking: 'approve.' }] });
      // Reasoning finalization must NOT flip idleStreamKind to 'text':
      // OpenCode may emit multiple reasoning parts in one turn.
      expect(idleStreamKind.kind).toBe('thinking');
    });

    it('uses part.updated type when part.updated arrives before part.delta (reasoning)', () => {
      // Reproduces user-reported scenario: OpenCode emits message.part.updated
      // (type=reasoning, text="") as a start marker BEFORE message.part.delta.
      // The delta must stream as thinking_delta, not text_delta.
      const parts = new Map<string, any>();
      const idleStreamKind = { kind: 'thinking' as const };
      const ctx = streamingContext({ streamingParts: parts, idleStreamKind });

      const start = toCodeMuxEvent({
        type: 'message.part.updated',
        properties: { sessionID: 'opencode-session-1', part: { id: 'prt-reason-1', messageID: 'msg-1', sessionID: 'opencode-session-1', type: 'reasoning', text: '', time: { start: 1 } } },
      }, ctx);
      expect(start).toHaveLength(0);
      expect(idleStreamKind.kind).toBe('thinking');

      const delta = toCodeMuxEvent({
        type: 'message.part.delta',
        properties: { sessionID: 'opencode-session-1', partID: 'prt-reason-1', messageID: 'msg-1', field: 'text', delta: 'Let' },
      }, ctx);
      expect(delta).toHaveLength(2);
      expect(delta[0]).toMatchObject({ event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } });
      expect(delta[1]).toMatchObject({ event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let' } } });
    });

    it('uses part.updated type=text when part.updated arrives before part.delta (text)', () => {
      // After a reasoning part, a text part's part.updated(type=text, text="")
      // arrives first; its delta must stream as text_delta.
      const parts = new Map<string, any>();
      const idleStreamKind = { kind: 'thinking' as const };
      const ctx = streamingContext({ streamingParts: parts, idleStreamKind });

      // Reasoning part lifecycle
      toCodeMuxEvent({
        type: 'message.part.updated',
        properties: { sessionID: 'opencode-session-1', part: { id: 'prt-reason-1', messageID: 'msg-1', sessionID: 'opencode-session-1', type: 'reasoning', text: '', time: { start: 1 } } },
      }, ctx);
      toCodeMuxEvent({
        type: 'message.part.delta',
        properties: { sessionID: 'opencode-session-1', partID: 'prt-reason-1', messageID: 'msg-1', field: 'text', delta: 'reasoning...' },
      }, ctx);
      toCodeMuxEvent({
        type: 'message.part.updated',
        properties: { sessionID: 'opencode-session-1', part: { id: 'prt-reason-1', messageID: 'msg-1', sessionID: 'opencode-session-1', type: 'reasoning', text: 'reasoning...', time: { start: 1, end: 2 } } },
      }, ctx);
      expect(idleStreamKind.kind).toBe('thinking');

      // Text part: start marker arrives first
      const textStart = toCodeMuxEvent({
        type: 'message.part.updated',
        properties: { sessionID: 'opencode-session-1', part: { id: 'prt-text-1', messageID: 'msg-1', sessionID: 'opencode-session-1', type: 'text', text: '', time: { start: 3 } } },
      }, ctx);
      expect(textStart).toHaveLength(0);
      expect(idleStreamKind.kind).toBe('text');

      const textDelta = toCodeMuxEvent({
        type: 'message.part.delta',
        properties: { sessionID: 'opencode-session-1', partID: 'prt-text-1', messageID: 'msg-1', field: 'text', delta: '以下是' },
      }, ctx);
      expect(textDelta).toHaveLength(2);
      expect(textDelta[0]).toMatchObject({ event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } });
      expect(textDelta[1]).toMatchObject({ event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '以下是' } } });
    });

    it('streams field=text as answer text after reasoning is finalized', () => {
      const parts = new Map<string, any>();
      const idleStreamKind = { kind: 'text' as const };
      const ctx = streamingContext({ streamingParts: parts, idleStreamKind });
      const first = toCodeMuxEvent({
        type: 'message.part.delta',
        properties: { sessionID: 'opencode-session-1', partID: 'ans-1', messageID: 'msg-2', field: 'text', delta: 'Hi' },
      }, ctx);
      expect(first).toHaveLength(2);
      expect(first[0]).toMatchObject({ event: { type: 'content_block_start', content_block: { type: 'text', text: '' } } });
      expect(first[1]).toMatchObject({ event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } });
    });

    it('emits assistant event on message.part.updated when part was NOT streamed', () => {
      const events = toCodeMuxEvent({
        type: 'message.part.updated',
        properties: { sessionID: 'opencode-session-1', part: { id: 'part-1', messageID: 'msg-1', sessionID: 'opencode-session-1', type: 'text', text: 'Hello' } },
      }, streamingContext());
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'assistant_message' });
      expect(events[0]).not.toHaveProperty('event');
    });

    it('supports thinking content blocks via message.part.delta field=reasoning', () => {
      const parts = new Map<string, { kind: 'text' | 'thinking'; index: number; started: boolean }>();
      const ctx = streamingContext({ streamingParts: parts });
      const first = toCodeMuxEvent({
        type: 'message.part.delta',
        properties: { sessionID: 'opencode-session-1', partID: 'part-think', messageID: 'msg-1', field: 'reasoning', delta: '思考' },
      }, ctx);
      expect(first).toHaveLength(2);
      expect(first[0]).toMatchObject({ event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } });
      expect(first[1]).toMatchObject({ event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '思考' } } });

      const second = toCodeMuxEvent({
        type: 'message.part.delta',
        properties: { sessionID: 'opencode-session-1', partID: 'part-think', messageID: 'msg-1', field: 'reasoning', delta: '中' },
      }, ctx);
      expect(second).toHaveLength(1);
      expect(second[0]).toMatchObject({ event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '中' } } });

      const stop = toCodeMuxEvent({
        type: 'message.part.updated',
        properties: { sessionID: 'opencode-session-1', part: { id: 'part-think', messageID: 'msg-1', sessionID: 'opencode-session-1', type: 'reasoning', text: '思考中' } },
      }, ctx);
      expect(stop).toHaveLength(2);
      expect(stop[0]).toMatchObject({ event: { type: 'content_block_stop', index: 0 } });
      expect(stop[1]).toMatchObject({ type: 'assistant_message', content: [{ type: 'thinking', thinking: '思考中' }] });
    });

    it('produces no events when streamingParts is absent from context', () => {
      const events = toCodeMuxEvent({
        type: 'message.part.delta',
        properties: { sessionID: 'opencode-session-1', partID: 'part-1', messageID: 'msg-1', field: 'text', delta: 'Hello' },
      }, context());
      expect(events).toHaveLength(0);
    });

    it('does not affect tool part handling in message.part.updated', () => {
      const parts = new Map<string, { kind: 'text' | 'thinking'; index: number; started: boolean }>();
      const events = toCodeMuxEvent({
        type: 'message.part.updated',
        properties: { sessionID: 'opencode-session-1', part: { id: 'tool-part-1', messageID: 'msg-1', sessionID: 'opencode-session-1', type: 'tool', callID: 'call-1', tool: 'bash', state: { status: 'running', input: { command: 'pwd' } } } },
      }, streamingContext({ streamingParts: parts }));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'tool_started', tool_use_id: 'call-1', name: 'bash' });
    });

    it('emits thinking_delta stream events from session.next.reasoning.delta', () => {
      const parts = new Map<string, any>();
      const ctx = streamingContext({ streamingParts: parts });
      const started = toCodeMuxEvent({
        type: 'session.next.reasoning.started',
        properties: { sessionID: 'opencode-session-1', reasoningID: 'rn-1', assistantMessageID: 'msg-1', timestamp: 1000 },
      }, ctx);
      expect(started).toHaveLength(0);

      const delta = toCodeMuxEvent({
        type: 'session.next.reasoning.delta',
        properties: { sessionID: 'opencode-session-1', reasoningID: 'rn-1', assistantMessageID: 'msg-1', delta: 'thinking...', timestamp: 1001 },
      }, ctx);
      expect(delta).toHaveLength(2);
      expect(delta[0]).toMatchObject({ event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } });
      expect(delta[1]).toMatchObject({ event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thinking...' } } });

      const delta2 = toCodeMuxEvent({
        type: 'session.next.reasoning.delta',
        properties: { sessionID: 'opencode-session-1', reasoningID: 'rn-1', assistantMessageID: 'msg-1', delta: ' more', timestamp: 1002 },
      }, ctx);
      expect(delta2).toHaveLength(1);
      expect(delta2[0]).toMatchObject({ event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' more' } } });
    });

    it('message.part.delta field:text skips buffering for parts pre-registered by reasoning.started', () => {
      const parts = new Map<string, any>();
      const ctx = streamingContext({ streamingParts: parts });
      toCodeMuxEvent({
        type: 'session.next.reasoning.started',
        properties: { sessionID: 'opencode-session-1', reasoningID: 'rn-1', assistantMessageID: 'msg-1', timestamp: 1000 },
      }, ctx);
      const delta = toCodeMuxEvent({
        type: 'message.part.delta',
        properties: { sessionID: 'opencode-session-1', partID: 'rn-1', messageID: 'msg-1', field: 'text', delta: 'Hello' },
      }, ctx);
      expect(delta).toHaveLength(0);
      const partState = parts.get('rn-1');
      expect(partState?.buffered).toBeUndefined();
      expect(partState?.deltaText?.length ?? 0).toBe(0);
    });

    it('message.part.updated handles parts streamed via reasoning.delta', () => {
      const parts = new Map<string, any>();
      const ctx = streamingContext({ streamingParts: parts });
      toCodeMuxEvent({
        type: 'session.next.reasoning.started',
        properties: { sessionID: 'opencode-session-1', reasoningID: 'rn-1', assistantMessageID: 'msg-1', timestamp: 1000 },
      }, ctx);
      toCodeMuxEvent({
        type: 'session.next.reasoning.delta',
        properties: { sessionID: 'opencode-session-1', reasoningID: 'rn-1', assistantMessageID: 'msg-1', delta: 'thinking...', timestamp: 1001 },
      }, ctx);
      const updated = toCodeMuxEvent({
        type: 'message.part.updated',
        properties: { sessionID: 'opencode-session-1', part: { id: 'rn-1', messageID: 'msg-1', sessionID: 'opencode-session-1', type: 'reasoning', text: 'thinking...' } },
      }, ctx);
      expect(updated).toHaveLength(2);
      expect(updated[0]).toMatchObject({ event: { type: 'content_block_stop', index: 0 } });
      expect(updated[1]).toMatchObject({ type: 'assistant_message', content: [{ type: 'thinking', thinking: 'thinking...' }] });
    });

    it('session.next.reasoning.delta continues a pre-existing thinking stream from field=text', () => {
      const parts = new Map<string, any>();
      const ctx = streamingContext({ streamingParts: parts });
      toCodeMuxEvent({
        type: 'message.part.delta',
        properties: { sessionID: 'opencode-session-1', partID: 'rn-1', messageID: 'msg-1', field: 'text', delta: 'thinking...' },
      }, ctx);
      expect(parts.get('rn-1')?.kind).toBe('thinking');
      expect(parts.get('rn-1')?.started).toBe(true);

      const delta = toCodeMuxEvent({
        type: 'session.next.reasoning.delta',
        properties: { sessionID: 'opencode-session-1', reasoningID: 'rn-1', assistantMessageID: 'msg-1', delta: ' more', timestamp: 1001 },
      }, ctx);
      expect(delta.length).toBeGreaterThanOrEqual(1);
      expect(parts.get('rn-1')?.kind).toBe('thinking');
    });

    it('session.next.reasoning.ended does not emit events', () => {
      const events = toCodeMuxEvent({
        type: 'session.next.reasoning.ended',
        properties: { sessionID: 'opencode-session-1', reasoningID: 'rn-1', assistantMessageID: 'msg-1', text: 'done', timestamp: 1002 },
      }, streamingContext());
      expect(events).toHaveLength(0);
    });

    it('assigns incrementing content block indices for multiple streamed parts', () => {
      const parts = new Map<string, { kind: 'text' | 'thinking'; index: number; started: boolean }>();
      const ctx = streamingContext({ streamingParts: parts });
      const think = toCodeMuxEvent({
        type: 'message.part.delta',
        properties: { sessionID: 'opencode-session-1', partID: 'think-1', messageID: 'msg-1', field: 'reasoning', delta: 'reason...' },
      }, ctx);
      expect(think[0]).toMatchObject({ event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } });

      // Simulate post-reasoning phase for answer text streaming.
      if (ctx.idleStreamKind) ctx.idleStreamKind.kind = 'text';
      const text = toCodeMuxEvent({
        type: 'message.part.delta',
        properties: { sessionID: 'opencode-session-1', partID: 'text-1', messageID: 'msg-1', field: 'text', delta: 'Hello' },
      }, ctx);
      expect(text).toHaveLength(2);
      expect(text[0]).toMatchObject({ event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } });
      expect(text[1]).toMatchObject({ event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } } });

      const thinkStop = toCodeMuxEvent({
        type: 'message.part.updated',
        properties: { sessionID: 'opencode-session-1', part: { id: 'think-1', messageID: 'msg-1', sessionID: 'opencode-session-1', type: 'reasoning', text: 'reason...' } },
      }, ctx);
      expect(thinkStop[0]).toMatchObject({ event: { type: 'content_block_stop', index: 0 } });
      expect(thinkStop[1]).toMatchObject({ type: 'assistant_message', content: [{ type: 'thinking', thinking: 'reason...' }] });

      const textStop = toCodeMuxEvent({
        type: 'message.part.updated',
        properties: { sessionID: 'opencode-session-1', part: { id: 'text-1', messageID: 'msg-1', sessionID: 'opencode-session-1', type: 'text', text: 'Hello' } },
      }, ctx);
      expect(textStop).toHaveLength(2);
      expect(textStop[0]).toMatchObject({ event: { type: 'content_block_stop', index: 1 } });
      expect(textStop[1]).toMatchObject({ type: 'assistant_message', content: [{ type: 'text', text: 'Hello' }] });
    });
  });

  it('uses a stable session and turn key when a terminal event has no provider event ID', () => {
    const first = { type: 'session.idle', properties: { sessionID: 'opencode-session-1', turnID: 'turn-1', noise: 'first' } };
    const replay = { type: 'session.idle', properties: { sessionID: 'opencode-session-1', turnID: 'turn-1', noise: 'replay' } };
    const second = { type: 'session.idle', properties: { sessionID: 'opencode-session-1', turnID: 'turn-2' } };
    expect(getOpenCodeEventIdentity(first, 1)).toBe(getOpenCodeEventIdentity(replay, 1));
    expect(getOpenCodeEventIdentity(first, 1)).not.toBe(getOpenCodeEventIdentity(second, 2));
    expect(getOpenCodeEventIdentity({ type: 'session.idle', id: 'provider-1', properties: { sessionID: 'opencode-session-1', noise: 'first' } })).toBe(getOpenCodeEventIdentity({ type: 'session.idle', id: 'provider-1', properties: { sessionID: 'opencode-session-1', noise: 'replay' } }));
    expect(toCodeMuxEvent(first, context())).toHaveLength(1);
    expect(toCodeMuxEvent(second, context())).toHaveLength(1);
    const idle = { type: 'session.idle', properties: { sessionID: 'opencode-session-1' } };
    expect(getOpenCodeEventIdentity(idle, 1)).not.toBe(getOpenCodeEventIdentity(idle, 2));
    expect(toCodeMuxEvent(idle, context({ turnId: 1 }))).toHaveLength(1);
    expect(toCodeMuxEvent(idle, context({ turnId: 2 }))).toHaveLength(1);
  });
});
