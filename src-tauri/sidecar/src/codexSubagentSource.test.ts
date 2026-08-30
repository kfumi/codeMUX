import { describe, expect, it } from 'vitest';
import { CodexSubagentSource } from './codexSubagentSource.js';
import type { CodeMuxSubagentEvent, CodeMuxSubagentTimelineEvent, CodeMuxSubagentUpsertEvent } from './codeMuxProtocol.js';

function isUpsert(event: CodeMuxSubagentEvent): event is CodeMuxSubagentUpsertEvent {
  return event.type === 'subagent_upsert';
}

function isTimeline(event: CodeMuxSubagentEvent): event is CodeMuxSubagentTimelineEvent {
  return event.type === 'subagent_timeline';
}

function collabItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'collabAgentToolCall',
    id: 'call-1',
    tool: 'spawnAgent',
    status: 'inProgress',
    prompt: '列出仓库里的测试文件',
    receiverThreadIds: ['child-thread-1'],
    agentsStates: { 'child-thread-1': { status: 'running', message: null } },
    ...overrides,
  };
}

function childNotification(method: string, params: Record<string, unknown> = {}): {
  method: string;
  params: Record<string, unknown>;
} {
  return { method, params: { threadId: 'child-thread-1', ...params } };
}

describe('CodexSubagentSource declarations', () => {
  it('declares a track from a collabAgentToolCall item with the item id as canonical id', () => {
    const source = new CodexSubagentSource();
    const events = source.observeParentItem(collabItem(), 'started', { sessionId: 'app-1' });

    const upserts = events.filter(isUpsert);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].subagent_id).toBe('call-1');
    expect(upserts[0].provider).toBe('codex');
    expect(upserts[0].status).toBe('running');
    expect(upserts[0].tool_call_id).toBe('call-1');
    expect(upserts[0].title).toBe('Sub-agent');

    // The prompt becomes the first timeline entry as a user message.
    const timelines = events.filter(isTimeline);
    expect(timelines).toHaveLength(1);
    expect(timelines[0].event).toMatchObject({ type: 'user_message', content: '列出仓库里的测试文件' });

    // The child thread is routed to the canonical id.
    expect(source.routeThreadId('child-thread-1', 'parent-thread-1')).toBe('child');
  });

  it('does not declare collab items without child threads or tool', () => {
    const source = new CodexSubagentSource();
    const events = source.observeParentItem(
      { type: 'collabAgentToolCall', id: 'call-1', status: 'inProgress' },
      'started',
      {},
    );
    expect(events).toEqual([]);
    expect(source.routeThreadId('child-thread-1', 'parent-thread-1')).toBe('pending');
  });

  it('merges a follow-up collab call on the same child thread as an alias, not a new track', () => {
    const source = new CodexSubagentSource();
    source.observeParentItem(collabItem(), 'started', {});

    const events = source.observeParentItem(
      collabItem({ id: 'call-2', tool: 'sendInput', prompt: '继续' }),
      'started',
      {},
    );

    const upserts = events.filter(isUpsert);
    expect(upserts.every((event) => event.subagent_id === 'call-1')).toBe(true);
  });

  it('replays child notifications that arrived before the declaration', () => {
    const source = new CodexSubagentSource();
    // Race: child delta + completed message arrive before the spawn item.
    const earlyDelta = childNotification('item/agentMessage/delta', { itemId: 'msg-1', delta: 'hello' });
    expect(source.observeChildNotification(earlyDelta.method, earlyDelta.params, {})).toEqual([]);

    const events = source.observeParentItem(collabItem(), 'started', {});

    const timelines = events.filter(isTimeline);
    // First: the prompt user_message from the declaration, then the replay.
    const types = timelines.map((event) => event.event.type);
    expect(types[0]).toBe('user_message');
    expect(types).toContain('content_started');
    expect(types).toContain('text_delta');
    const deltaIndex = types.indexOf('text_delta');
    expect(deltaIndex).toBeGreaterThan(types.indexOf('content_started'));
  });
});

describe('CodexSubagentSource child timeline projection', () => {
  it('projects child text streaming and message completion', () => {
    const source = new CodexSubagentSource();
    source.observeParentItem(collabItem(), 'started', {});

    const deltaEvents = source.observeChildNotification(
      'item/agentMessage/delta',
      { threadId: 'child-thread-1', itemId: 'msg-1', delta: 'he' },
      {},
    );
    const deltaTypes = deltaEvents.filter(isTimeline).map((event) => event.event.type);
    expect(deltaTypes).toEqual(['content_started', 'text_delta']);

    const completed = source.observeChildNotification(
      'item/completed',
      { threadId: 'child-thread-1', item: { type: 'agentMessage', id: 'msg-1', text: 'hello world' } },
      {},
    );
    const timelines = completed.filter(isTimeline);
    expect(timelines.map((event) => event.event.type)).toEqual(['content_finished', 'assistant_message']);
    expect(timelines[1].event).toMatchObject({
      content: [{ type: 'text', text: 'hello world' }],
      provider_message_id: 'msg-1',
    });
    // All timeline events carry the canonical subagent id.
    expect(timelines.every((event) => event.subagent_id === 'call-1')).toBe(true);
  });

  it('projects child command execution lifecycle as tool events', () => {
    const source = new CodexSubagentSource();
    source.observeParentItem(collabItem(), 'started', {});

    const started = source.observeChildNotification(
      'item/started',
      { threadId: 'child-thread-1', item: { type: 'commandExecution', id: 'cmd-1', command: 'npm test', status: 'inProgress' } },
      {},
    );
    expect(started.filter(isTimeline).map((event) => event.event)).toMatchObject([
      { type: 'tool_started', tool_use_id: 'cmd-1', name: 'shell_command' },
    ]);

    const completed = source.observeChildNotification(
      'item/completed',
      {
        threadId: 'child-thread-1',
        item: {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'npm test',
          status: 'completed',
          aggregatedOutput: 'all green',
          exitCode: 0,
        },
      },
      {},
    );
    expect(completed.filter(isTimeline).map((event) => event.event)).toMatchObject([
      { type: 'tool_finished', tool_use_id: 'cmd-1', content: 'all green', is_error: false },
    ]);
  });

  it('maps child turn/completed onto the descriptor lifecycle', () => {
    const source = new CodexSubagentSource();
    source.observeParentItem(collabItem(), 'started', {});

    const events = source.observeChildNotification(
      'turn/completed',
      { threadId: 'child-thread-1', turn: { id: 'turn-1', status: 'completed' } },
      {},
    );
    expect(events.filter(isUpsert).map((event) => event.status)).toEqual(['completed']);
  });

  it('buffers child turn/completed for an unknown thread and replays after registration', () => {
    const source = new CodexSubagentSource();
    source.observeChildNotification(
      'turn/completed',
      { threadId: 'child-thread-9', turn: { status: 'interrupted' } },
      {},
    );

    const events = source.observeParentItem(
      collabItem({ id: 'call-9', receiverThreadIds: ['child-thread-9'] }),
      'started',
      {},
    );
    // Interrupted replay must not resurrect the fresh running descriptor.
    expect(events.filter(isUpsert).map((event) => event.status)).toEqual(['running', 'canceled']);
  });
});

describe('CodexSubagentSource status mapping', () => {
  it.each([
    ['completed', 'completed'],
    ['shutdown', 'canceled'],
    ['notFound', 'failed'],
  ])('maps collab agentsStates %s to %s', (childStatus, expected) => {
    const source = new CodexSubagentSource();
    source.observeParentItem(collabItem(), 'started', {});
    const events = source.observeParentItem(
      collabItem({ status: 'completed', agentsStates: { 'child-thread-1': { status: childStatus } } }),
      'completed',
      {},
    );
    expect(events.filter(isUpsert).map((event) => event.status)).toContain(expected);
  });

  it('keeps errored children running (the child turn may retry)', () => {
    const source = new CodexSubagentSource();
    source.observeParentItem(collabItem(), 'started', {});
    const events = source.observeParentItem(
      collabItem({ status: 'completed', agentsStates: { 'child-thread-1': { status: 'errored' } } }),
      'completed',
      {},
    );
    // The descriptor is already running — no upsert, and definitely no regression.
    expect(events.filter(isUpsert)).toEqual([]);
    expect(source.hasRunningTasks()).toBe(true);
  });

  it('marks a failed collab item as failed regardless of child states', () => {
    const source = new CodexSubagentSource();
    source.observeParentItem(collabItem(), 'started', {});
    const events = source.observeParentItem(
      collabItem({ status: 'failed', agentsStates: { 'child-thread-1': { status: 'running' } } }),
      'completed',
      {},
    );
    expect(events.filter(isUpsert).map((event) => event.status)).toEqual(['failed']);
  });

  it('cancels the track when subAgentActivity reports interrupted', () => {
    const source = new CodexSubagentSource();
    source.observeParentItem(collabItem(), 'started', {});
    const events = source.observeParentItem(
      { type: 'subAgentActivity', id: 'act-1', kind: 'interrupted', agentThreadId: 'child-thread-1', agentPath: null },
      'completed',
      {},
    );
    expect(events.filter(isUpsert).map((event) => event.status)).toEqual(['canceled']);
  });
});

describe('CodexSubagentSource re-announced spawns', () => {
  it('merges the second spawn announcement (thread ids arrive late) into the first track', () => {
    const source = new CodexSubagentSource();
    // First announcement: codex emits item/started before the child threads
    // exist — no receiverThreadIds, nothing to route yet.
    const first = source.observeParentItem(
      collabItem({ receiverThreadIds: [], agentsStates: {} }),
      'started',
      {},
    );
    expect(first.filter(isUpsert).map((event) => event.subagent_id)).toEqual(['call-1']);
    expect(source.routeThreadId('child-thread-1', 'parent-1')).toBe('pending');

    // Child traffic races in ahead of the second announcement.
    source.observeChildNotification(
      'item/agentMessage/delta',
      { threadId: 'child-thread-1', itemId: 'msg-1', delta: 'hi' },
      {},
    );

    // Second announcement: same spawn, now with the child thread id.
    const second = source.observeParentItem(collabItem({ id: 'call-2' }), 'started', {});

    // No forked track — everything binds to call-1.
    const upserts = second.filter(isUpsert);
    expect(upserts.every((event) => event.subagent_id === 'call-1')).toBe(true);
    expect(source.routeThreadId('child-thread-1', 'parent-1')).toBe('child');
    expect(source.isCanonicalDeclaration('call-1')).toBe(true);
    expect(source.isCanonicalDeclaration('call-2')).toBe(false);
    expect(source.canonicalCallIdFor('call-2')).toBe('call-1');

    // The buffered child content replays into the original track.
    const timelines = second.filter(isTimeline);
    expect(timelines.map((event) => event.event.type)).toContain('text_delta');
    expect(timelines.every((event) => event.subagent_id === 'call-1')).toBe(true);
  });

  it('matches the re-announcement by prompt when two parallel spawns are unresolved', () => {
    const source = new CodexSubagentSource();
    source.observeParentItem(
      collabItem({ prompt: '探索前端', receiverThreadIds: [], agentsStates: {} }),
      'started',
      {},
    );
    source.observeParentItem(
      collabItem({ id: 'call-2', prompt: '探索后端', receiverThreadIds: [], agentsStates: {} }),
      'started',
      {},
    );

    source.observeParentItem(
      collabItem({
        id: 'call-3',
        prompt: '探索后端',
        receiverThreadIds: ['child-2'],
        agentsStates: { 'child-2': { status: 'completed' } },
        status: 'completed',
      }),
      'started',
      {},
    );

    // call-3 must merge into call-2 (prompt match), not call-1.
    expect(source.routeThreadId('child-2', 'parent-1')).toBe('child');
    const events = source.observeChildNotification(
      'turn/completed',
      { threadId: 'child-2', turn: { status: 'completed' } },
      {},
    );
    expect(events.filter(isUpsert).every((event) => event.subagent_id === 'call-2')).toBe(true);
  });
});

describe('CodexSubagentSource teardown', () => {
  it('fails running tasks and clears all state on reset', () => {
    const source = new CodexSubagentSource();
    source.observeParentItem(collabItem(), 'started', {});
    expect(source.hasRunningTasks()).toBe(true);

    const events = source.failRunningTasks({ sessionId: 'app-1' });
    expect(events.filter(isUpsert).map((event) => event.status)).toEqual(['failed']);

    source.reset();
    expect(source.hasRunningTasks()).toBe(false);
    expect(source.routeThreadId('child-thread-1', 'parent-thread-1')).toBe('pending');
  });
});
