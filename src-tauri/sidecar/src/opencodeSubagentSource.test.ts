import { describe, expect, it } from 'vitest';
import { OpenCodeSubagentSource } from './opencodeSubagentSource.js';
import type { CodeMuxSubagentEvent, CodeMuxSubagentTimelineEvent, CodeMuxSubagentUpsertEvent } from './codeMuxProtocol.js';

function isUpsert(event: CodeMuxSubagentEvent): event is CodeMuxSubagentUpsertEvent {
  return event.type === 'subagent_upsert';
}

function isTimeline(event: CodeMuxSubagentEvent): event is CodeMuxSubagentTimelineEvent {
  return event.type === 'subagent_timeline';
}

function subtaskPart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'message.part.updated',
    properties: {
      sessionID: 'opencode-parent',
      part: {
        id: 'task-1',
        messageID: 'message-1',
        type: 'subtask',
        prompt: '检查测试',
        description: '检查测试',
        agent: 'explore',
        ...overrides,
      },
    },
  };
}

function taskToolPart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'message.part.updated',
    properties: {
      sessionID: 'opencode-parent',
      part: {
        type: 'tool',
        tool: 'Task',
        callID: 'task-1',
        messageID: 'message-1',
        state: {
          status: 'running',
          input: { description: '检查测试', prompt: '检查测试', subagent_type: 'explore' },
          metadata: { sessionId: 'child-session-1' },
        },
        ...overrides,
      },
    },
  };
}

function childEvent(type: string, properties: Record<string, unknown>): Record<string, unknown> {
  return { type, properties: { sessionID: 'child-session-1', ...properties } };
}

describe('OpenCodeSubagentSource declarations', () => {
  it('declares a subagent from a subtask part with the part id as canonical id', () => {
    const source = new OpenCodeSubagentSource(() => 'event-1');
    const events = source.observeParentEvent(subtaskPart(), { sessionId: 'app-1' });

    const upserts = events.filter(isUpsert);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      type: 'subagent_upsert',
      session_id: 'app-1',
      subagent_id: 'task-1',
      provider: 'opencode',
      title: 'explore',
      description: '检查测试',
      status: 'running',
      tool_call_id: 'task-1',
    });
    const timeline = events.filter(isTimeline);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].event).toMatchObject({ type: 'user_message', content: '检查测试' });
  });

  it('binds a Task tool part with the same callID without duplicating the declaration', () => {
    const source = new OpenCodeSubagentSource(() => 'event-1');
    source.observeParentEvent(subtaskPart(), {});
    const events = source.observeParentEvent(taskToolPart(), {});

    expect(events.filter(isUpsert)).toHaveLength(0);
    expect(source.isChildSession('child-session-1')).toBe(true);
  });

  it('registers the tool callID as an alias when the subtask part id differs', () => {
    const source = new OpenCodeSubagentSource(() => 'event-1');
    source.observeParentEvent(subtaskPart(), {});
    const events = source.observeParentEvent(taskToolPart({ callID: 'call-9' }), {});

    expect(events.filter(isUpsert)).toHaveLength(0);
    expect(source.isChildSession('child-session-1')).toBe(true);
    // Child traffic lands on the subtask declaration's timeline.
    const routed = source.observeChildEvent(
      childEvent('message.part.delta', { partID: 'p1', messageID: 'cm1', field: 'text', delta: 'hello' }),
      'child-session-1',
      {},
    );
    expect(routed.filter(isTimeline)[0].subagent_id).toBe('task-1');
  });

  it('binds a late subtask part to an existing tool-part binding via messageID', () => {
    const source = new OpenCodeSubagentSource(() => 'event-1');
    const bindEvents = source.observeParentEvent(taskToolPart(), {});
    expect(bindEvents.filter(isUpsert)).toHaveLength(1);

    const lateEvents = source.observeParentEvent(subtaskPart({ id: 'part-2', agent: 'general' }), {});
    expect(lateEvents.filter(isUpsert)).toHaveLength(0);
    const routed = source.observeChildEvent(
      childEvent('message.part.delta', { partID: 'p1', messageID: 'cm1', field: 'text', delta: 'hi' }),
      'child-session-1',
      {},
    );
    expect(routed.filter(isTimeline)[0].subagent_id).toBe('task-1');
  });

  it('declares from the tool input alone when no subtask part exists', () => {
    const source = new OpenCodeSubagentSource(() => 'event-1');
    const events = source.observeParentEvent(taskToolPart(), { sessionId: 'app-1' });

    const upserts = events.filter(isUpsert);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      subagent_id: 'task-1',
      provider: 'opencode',
      title: 'explore',
      status: 'running',
    });
    expect(source.isChildSession('child-session-1')).toBe(true);
  });

  it('ignores non-task tool parts and non-part events', () => {
    const source = new OpenCodeSubagentSource(() => 'event-1');
    expect(source.observeParentEvent(taskToolPart({ tool: 'bash', callID: 'b1', state: { status: 'running', input: {}, metadata: { sessionId: 'c1' } } }), {})).toHaveLength(0);
    expect(source.observeParentEvent({ type: 'session.idle', properties: { sessionID: 'opencode-parent' } }, {})).toHaveLength(0);
    expect(source.isChildSession('c1')).toBe(false);
  });

  it('re-announcing the same subtask part merges stickily without duplicate upserts', () => {
    const source = new OpenCodeSubagentSource(() => 'event-1');
    source.observeParentEvent(subtaskPart(), {});
    const events = source.observeParentEvent(subtaskPart(), {});
    expect(events.filter(isUpsert)).toHaveLength(0);
    expect(events.filter(isTimeline)).toHaveLength(0);
  });
});

describe('OpenCodeSubagentSource child routing', () => {
  it('streams child text deltas and finalization into the subagent timeline', () => {
    const source = new OpenCodeSubagentSource(() => 'event-1');
    source.observeParentEvent(subtaskPart(), {});
    source.observeParentEvent(taskToolPart(), {});

    const deltaEvents = source.observeChildEvent(
      childEvent('message.part.delta', { partID: 'p1', messageID: 'cm1', field: 'text', delta: '正在检查' }),
      'child-session-1',
      {},
    );
    // A delta emits content_block_start + a delta event, one timeline envelope
    // each. Without session.next.* the first delta follows the idle heuristic
    // (thinking), matching the parent-path projection.
    expect(deltaEvents.filter(isTimeline)).toHaveLength(2);
    expect(deltaEvents.filter(isTimeline)[0].event).toMatchObject({ type: 'content_started', content_kind: 'reasoning' });
    expect(deltaEvents.filter(isTimeline)[1].event).toMatchObject({ type: 'reasoning_delta', text: '正在检查' });

    const finalEvents = source.observeChildEvent(
      childEvent('message.part.updated', { part: { id: 'p1', messageID: 'cm1', type: 'text', text: '正在检查代码' } }),
      'child-session-1',
      {},
    );
    const finalTimeline = finalEvents.filter(isTimeline);
    expect(finalTimeline.some((event) => event.event.type === 'assistant_message')).toBe(true);
  });

  it('suppresses the child user prompt text (declaration prompt already emitted)', () => {
    const source = new OpenCodeSubagentSource(() => 'event-1');
    source.observeParentEvent(subtaskPart(), {});
    source.observeParentEvent(taskToolPart(), {});

    source.observeChildEvent(childEvent('message.updated', { info: { id: 'um1', role: 'user' } }), 'child-session-1', {});
    const events = source.observeChildEvent(
      childEvent('message.part.updated', { part: { id: 'up1', messageID: 'um1', type: 'text', text: '检查测试' } }),
      'child-session-1',
      {},
    );
    expect(events).toHaveLength(0);
  });

  it('maps child terminal events onto lifecycle statuses without a child turn_finished', () => {
    const source = new OpenCodeSubagentSource(() => 'event-1');
    source.observeParentEvent(subtaskPart(), {});
    source.observeParentEvent(taskToolPart(), {});

    const completed = source.observeChildEvent(childEvent('session.idle', {}), 'child-session-1', {});
    const completedUpserts = completed.filter(isUpsert);
    expect(completedUpserts).toHaveLength(1);
    expect(completedUpserts[0]).toMatchObject({ subagent_id: 'task-1', status: 'completed' });
    expect(completed.filter(isTimeline).some((event) => event.event.type === 'turn_finished')).toBe(false);
  });

  it('puts a child session error into the timeline and marks the descriptor failed', () => {
    const source = new OpenCodeSubagentSource(() => 'event-1');
    source.observeParentEvent(subtaskPart(), {});
    source.observeParentEvent(taskToolPart(), {});

    const events = source.observeChildEvent(
      childEvent('session.error', { error: { name: 'ProviderError', data: { message: 'quota exceeded' } } }),
      'child-session-1',
      {},
    );
    expect(events.filter(isTimeline).some((event) => event.event.type === 'error')).toBe(true);
    expect(events.filter(isUpsert)[0]).toMatchObject({ status: 'failed' });
  });

  it('marks a child canceled on session.interrupted', () => {
    const source = new OpenCodeSubagentSource(() => 'event-1');
    source.observeParentEvent(subtaskPart(), {});
    source.observeParentEvent(taskToolPart(), {});
    const events = source.observeChildEvent(childEvent('session.aborted', {}), 'child-session-1', {});
    expect(events.filter(isUpsert)[0]).toMatchObject({ status: 'canceled' });
  });

  it('refreshes tool input when a later part update carries the real arguments', () => {
    const source = new OpenCodeSubagentSource(() => 'event-1');
    source.observeParentEvent(subtaskPart(), {});
    source.observeParentEvent(taskToolPart(), {});

    // OpenCode publishes the child tool part with empty input at pending…
    const pendingEvents = source.observeChildEvent(
      childEvent('message.part.updated', {
        part: { id: 'pt1', messageID: 'cm1', type: 'tool', tool: 'read', callID: 'call-1', state: { status: 'pending', input: {} } },
      }),
      'child-session-1',
      {},
    );
    expect(pendingEvents.filter(isTimeline)).toHaveLength(1);
    expect(pendingEvents.filter(isTimeline)[0].event).toMatchObject({ type: 'tool_started', input: {} });

    // …then streams the real input in the running/completed update.
    const runningEvents = source.observeChildEvent(
      childEvent('message.part.updated', {
        part: { id: 'pt1', messageID: 'cm1', type: 'tool', tool: 'read', callID: 'call-1', state: { status: 'running', input: { filePath: 'D:/demo/package.json' } } },
      }),
      'child-session-1',
      {},
    );
    const refreshed = runningEvents.filter(isTimeline);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0].event).toMatchObject({
      type: 'tool_started',
      tool_use_id: 'call-1',
      input: { filePath: 'D:/demo/package.json' },
    });
  });

  it('drops events from unbound child sessions', () => {
    const source = new OpenCodeSubagentSource(() => 'event-1');
    const events = source.observeChildEvent(
      childEvent('message.part.delta', { partID: 'p1', messageID: 'cm1', field: 'text', delta: 'hello' }),
      'unknown-child',
      {},
    );
    expect(events).toHaveLength(0);
  });

  it('keeps a terminal descriptor terminal even if the child reports progress again', () => {
    const source = new OpenCodeSubagentSource(() => 'event-1');
    source.observeParentEvent(subtaskPart(), {});
    source.observeParentEvent(taskToolPart(), {});
    source.observeChildEvent(childEvent('session.error', { error: { message: 'boom' } }), 'child-session-1', {});

    const events = source.observeChildEvent(
      childEvent('message.part.delta', { partID: 'p2', messageID: 'cm2', field: 'text', delta: 'late' }),
      'child-session-1',
      {},
    );
    // Timeline rows may still arrive, but the descriptor must not resurrect.
    expect(events.filter(isUpsert)).toHaveLength(0);
  });
});

describe('OpenCodeSubagentSource lifecycle', () => {
  it('failRunningTasks marks running descriptors failed and is sticky afterwards', () => {
    const source = new OpenCodeSubagentSource(() => 'event-1');
    source.observeParentEvent(subtaskPart(), {});
    source.observeParentEvent(taskToolPart(), {});

    const failed = source.failRunningTasks({ sessionId: 'app-1' });
    expect(failed.filter(isUpsert)).toHaveLength(1);
    expect(failed.filter(isUpsert)[0]).toMatchObject({ subagent_id: 'task-1', status: 'failed', session_id: 'app-1' });
    expect(source.hasRunningTasks()).toBe(false);
    expect(source.failRunningTasks({})).toHaveLength(0);
  });

  it('failSession marks only the requested child session', () => {
    const source = new OpenCodeSubagentSource(() => 'event-1');
    source.observeParentEvent(subtaskPart(), {});
    source.observeParentEvent(taskToolPart(), {});
    source.observeParentEvent(taskToolPart({ callID: 'task-2', messageID: 'message-2', state: { status: 'running', input: {}, metadata: { sessionId: 'child-session-2' } } }), {});

    const failed = source.failSession('child-session-2', {});
    expect(failed.filter(isUpsert)).toHaveLength(1);
    expect(failed.filter(isUpsert)[0]).toMatchObject({ subagent_id: 'task-2', status: 'failed' });
    expect(source.hasRunningTasks()).toBe(true);
  });

  it('reset clears declarations, bindings and running state', () => {
    const source = new OpenCodeSubagentSource(() => 'event-1');
    source.observeParentEvent(subtaskPart(), {});
    source.observeParentEvent(taskToolPart(), {});
    source.reset();

    expect(source.isChildSession('child-session-1')).toBe(false);
    expect(source.hasRunningTasks()).toBe(false);
    expect(source.observeChildEvent(childEvent('session.idle', {}), 'child-session-1', {})).toHaveLength(0);
  });
});

describe('OpenCodeSubagentSource assistant envelopes', () => {
  it('keeps every part of a shared messageID (thinking and text both persist)', () => {
    const source = new OpenCodeSubagentSource(() => 'event-1');
    source.observeParentEvent(subtaskPart(), {});
    source.observeParentEvent(taskToolPart(), {});

    // One OpenCode assistant message: thinking part finalizes, then a text
    // part of the SAME messageID finalizes (narration streams after tools).
    const part = (type: 'reasoning' | 'text', text: string) =>
      childEvent('message.part.updated', {
        part: { id: `p-${type}`, messageID: 'msg-1', type, text },
      });
    source.observeChildEvent(part('reasoning', '先想想'), 'child-session-1', {});
    const textEvents = source.observeChildEvent(part('text', '结论如下'), 'child-session-1', {});

    const envelopes = textEvents.filter(isTimeline).filter((event) => event.event.type === 'assistant_message');
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].event).toMatchObject({
      content: [{ type: 'text', text: '结论如下' }],
    });
  });
});
