import { describe, expect, it } from 'vitest';
import { getOpenCodeEventIdentity, toCodeMuxEvent, type OpenCodeEventContext } from './opencodeEvents.js';

function context(overrides: Partial<OpenCodeEventContext> = {}): OpenCodeEventContext {
  return { agentId: 'agent-1', sessionId: 'codemux-session-1', agentSessionId: 'opencode-session-1', sequence: 7, durationMs: 123, usage: { input_tokens: 10, output_tokens: 4, reasoning_output_tokens: 2, cached_input_tokens: 3, cache_write_input_tokens: 1 }, ...overrides };
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
    const event = { type: 'future.event', properties: { id: 'event-1', value: 1 } };
    const first = toCodeMuxEvent(event, context());
    const second = toCodeMuxEvent(event, context({ seenEventIds: new Set([getOpenCodeEventIdentity(event)]) }));
    expect(first[0]).toMatchObject({ type: 'diagnostic', subtype: 'unknown_event' });
    expect(second).toEqual([]);
    expect(getOpenCodeEventIdentity(event)).toBe(getOpenCodeEventIdentity(event));
  });
});
