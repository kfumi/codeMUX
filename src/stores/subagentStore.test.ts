// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSidePanelStore } from './sidePanelStore';
import { useSubagentStore } from './subagentStore';

vi.mock('../lib/tauri', () => ({
  agentApi: {},
  fileApi: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
}));

describe('subagentStore', () => {
  beforeEach(() => {
    useSubagentStore.setState({ sessions: {}, continuationPending: {} });
    useSidePanelStore.getState().reset();
  });

  it('arms continuationPending when the last running child goes terminal and settles explicitly', () => {
    useSubagentStore.getState().applyUpsert('session-1', {
      subagent_id: 'toolu_1',
      status: 'running',
    });
    useSubagentStore.getState().applyUpsert('session-1', {
      subagent_id: 'toolu_2',
      status: 'running',
    });
    expect(useSubagentStore.getState().continuationPending['session-1']).toBeFalsy();

    // First child finishes: the second is still running, so no wait yet.
    useSubagentStore.getState().applyUpsert('session-1', {
      subagent_id: 'toolu_1',
      status: 'completed',
    });
    expect(useSubagentStore.getState().continuationPending['session-1']).toBe(false);

    // Last child finishes: the parent summary turn is about to start.
    useSubagentStore.getState().applyUpsert('session-1', {
      subagent_id: 'toolu_2',
      status: 'completed',
    });
    expect(useSubagentStore.getState().continuationPending['session-1']).toBe(true);

    // The flow's terminal event (real or synthesized) settles it.
    useSubagentStore.getState().markContinuationSettled('session-1');
    expect(useSubagentStore.getState().continuationPending['session-1']).toBe(false);
  });

  it('disarms continuationPending when a new child starts or the session is hydrated', () => {
    useSubagentStore.getState().applyUpsert('session-1', {
      subagent_id: 'toolu_1',
      status: 'running',
    });
    useSubagentStore.getState().applyUpsert('session-1', {
      subagent_id: 'toolu_1',
      status: 'completed',
    });
    expect(useSubagentStore.getState().continuationPending['session-1']).toBe(true);

    useSubagentStore.getState().applyUpsert('session-1', {
      subagent_id: 'toolu_2',
      status: 'running',
    });
    expect(useSubagentStore.getState().continuationPending['session-1']).toBe(false);

    useSubagentStore.getState().replaceSession('session-1', {
      subagents: [{ subagentId: 'toolu_1', status: 'completed' }],
      timelines: {},
    });
    expect(useSubagentStore.getState().continuationPending['session-1']).toBe(false);
  });

  it('applyUpsert creates then sticky-merges descriptors', () => {
    useSubagentStore.getState().applyUpsert('session-1', {
      subagent_id: 'toolu_1',
      provider: 'claude',
      title: 'Explore',
      description: 'find entry points',
      status: 'running',
      tool_call_id: 'toolu_1',
    });
    // Omitted fields keep their value; only subtitle arrives.
    useSubagentStore.getState().applyUpsert('session-1', {
      subagent_id: 'toolu_1',
      subtitle: 'tokens ↑3.2k',
    });
    // Terminal status wins over a later omitted/running-less upsert.
    useSubagentStore.getState().applyUpsert('session-1', {
      subagent_id: 'toolu_1',
      status: 'completed',
    });

    const descriptor = useSubagentStore.getState().sessions['session-1']?.descriptors['toolu_1'];
    expect(descriptor).toMatchObject({
      subagentId: 'toolu_1',
      title: 'Explore',
      description: 'find entry points',
      subtitle: 'tokens ↑3.2k',
      status: 'completed',
      toolCallId: 'toolu_1',
    });
    expect(useSubagentStore.getState().sessions['session-1']?.order).toEqual(['toolu_1']);
  });

  it('appendEvent dedupes on event_id and keeps timeline order', () => {
    useSubagentStore.getState().appendEvent('session-1', 'toolu_1', { type: 'tool_started', event_id: 'e1' }, 'e1');
    useSubagentStore.getState().appendEvent('session-1', 'toolu_1', { type: 'tool_finished', event_id: 'e2' }, 'e2');
    useSubagentStore.getState().appendEvent('session-1', 'toolu_1', { type: 'tool_finished', event_id: 'e2' }, 'e2');

    const events = useSubagentStore.getState().sessions['session-1']?.events['toolu_1'] ?? [];
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: 'tool_finished' });
  });

  it('replaceSession hydrates descriptors and timelines', () => {
    useSubagentStore.getState().replaceSession('session-1', {
      subagents: [
        {
          subagentId: 'toolu_1',
          provider: 'claude',
          title: 'Explore',
          description: 'find entry points',
          status: 'failed',
          toolCallId: 'toolu_1',
        },
      ],
      timelines: {
        toolu_1: [
          { type: 'user_message', content: 'find entry points', event_id: 'e0' },
          { type: 'tool_started', tool_use_id: 'c1', name: 'Grep', input: {}, event_id: 'e1' },
        ],
      },
    });

    const state = useSubagentStore.getState().sessions['session-1'];
    expect(state?.descriptors['toolu_1']).toMatchObject({ status: 'failed', title: 'Explore' });
    expect(state?.events['toolu_1']).toHaveLength(2);
    expect(state?.seenEventIds['toolu_1']?.has('e1')).toBe(true);
  });

  it('clearSession removes the session state', () => {
    useSubagentStore.getState().applyUpsert('session-1', { subagent_id: 'toolu_1' });
    expect(useSubagentStore.getState().sessions['session-1']).toBeDefined();
    useSubagentStore.getState().clearSession('session-1');
    expect(useSubagentStore.getState().sessions['session-1']).toBeUndefined();
  });

  it('routeSubagentSidecarEvent routes upserts and timelines and ignores other events', () => {
    const store = useSubagentStore.getState();
    expect(store.routeSubagentSidecarEvent(JSON.stringify({ type: 'sidecar_ready' }), 'session-1')).toBe(false);
    expect(store.routeSubagentSidecarEvent('not json', 'session-1')).toBe(false);

    expect(store.routeSubagentSidecarEvent(JSON.stringify({
      type: 'subagent_upsert',
      session_id: 'session-1',
      subagent_id: 'toolu_1',
      provider: 'claude',
      status: 'running',
      title: 'Explore',
      event_id: 'u1',
    }), 'session-1')).toBe(true);

    expect(store.routeSubagentSidecarEvent(JSON.stringify({
      type: 'subagent_timeline',
      session_id: 'session-1',
      subagent_id: 'toolu_1',
      event: { type: 'tool_started', tool_use_id: 'c1', name: 'Grep', input: {}, event_id: 'e1', sequence: 0 },
      event_id: 'env-1',
    }), 'session-1')).toBe(true);

    const state = useSubagentStore.getState().sessions['session-1'];
    expect(state?.descriptors['toolu_1']?.status).toBe('running');
    expect(state?.events['toolu_1']).toHaveLength(1);
  });

  it('openInSidePanel opens a subagent-kind tab in the session scope', () => {
    useSubagentStore.getState().applyUpsert('session-9', {
      subagent_id: 'toolu_1',
      provider: 'claude',
      description: 'find entry points',
      status: 'running',
    });

    useSubagentStore.getState().openInSidePanel('session-9', 'toolu_1');

    const panel = useSidePanelStore.getState();
    expect(panel.isOpen).toBe(true);
    expect(panel.activeScopeId).toBe('session-9');
    const tab = panel.tabs.find((entry) => entry.id === 'session-9:subagent:toolu_1');
    expect(tab).toMatchObject({
      kind: 'subagent',
      title: 'find entry points',
      subagentId: 'toolu_1',
      subagentSessionId: 'session-9',
      subagentStatus: 'running',
    });

    // Reopening the same card reuses the tab instead of stacking.
    useSubagentStore.getState().openInSidePanel('session-9', 'toolu_1');
    expect(useSidePanelStore.getState().tabs.filter((entry) => entry.subagentId === 'toolu_1')).toHaveLength(1);
  });
});
