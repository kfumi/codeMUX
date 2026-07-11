import { describe, expect, it } from 'vitest';
import { getOpenCodeEventIdentity, getOpenCodePayloadKey, toCodeMuxEvent, type OpenCodeEventContext } from './opencodeEvents.js';

function context(overrides: Partial<OpenCodeEventContext> = {}): OpenCodeEventContext {
  return { agentId: 'agent-1', sessionId: 'codemux-session-1', agentSessionId: 'opencode-session-1', sequence: 7, eventIdFactory: () => 'test-event-id', durationMs: 123, usage: { input_tokens: 10, output_tokens: 4, reasoning_output_tokens: 2, cached_input_tokens: 3, cache_write_input_tokens: 1 }, ...overrides };
}

describe('OpenCode event normalization', () => {
  it('converts text deltas into assistant events with complete routing metadata', () => {
    const events = toCodeMuxEvent({ type: 'message.part.updated', properties: { part: { id: 'part-1', sessionID: 'opencode-session-1', messageID: 'message-1', type: 'text', text: 'Hello' }, delta: 'Hello' } }, context());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'assistant', agent_id: 'agent-1', session_id: 'codemux-session-1', agent_session_id: 'opencode-session-1', opencode_session_id: 'opencode-session-1', sequence: 7, message: { content: [{ type: 'text', text: 'Hello' }] } });
  });
  it('converts tool running, completed, and error states', () => {
    const base = { id: 'tool-part-1', sessionID: 'opencode-session-1', messageID: 'message-1', type: 'tool', callID: 'call-1', tool: 'bash' };
    const started = toCodeMuxEvent({ type: 'message.part.updated', properties: { part: { ...base, state: { status: 'running', input: { command: 'pwd' } } } } }, context());
    const completed = toCodeMuxEvent({ type: 'message.part.updated', properties: { part: { ...base, state: { status: 'completed', input: { command: 'pwd' }, output: '/tmp', title: 'pwd', metadata: {}, time: { start: 1, end: 2 } } } } }, context({ sequence: 8 }));
    const failed = toCodeMuxEvent({ type: 'message.part.updated', properties: { part: { ...base, state: { status: 'error', input: { command: 'pwd' }, error: 'permission denied', time: { start: 1, end: 2 } } } } }, context({ sequence: 9 }));
    expect(started[0]).toMatchObject({ type: 'assistant', event_kind: 'tool_call', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'pwd' } }] } });
    expect(completed[0]).toMatchObject({ type: 'user', event_kind: 'tool_result', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '/tmp', is_error: false }] } });
    expect(failed[0]).toMatchObject({ type: 'user', event_kind: 'tool_result', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'permission denied', is_error: true }] } });
  });
  it('builds one unified result with all usage dimensions on session completion', () => {
    const events = toCodeMuxEvent({ type: 'session.idle', properties: { sessionID: 'opencode-session-1' } }, context());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'result', subtype: 'success', is_error: false, agent_id: 'agent-1', session_id: 'codemux-session-1', agent_session_id: 'opencode-session-1', sequence: 7, usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3, cache_write_input_tokens: 1, reasoning_output_tokens: 2 } });
  });
  it('normalizes SDK errors, interruptions, and permission requests without dropping them', () => {
    const error = toCodeMuxEvent({ type: 'session.error', properties: { sessionID: 'opencode-session-1', error: { name: 'UnknownError', data: { message: 'upstream down' } } } }, context());
    const interrupted = toCodeMuxEvent({ type: 'session.error', properties: { sessionID: 'opencode-session-1', error: { name: 'MessageAbortedError', data: { message: 'aborted' } } } }, context({ sequence: 9 }));
    const permission = toCodeMuxEvent({ type: 'permission.updated', properties: { id: 'permission-1', sessionID: 'opencode-session-1', messageID: 'message-1', type: 'read', title: 'Read file', metadata: { path: 'a.txt' }, time: { created: 1 } } }, context({ sequence: 11 }));
    expect(error).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'error', error: 'upstream down' }), expect.objectContaining({ type: 'result', subtype: 'error', is_error: true })]));
    expect(interrupted).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'error', subtype: 'interrupted' }), expect.objectContaining({ type: 'result', subtype: 'interrupted' })]));
    expect(permission[0]).toMatchObject({ type: 'diagnostic', subtype: 'permission_request' });
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
      expect.objectContaining({ type: 'result', agent_session_id: 'event-session', opencode_session_id: 'event-session' }),
    ]));
  });

  it('serializes structured tool output and suppresses terminal tool states supplied by context', () => {
    const completed = toCodeMuxEvent({ type: 'message.part.updated', properties: { part: { id: 'part-1', sessionID: 'opencode-session-1', messageID: 'message-1', type: 'tool', callID: 'call-1', tool: 'search', state: { status: 'completed', input: {}, output: { matches: ['a', 'b'] }, title: 'search', metadata: {}, time: { start: 1, end: 2 } } } } }, context());
    const lateRunning = toCodeMuxEvent({ type: 'message.part.updated', properties: { part: { id: 'part-1', sessionID: 'opencode-session-1', messageID: 'message-1', type: 'tool', callID: 'call-1', tool: 'search', state: { status: 'running', input: {} } } } }, context({ terminalToolIds: new Set(['call-1']) }));
    expect(completed[0]).toMatchObject({ message: { content: [{ content: '{"matches":["a","b"]}' }] } });
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
