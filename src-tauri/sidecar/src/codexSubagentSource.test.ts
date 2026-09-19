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

  it('carries the spawn-declared model onto the child track without a model upsert', () => {
    const source = new CodexSubagentSource();
    const events = source.observeParentItem(
      collabItem({ model: 'deepseek-flash', reasoningEffort: 'high' }),
      'started',
      { sessionId: 'app-1' },
    );

    // The app-server exposes a child's model only on the spawn call, and the
    // descriptor upsert has no model field: the fold stamps the timeline instead.
    expect(events.filter(isUpsert)[0]).not.toHaveProperty('model');
    expect(events.filter(isTimeline)[0].event).toEqual(
      expect.objectContaining({ type: 'user_message', model: 'deepseek-flash' }),
    );
  });

  it('never invents a model when the spawn call declares none', () => {
    const source = new CodexSubagentSource();
    const events = source.observeParentItem(collabItem(), 'started', {});
    expect(events.filter(isTimeline)[0].event).not.toHaveProperty('model');
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

  it('stamps the declared model on the child timeline, not just on the declaration', () => {
    const source = new CodexSubagentSource();
    source.observeParentItem(collabItem({ model: 'deepseek-flash' }), 'started', {});
    source.observeChildNotification(
      'item/agentMessage/delta',
      { threadId: 'child-thread-1', itemId: 'msg-1', delta: 'he' },
      {},
    );
    const completed = source.observeChildNotification(
      'item/completed',
      { threadId: 'child-thread-1', item: { type: 'agentMessage', id: 'msg-1', text: 'hello world' } },
      {},
    );

    const timelines = completed.filter(isTimeline);
    expect(timelines).toHaveLength(2);
    expect(timelines.map((event) => event.event)).toEqual([
      expect.objectContaining({ model: 'deepseek-flash' }),
      expect.objectContaining({ model: 'deepseek-flash' }),
    ]);
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

// ---------------------------------------------------------------------------
// Variant B (`subAgentActivity`) — raw payloads copied from a captured session
// (codex 0.146.1, model deepseek-flash, 2026-09-19): no `collabAgentToolCall`
// spawn item exists at all, the activity item *is* the declaration.
// ---------------------------------------------------------------------------

const ACTIVITY_SCAN_SRC = {
  type: 'subAgentActivity',
  id: 'call_00_KapLrhSWlODQdZDkANYI1759',
  kind: 'started',
  agentThreadId: '01a0ba42-c01b-7db0-b6b7-a1ba1cd8e432',
  agentPath: '/root/scan_src',
};

/** Same child, second declaration under a fresh call id (`interacted`). */
const ACTIVITY_SCAN_SRC_INTERACTED = {
  type: 'subAgentActivity',
  id: 'call_00_IKVpksPhX0o98pqRBbmu7205',
  kind: 'interacted',
  agentThreadId: '01a0ba42-c01b-7db0-b6b7-a1ba1cd8e432',
  agentPath: '/root/scan_src',
};

const ACTIVITY_LIST_DIRS = {
  type: 'subAgentActivity',
  id: 'call_00_ve8rk9zc7gFaheNbTy8f6403',
  kind: 'started',
  agentThreadId: '01a0ba43-41ee-7d60-8a4f-0acae8dcbc07',
  agentPath: '/root/list_tauri_dirs',
};

/** Declared *by* ACTIVITY_LIST_DIRS' child, on that child's own thread. */
const ACTIVITY_GRANDCHILD = {
  type: 'subAgentActivity',
  id: 'call_00_A3wWiqSPMRmchObp9eKT2275',
  kind: 'started',
  agentThreadId: '01a0ba43-66c8-7f82-a9bf-3f4166ef0eb8',
  agentPath: '/root/list_tauri_dirs/scan_src',
};

const ROOT_THREAD = '01a0ba42-9b75-7cf2-bb41-741f548473bb';

describe('CodexSubagentSource variant B declarations', () => {
  it('declares a track from a parent-thread subAgentActivity item', () => {
    const source = new CodexSubagentSource();
    const declaration = source.activityDeclaration(ACTIVITY_SCAN_SRC);
    expect(declaration).toEqual({
      callId: 'call_00_KapLrhSWlODQdZDkANYI1759',
      agentPath: '/root/scan_src',
    });

    const events = source.observeParentItem(ACTIVITY_SCAN_SRC, 'started', { sessionId: 'app-1' });

    const upserts = events.filter(isUpsert);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      type: 'subagent_upsert',
      session_id: 'app-1',
      subagent_id: 'call_00_KapLrhSWlODQdZDkANYI1759',
      provider: 'codex',
      status: 'running',
      tool_call_id: 'call_00_KapLrhSWlODQdZDkANYI1759',
      title: 'scan_src',
      subtitle: '/root/scan_src',
    });
    // No invented task text: the child's own inbound message carries it.
    expect(events.filter(isTimeline)).toEqual([]);
    expect(source.routeThreadId('01a0ba42-c01b-7db0-b6b7-a1ba1cd8e432', ROOT_THREAD)).toBe('child');
  });

  it('declares once: the completed mirror changes nothing and yields no second card', () => {
    const source = new CodexSubagentSource();
    source.observeParentItem(ACTIVITY_SCAN_SRC, 'started', {});

    expect(source.activityDeclaration(ACTIVITY_SCAN_SRC)).toBeNull();
    expect(source.observeParentItem(ACTIVITY_SCAN_SRC, 'completed', {})).toEqual([]);
  });

  it('replays child notifications buffered before the declaration', () => {
    const source = new CodexSubagentSource();
    const early = source.observeChildNotification(
      'item/agentMessage/delta',
      { threadId: '01a0ba42-c01b-7db0-b6b7-a1ba1cd8e432', itemId: 'msg-1', delta: 'hi' },
      {},
    );
    expect(early).toEqual([]);

    const events = source.observeParentItem(ACTIVITY_SCAN_SRC, 'started', {});
    const timelines = events.filter(isTimeline);
    expect(timelines.map((event) => event.event.type)).toEqual(['content_started', 'text_delta']);
    expect(timelines.every((event) => event.subagent_id === 'call_00_KapLrhSWlODQdZDkANYI1759')).toBe(true);
  });

  it('merges a second declaration of the same child under a new call id as an alias', () => {
    const source = new CodexSubagentSource();
    source.observeParentItem(ACTIVITY_SCAN_SRC, 'started', {});

    // `interacted` reuses the child with a different call id.
    expect(source.activityDeclaration(ACTIVITY_SCAN_SRC_INTERACTED)).toBeNull();
    expect(source.observeParentItem(ACTIVITY_SCAN_SRC_INTERACTED, 'started', {})).toEqual([]);

    const events = source.observeChildNotification(
      'item/completed',
      {
        threadId: '01a0ba42-c01b-7db0-b6b7-a1ba1cd8e432',
        item: { type: 'agentMessage', id: 'msg-1', text: 'done' },
      },
      {},
    );
    expect(events.filter(isTimeline).every((event) => event.subagent_id === 'call_00_KapLrhSWlODQdZDkANYI1759')).toBe(true);
  });

  it('refreshes the subtitle from interacted without touching the lifecycle', () => {
    const source = new CodexSubagentSource();
    source.observeParentItem({ ...ACTIVITY_SCAN_SRC, agentPath: '/root/scan' }, 'started', {});

    const events = source.observeParentItem(ACTIVITY_SCAN_SRC_INTERACTED, 'completed', {});

    expect(events.filter(isUpsert)).toEqual([
      expect.objectContaining({ subagent_id: 'call_00_KapLrhSWlODQdZDkANYI1759', subtitle: '/root/scan_src' }),
    ]);
    expect(events.filter(isUpsert)[0]).not.toHaveProperty('status');
  });

  it('maps interrupted to canceled, and never declares a track from an interruption', () => {
    const source = new CodexSubagentSource();
    const orphan = { ...ACTIVITY_SCAN_SRC, kind: 'interrupted' };
    expect(source.observeParentItem(orphan, 'started', {})).toEqual([]);
    expect(source.routeThreadId('01a0ba42-c01b-7db0-b6b7-a1ba1cd8e432', ROOT_THREAD)).toBe('pending');

    source.observeParentItem(ACTIVITY_SCAN_SRC, 'started', {});
    const events = source.observeParentItem(orphan, 'completed', {});
    expect(events.filter(isUpsert).map((event) => event.status)).toEqual(['canceled']);
  });

  it('ignores interacted for an unknown child', () => {
    const source = new CodexSubagentSource();
    expect(source.observeParentItem(ACTIVITY_SCAN_SRC_INTERACTED, 'started', {})).toEqual([]);
    expect(source.routeThreadId('01a0ba42-c01b-7db0-b6b7-a1ba1cd8e432', ROOT_THREAD)).toBe('pending');
  });
});

describe('CodexSubagentSource nested declarations', () => {
  it("declares a grandchild from a declaration on the child's own thread", () => {
    const source = new CodexSubagentSource();
    source.observeParentItem(ACTIVITY_LIST_DIRS, 'started', {});
    expect(source.routeThreadId('01a0ba43-41ee-7d60-8a4f-0acae8dcbc07', ROOT_THREAD)).toBe('child');

    const events = source.observeChildNotification(
      'item/started',
      { threadId: '01a0ba43-41ee-7d60-8a4f-0acae8dcbc07', item: ACTIVITY_GRANDCHILD },
      { sessionId: 'app-1' },
    );

    expect(events.filter(isUpsert)).toEqual([
      expect.objectContaining({
        subagent_id: 'call_00_A3wWiqSPMRmchObp9eKT2275',
        session_id: 'app-1',
        status: 'running',
        title: 'scan_src',
        subtitle: '/root/list_tauri_dirs/scan_src',
      }),
    ]);
    expect(source.routeThreadId('01a0ba43-66c8-7f82-a9bf-3f4166ef0eb8', ROOT_THREAD)).toBe('child');
  });

  it('projects the grandchild timeline and terminal status onto its own track', () => {
    const source = new CodexSubagentSource();
    source.observeParentItem(ACTIVITY_LIST_DIRS, 'started', {});
    source.observeChildNotification(
      'item/started',
      { threadId: '01a0ba43-41ee-7d60-8a4f-0acae8dcbc07', item: ACTIVITY_GRANDCHILD },
      {},
    );

    const delta = source.observeChildNotification(
      'item/agentMessage/delta',
      { threadId: '01a0ba43-66c8-7f82-a9bf-3f4166ef0eb8', itemId: 'g1', delta: 'deep' },
      {},
    );
    expect(delta.filter(isTimeline).map((event) => event.event.type)).toEqual(['content_started', 'text_delta']);
    expect(delta.filter(isTimeline).every((event) => event.subagent_id === 'call_00_A3wWiqSPMRmchObp9eKT2275')).toBe(true);

    const done = source.observeChildNotification(
      'turn/completed',
      { threadId: '01a0ba43-66c8-7f82-a9bf-3f4166ef0eb8', turn: { status: 'completed' } },
      {},
    );
    expect(done.filter(isUpsert)).toEqual([
      expect.objectContaining({ subagent_id: 'call_00_A3wWiqSPMRmchObp9eKT2275', status: 'completed' }),
    ]);
    // The intermediate track is untouched by its child's lifecycle.
    expect(source.routeThreadId('01a0ba43-41ee-7d60-8a4f-0acae8dcbc07', ROOT_THREAD)).toBe('child');
  });

  it('declares the grandchild immediately, without waiting for its own thread to be claimed', () => {
    const source = new CodexSubagentSource();
    // The intermediate child has not been declared yet — and must not have to
    // be: a declaration is applied straight away, so the pending buffer (which
    // trims its oldest entries under pressure) can never eat one.
    const declared = source.observeChildNotification(
      'item/started',
      { threadId: '01a0ba43-41ee-7d60-8a4f-0acae8dcbc07', item: ACTIVITY_GRANDCHILD },
      {},
    );
    expect(declared.filter(isUpsert).map((event) => event.subagent_id)).toEqual([
      'call_00_A3wWiqSPMRmchObp9eKT2275',
    ]);
    expect(source.routeThreadId('01a0ba43-66c8-7f82-a9bf-3f4166ef0eb8', ROOT_THREAD)).toBe('child');

    // The parent's later declaration of the intermediate child still lands its
    // own track, and never re-declares the grandchild.
    const parent = source.observeParentItem(ACTIVITY_LIST_DIRS, 'started', {});
    expect(parent.filter(isUpsert).map((event) => event.subagent_id)).toEqual([
      'call_00_ve8rk9zc7gFaheNbTy8f6403',
    ]);
  });

  it('patches title and subtitle when a re-declaration reports a fuller agent path', () => {
    const source = new CodexSubagentSource();
    source.observeParentItem({ ...ACTIVITY_LIST_DIRS, agentPath: '/root' }, 'started', {});

    const events = source.observeParentItem(ACTIVITY_LIST_DIRS, 'started', {});

    expect(events.filter(isUpsert)).toEqual([
      expect.objectContaining({
        subagent_id: 'call_00_ve8rk9zc7gFaheNbTy8f6403',
        title: 'list_tauri_dirs',
        subtitle: '/root/list_tauri_dirs',
      }),
    ]);
  });

  it('takes the display name from the final path segment, whatever the separator', () => {
    const source = new CodexSubagentSource();

    const windows = source.observeParentItem(
      { ...ACTIVITY_SCAN_SRC, agentPath: 'C:\\work\\scan_src' },
      'started',
      {},
    );
    expect(windows.filter(isUpsert)[0]).toMatchObject({
      subagent_id: 'call_00_KapLrhSWlODQdZDkANYI1759',
      title: 'scan_src',
      subtitle: 'C:\\work\\scan_src',
    });

    // A path with no segment yields no name; the descriptor keeps a null title
    // and the frontend shows its unnamed-subagent fallback.
    const nameless = source.observeParentItem(
      { ...ACTIVITY_SCAN_SRC, id: 'call_00_root_only', agentThreadId: 'thread-root-only', agentPath: '/' },
      'started',
      {},
    );
    expect(nameless.filter(isUpsert)[0]).toMatchObject({
      subagent_id: 'call_00_root_only',
      title: null,
      subtitle: '/',
    });
  });

  it('declares the grandchild only once when the nested declaration is mirrored', () => {
    const source = new CodexSubagentSource();
    source.observeParentItem(ACTIVITY_LIST_DIRS, 'started', {});
    const nested = { threadId: '01a0ba43-41ee-7d60-8a4f-0acae8dcbc07', item: ACTIVITY_GRANDCHILD };
    expect(source.observeChildNotification('item/started', nested, {}).filter(isUpsert)).toHaveLength(1);
    expect(source.observeChildNotification('item/completed', nested, {})).toEqual([]);
  });
});

describe('CodexSubagentSource orchestration calls', () => {
  it.each(['wait', 'sendInput', 'resumeAgent', 'closeAgent'])(
    'never creates a track from %s without a target thread',
    (tool) => {
      const source = new CodexSubagentSource();
      const item = {
        type: 'collabAgentToolCall',
        id: 'call_00_hgxonyQ5m14XHo6HaGxKh5416',
        tool,
        status: 'inProgress',
        receiverThreadIds: [],
        agentsStates: {},
      };

      expect(source.observeParentItem(item, 'started', {})).toEqual([]);
      expect(source.observeParentItem({ ...item, status: 'completed' }, 'completed', {})).toEqual([]);
      expect(source.hasRunningTasks()).toBe(false);
    },
  );

  it('aggregates an orchestration call onto the declared child instead of forking a track', () => {
    const source = new CodexSubagentSource();
    source.observeParentItem(collabItem(), 'started', {});

    const events = source.observeParentItem(
      collabItem({
        id: 'call-2',
        tool: 'wait',
        status: 'completed',
        agentsStates: { 'child-thread-1': { status: 'completed' } },
      }),
      'started',
      {},
    );

    expect(events.filter(isUpsert)).toEqual([
      expect.objectContaining({ subagent_id: 'call-1', status: 'completed' }),
    ]);
  });
});
