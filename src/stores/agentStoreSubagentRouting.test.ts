// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../types/session';

// 静态导入:如果在 it() 内 await import,首次模块图加载会计入测试超时(15s)。
import { useAgentStore } from './agentStore';
import { useSessionStore } from './sessionStore';
import { useSubagentStore } from './subagentStore';

const { sendMessageViaDaemonMock, sessionHandlerRef } = vi.hoisted(() => ({
  sendMessageViaDaemonMock: vi.fn<(sessionId: string, prompt: string, inputPayload?: unknown, options?: { delivery?: 'steer'; requestId?: string }) => Promise<void>>(),
  sessionHandlerRef: { current: undefined as ((raw: string) => void) | undefined },
}));

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../lib/daemon-session-bridge', () => ({
  registerDaemonSessionHandler: vi.fn((_sessionId: string, handler: (raw: string) => void) => {
    sessionHandlerRef.current = handler;
  }),
  unregisterDaemonSessionHandler: vi.fn(),
  getLastEventSequence: vi.fn(() => -1),
  setLastEventSequence: vi.fn(),
  catchUpTimelineAfterSequence: vi.fn(),
  teardownDaemonSession: vi.fn(),
  resetDaemonSessionBridge: vi.fn(),
}));

vi.mock('../lib/facades/daemon-facade', () => ({
  ensureDaemonClient: vi.fn(() => Promise.resolve({
    sendMessage: sendMessageViaDaemonMock,
    subscribeSession: vi.fn(() => () => undefined),
  })),
  daemonFacade: {
    sendMessageViaDaemon: sendMessageViaDaemonMock,
    patchSessionViaDaemon: vi.fn(() => Promise.resolve()),
    getTimeline: vi.fn(() => Promise.resolve({ events: [], hasMore: false })),
    interruptViaDaemon: vi.fn(),
    respondToPermissionViaDaemon: vi.fn(),
    respondToInteractiveViaDaemon: vi.fn(),
    updateWorkingPath: vi.fn(() => Promise.resolve()),
    touchSession: vi.fn(() => Promise.resolve()),
    listSessions: vi.fn(() => Promise.resolve([])),
    listArchivedSessions: vi.fn(() => Promise.resolve([])),
    listProjects: vi.fn(() => Promise.resolve([])),
    ensureClient: vi.fn(),
  },
  getDaemonClientInitError: vi.fn(() => null),
  resetDaemonClient: vi.fn(),
}));

describe('agentStore subagent event routing', () => {
  const sessionId = 'session-subagent-routing';

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionHandlerRef.current = undefined;
    sendMessageViaDaemonMock.mockResolvedValue(undefined);
  });

  async function prime() {

    useSubagentStore.setState({ sessions: {} });

    const session: Session = {
      id: sessionId,
      title: 'Subagent Routing',
      agent_kind: 'claude_code',
      provider_id: null,
      model: null,
      mode: 'agent',
      project_id: null,
      created_at: '',
      updated_at: '',
    };
    useSessionStore.setState({
      sessions: [session],
      activeSessionId: session.id,
      isLoading: false,
      error: null,
    });

    return { useAgentStore, useSubagentStore };
  }

  it('routes subagent events to subagentStore and keeps them out of the parent timeline', async () => {
    const { useAgentStore, useSubagentStore } = await prime();

    await useAgentStore.getState().startQuery(sessionId, 'launch agent', 'D:\\workspace');
    expect(sessionHandlerRef.current).toBeDefined();

    sessionHandlerRef.current?.(JSON.stringify({
      type: 'subagent_upsert',
      session_id: sessionId,
      subagent_id: 'toolu_1',
      provider: 'claude',
      title: 'Explore',
      status: 'running',
      tool_call_id: 'toolu_1',
      event_id: 'u1',
    }));
    sessionHandlerRef.current?.(JSON.stringify({
      type: 'subagent_timeline',
      session_id: sessionId,
      subagent_id: 'toolu_1',
      event: { type: 'tool_started', tool_use_id: 'c1', name: 'Grep', input: {}, event_id: 'e1', sequence: 0 },
      event_id: 'env-1',
    }));
    sessionHandlerRef.current?.(JSON.stringify({
      type: 'sidecar_query_done',
    }));

    // Parent timeline contains neither the subagent events nor raw sidechain.
    const parentEvents = useAgentStore.getState().events[sessionId] ?? [];
    expect(parentEvents.some((event) => JSON.stringify(event.data ?? {}).includes('subagent_'))).toBe(false);
    expect(parentEvents.some((event) => event.kind === 'raw' && (event.data as { parent_tool_use_id?: unknown })?.parent_tool_use_id)).toBe(false);

    const state = useSubagentStore.getState().sessions[sessionId];
    expect(state?.descriptors['toolu_1']).toMatchObject({ status: 'running', title: 'Explore' });
    expect(state?.events['toolu_1']).toHaveLength(1);
  });

  it('ignores raw sidechain frames as before', async () => {
    const { useAgentStore, useSubagentStore } = await prime();

    await useAgentStore.getState().startQuery(sessionId, 'hello', 'D:\\workspace');

    sessionHandlerRef.current?.(JSON.stringify({
      type: 'assistant',
      uuid: 'a-sidechain',
      session_id: 'claude-native',
      isSidechain: true,
      parent_tool_use_id: 'toolu_1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'sidechain chatter' }] },
    }));
    sessionHandlerRef.current?.(JSON.stringify({ type: 'sidecar_query_done' }));

    const parentEvents = useAgentStore.getState().events[sessionId] ?? [];
    // The sidechain assistant message must not enter the parent timeline.
    expect(parentEvents.some((event) => event.kind === 'assistant')).toBe(false);
    expect(parentEvents.some((event) => (event.data as { parent_tool_use_id?: unknown })?.parent_tool_use_id)).toBe(false);
    expect(useSubagentStore.getState().sessions[sessionId]).toBeUndefined();
  });
});
