import { describe, expect, it } from 'vitest';
import { getOpenCodeEventIdentity, getOpenCodePayloadKey, toCodeMuxEvent, type OpenCodeEventContext } from './opencodeEvents.js';

function context(overrides: Partial<OpenCodeEventContext> = {}): OpenCodeEventContext {
  return { agentId: 'agent-1', sessionId: 'codemux-session-1', agentSessionId: 'opencode-session-1', sequence: 7, eventIdFactory: () => 'test-event-id', durationMs: 123, ...overrides };
}

describe('OpenCode event normalization', () => {
  it('converts text deltas into assistant events with complete routing metadata', () => {
    const events = toCodeMuxEvent({ type: 'message.part.updated', properties: { part: { id: 'part-1', sessionID: 'opencode-session-1', messageID: 'message-1', type: 'text', text: 'Hello' }, delta: 'Hello' } }, context());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'assistant_message', agent_id: 'agent-1', session_id: 'codemux-session-1', agent_session_id: 'opencode-session-1', opencode_session_id: 'opencode-session-1', provider_message_id: 'message-1', sequence: 7, content: [{ type: 'text', text: 'Hello' }] });
  });
  it('routes streaming events through the CodeMUX session instead of the native session', () => {
    const events = toCodeMuxEvent({
      type: 'message.part.delta',
      properties: {
        sessionID: 'opencode-session-1',
        partID: 'part-stream-1',
        messageID: 'message-1',
        field: 'text',
        delta: 'Hello',
      },
    }, context({
      streamingParts: new Map(),
      nextSection: { kind: 'idle' },
      idleStreamKind: { kind: 'text' },
    }));

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'content_started', session_id: 'codemux-session-1' });
    expect(events[1]).toMatchObject({ type: 'text_delta', session_id: 'codemux-session-1' });
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
  it('does not emit assistant text for whitespace-only OpenCode parts', () => {
    const events = toCodeMuxEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-blank-1',
          sessionID: 'opencode-session-1',
          messageID: 'message-1',
          type: 'text',
          text: '\n\n',
        },
      },
    }, context());
    expect(events).toEqual([]);
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
  it('converts OpenCode file summaries into a renderable session summary', () => {
    const events = toCodeMuxEvent({
      type: 'message.updated',
      properties: {
        sessionID: 'opencode-session-1',
        info: {
          role: 'user',
          summary: {
            diffs: [{
              file: 'index.html',
              patch: '--- index.html\n+++ index.html\n@@\n-old\n+new',
              additions: 1,
              deletions: 1,
            }],
          },
        },
      },
    }, context());

    expect(events).toEqual([expect.objectContaining({
      type: 'system_event',
      subtype: 'session_summary',
      diffs: [{ file: 'index.html', additions: 1, deletions: 1, patch: expect.stringContaining('+new') }],
    })]);
  });

  it('converts a non-empty session.diff into a session summary and ignores empty file notifications', () => {
    const diff = toCodeMuxEvent({
      type: 'session.diff',
      properties: {
        sessionID: 'opencode-session-1',
        diff: [{ file: 'index.html', before: 'old\n', after: 'new\n', additions: 1, deletions: 1 }],
      },
    }, context());
    const edited = toCodeMuxEvent({ type: 'file.edited', properties: { file: 'index.html' } }, context());

    expect(diff[0]).toMatchObject({ type: 'system_event', subtype: 'session_summary', diffs: [{ file: 'index.html', before: 'old\n', after: 'new\n' }] });
    expect(edited).toEqual([]);
  });
  it('builds one unified turn outcome on session completion', () => {
    const events = toCodeMuxEvent({ type: 'session.idle', properties: { sessionID: 'opencode-session-1' } }, context());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'turn_finished', outcome: 'completed', agent_id: 'agent-1', session_id: 'codemux-session-1', agent_session_id: 'opencode-session-1', sequence: 7, duration_ms: 123, event_id: 'test-event-id' });
    expect(events[0]).not.toHaveProperty('usage');
  });
  it('silently ignores OpenCode heartbeat events', () => {
    expect(toCodeMuxEvent({ type: 'server.heartbeat', properties: {} }, context())).toEqual([]);
  });
  it('preserves OpenCode multiple-choice question semantics', () => {
    const events = toCodeMuxEvent({
      type: 'question.asked',
      properties: {
        id: 'question-1',
        questions: [{
          question: '选择功能',
          header: '功能',
          multiple: true,
          options: [{ label: 'A', description: '选项 A' }, { label: 'B' }],
        }],
      },
    }, context());

    expect(events[0]).toMatchObject({
      type: 'user_input_requested',
      questions: [{
        question: '选择功能',
        header: '功能',
        multiSelect: true,
        options: [{ label: 'A', description: '选项 A' }, { label: 'B' }],
      }],
    });
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
      type: 'system_event',
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
      type: 'system_event',
      subtype: 'compact_boundary',
      compact_metadata: {
        trigger: 'manual',
        overflow: true,
      },
    });
  });

  it('keeps a compaction part even when it belongs to a known user message', () => {
    const events = toCodeMuxEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: 'opencode-session-1',
        part: {
          id: 'prt_compaction_user',
          messageID: 'msg_user',
          sessionID: 'opencode-session-1',
          type: 'compaction',
          auto: true,
          overflow: false,
        },
      },
    }, context({ userMessageIds: new Set(['msg_user']) }));

    expect(events).toEqual([
      expect.objectContaining({
        type: 'system_event',
        subtype: 'compact_boundary',
      }),
    ]);
    const sessionCompacted = toCodeMuxEvent({
      type: 'session.compacted',
      properties: { sessionID: 'opencode-session-1' },
    }, context());
    expect(sessionCompacted).toEqual([
      expect.objectContaining({
        type: 'system_event',
        subtype: 'compact_boundary',
      }),
    ]);
  });

  it('deduplicates a session.compacted notification after its compaction part', () => {
    const compactionBoundarySessionIds = new Set<string>();
    const compactionPart = toCodeMuxEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: 'opencode-session-1',
        part: {
          id: 'prt_compaction_dedup',
          messageID: 'msg_compaction_dedup',
          sessionID: 'opencode-session-1',
          type: 'compaction',
          auto: true,
        },
      },
    }, context({ compactionBoundarySessionIds }));
    const sessionCompacted = toCodeMuxEvent({
      type: 'session.compacted',
      properties: { sessionID: 'opencode-session-1' },
    }, context({ compactionBoundarySessionIds }));

    expect(compactionPart).toHaveLength(1);
    expect(sessionCompacted).toEqual([]);
  });

  it('does not surface compaction summary assistant parts as chat output', () => {
    const compactionSummaryMessageIds = new Set(['compaction-summary-1']);
    const reasoningPart = toCodeMuxEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: 'opencode-session-1',
        part: {
          id: 'part-compaction-reasoning',
          messageID: 'compaction-summary-1',
          sessionID: 'opencode-session-1',
          type: 'reasoning',
          text: 'Objective: summarize context',
        },
      },
    }, context({ compactionSummaryMessageIds }));
    const textDelta = toCodeMuxEvent({
      type: 'message.part.delta',
      properties: {
        sessionID: 'opencode-session-1',
        messageID: 'compaction-summary-1',
        partID: 'part-compaction-text',
        field: 'text',
        delta: 'Important details from compaction',
      },
    }, context({
      compactionSummaryMessageIds,
      streamingParts: new Map(),
      nextSection: { kind: 'idle' },
      idleStreamKind: { kind: 'text' },
    }));

    expect(reasoningPart).toEqual([]);
    expect(textDelta).toEqual([]);
  });

  it('converts V2 native compaction lifecycle events into a compact boundary', () => {
    const started = toCodeMuxEvent({
      type: 'session.next.compaction.started',
      properties: { sessionID: 'opencode-session-1', reason: 'manual' },
    }, context());
    const ended = toCodeMuxEvent({
      type: 'session.next.compaction.ended',
      properties: { sessionID: 'opencode-session-1', reason: 'manual' },
    }, context({ sequence: 8 }));

    expect(started[0]).toMatchObject({
      type: 'system_event',
      subtype: 'status',
      status: 'compacting',
    });
    expect(ended[0]).toMatchObject({
      type: 'system_event',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 0 },
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

  it('normalizes the permission.asked event emitted by current OpenCode runtimes', () => {
    const permission = toCodeMuxEvent({
      type: 'permission.asked',
      properties: {
        id: 'permission-asked-1',
        sessionID: 'opencode-session-1',
        permission: 'external_directory',
        metadata: { filepath: 'C:\\Users\\user\\.agents' },
        patterns: ['C:\\Users\\user\\.agents\\**'],
        always: ['*'],
        tool: { messageID: 'message-1', callID: 'call-1' },
      },
    }, context());

    expect(permission).toEqual([expect.objectContaining({
      type: 'permission_requested',
      request_id: 'permission-asked-1',
      permission_id: 'permission-asked-1',
      permission_type: 'external_directory',
      description: 'external_directory',
      metadata: {
        filepath: 'C:\\Users\\user\\.agents',
        patterns: ['C:\\Users\\user\\.agents\\**'],
        always: ['*'],
        tool: { messageID: 'message-1', callID: 'call-1' },
      },
    })]);
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

    it('flushes streamed narration before tool events and supersedes it on late finalization', () => {
      // Live-order regression: OpenCode can finalize a text part AFTER tool
      // parts of the same message. The narration must be committed before the
      // tool events, and the late finalization must replace it in place.
      const ctx = streamingContext();

      // 1. Narration streams via deltas (no envelope yet).
      toCodeMuxEvent({
        type: 'message.part.updated',
        properties: { sessionID: 'opencode-session-1', part: { id: 'txt-1', messageID: 'msg-1', sessionID: 'opencode-session-1', type: 'text', text: '' } },
      }, ctx);
      toCodeMuxEvent({
        type: 'message.part.delta',
        properties: { sessionID: 'opencode-session-1', partID: 'txt-1', messageID: 'msg-1', field: 'text', delta: '关键在 canReuse——' },
      }, ctx);

      // 2. Tool part updates arrive before the text part finalizes.
      const toolPending = toCodeMuxEvent({
        type: 'message.part.updated',
        properties: { sessionID: 'opencode-session-1', part: { id: 'tool-1', messageID: 'msg-1', sessionID: 'opencode-session-1', type: 'tool', callID: 'call-1', tool: 'bash', state: { status: 'pending', input: {} } } },
      }, ctx);
      const assistantIndex = toolPending.findIndex((event) => event.type === 'assistant_message');
      const toolIndex = toolPending.findIndex((event) => event.type === 'tool_started');
      expect(assistantIndex).toBeGreaterThanOrEqual(0);
      expect(toolIndex).toBeGreaterThanOrEqual(0);
      expect(assistantIndex).toBeLessThan(toolIndex);
      expect(toolPending.find((event) => event.type === 'assistant_message')).toMatchObject({
        provider_message_id: 'msg-1:txt-1',
        content: [{ type: 'text', text: '关键在 canReuse——' }],
      });

      // 3. The completed tool update must not flush a second envelope.
      const toolDone = toCodeMuxEvent({
        type: 'message.part.updated',
        properties: { sessionID: 'opencode-session-1', part: { id: 'tool-1', messageID: 'msg-1', sessionID: 'opencode-session-1', type: 'tool', callID: 'call-1', tool: 'bash', state: { status: 'completed', input: {}, output: 'ok' } } },
      }, ctx);
      expect(toolDone.map((event) => event.type)).not.toContain('assistant_message');

      // 4. Late text finalization emits the full text, superseding the provisional envelope.
      const finalized = toCodeMuxEvent({
        type: 'message.part.updated',
        properties: { sessionID: 'opencode-session-1', part: { id: 'txt-1', messageID: 'msg-1', sessionID: 'opencode-session-1', type: 'text', text: '关键在 canReuse——查 canReuse 的判断条件:' } },
      }, ctx);
      expect(finalized).toHaveLength(2);
      expect(finalized[1]).toMatchObject({
        type: 'assistant_message',
        provider_message_id: 'msg-1',
        supersedes_provider_message_ids: ['msg-1:txt-1'],
        content: [{ type: 'text', text: '关键在 canReuse——查 canReuse 的判断条件:' }],
      });
    });

    it('flushes narration before tool when text deltas arrive before the start marker', () => {
      const ctx = streamingContext({ idleStreamKind: { kind: 'text' } });
      toCodeMuxEvent({
        type: 'message.part.delta',
        properties: { sessionID: 'opencode-session-1', partID: 'txt-1', messageID: 'msg-1', field: 'text', delta: '字符串匹配 contains' },
      }, ctx);
      const toolPending = toCodeMuxEvent({
        type: 'message.part.updated',
        properties: { sessionID: 'opencode-session-1', part: { id: 'tool-1', messageID: 'msg-1', sessionID: 'opencode-session-1', type: 'tool', callID: 'call-1', tool: 'edit', state: { status: 'pending', input: {} } } },
      }, ctx);
      const assistantIndex = toolPending.findIndex((event) => event.type === 'assistant_message');
      const toolIndex = toolPending.findIndex((event) => event.type === 'tool_started');
      expect(assistantIndex).toBeGreaterThanOrEqual(0);
      expect(toolIndex).toBeGreaterThanOrEqual(0);
      expect(assistantIndex).toBeLessThan(toolIndex);
    });

    it('emits the final text envelope without supersedes when no tool interrupted', () => {
      const ctx = streamingContext();
      toCodeMuxEvent({
        type: 'message.part.delta',
        properties: { sessionID: 'opencode-session-1', partID: 'txt-1', messageID: 'msg-1', field: 'text', delta: 'Hello' },
      }, ctx);
      const finalized = toCodeMuxEvent({
        type: 'message.part.updated',
        properties: { sessionID: 'opencode-session-1', part: { id: 'txt-1', messageID: 'msg-1', sessionID: 'opencode-session-1', type: 'text', text: 'Hello' } },
      }, ctx);
      expect(finalized).toHaveLength(2);
      expect(finalized[1]).toMatchObject({
        type: 'assistant_message',
        provider_message_id: 'msg-1',
        content: [{ type: 'text', text: 'Hello' }],
      });
      expect(finalized[1].supersedes_provider_message_ids).toBeUndefined();
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
