// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../types/session';

const startSessionMock = vi.fn<
  (
    sessionId: string,
    prompt: string,
    cwd: string,
    onEvent: (event: string) => void,
  ) => Promise<void>
>();

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../lib/tauri', () => ({
  agentApi: {
    startSession: startSessionMock,
    interrupt: vi.fn(),
    shutdown: vi.fn(),
    resetSession: vi.fn(),
    sendToolResponse: vi.fn(),
    respondToAgentPermission: vi.fn(),
    saveEvents: vi.fn(),
    getEvents: vi.fn(),
    loadSessionEvents: vi.fn(() => Promise.resolve([])),
    loadSessionSubagents: vi.fn(() => Promise.resolve({ subagents: [], timelines: {} })),
    loadClaudeSessionEvents: vi.fn(() => Promise.resolve([])),
    loadCodexSessionEvents: vi.fn(() => Promise.resolve([])),
    loadOpenCodeSessionEvents: vi.fn(() => Promise.resolve([])),
    loadLatestTokenUsage: vi.fn(() => Promise.resolve(null)),
    rewindSession: vi.fn(),
    enrichAttachments: vi.fn(),
  },
  sessionApi: {
    create: vi.fn(),
    getAll: vi.fn(),
    delete: vi.fn(),
    updateTitle: vi.fn(),
    updateProvider: vi.fn(),
    updatePermissions: vi.fn(() => Promise.resolve()),
    updateWorkingPath: vi.fn(() => Promise.resolve()),
    touch: vi.fn(() => Promise.resolve()),
    getMessages: vi.fn(),
  },
  configApi: {
    get: vi.fn(),
  },
  fileApi: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
  companionApi: {
    isSessionTurnActive: vi.fn(() => Promise.resolve(false)),
  },
  gitApi: {},
  mcpApi: {},
  skillApi: {},
  appApi: {},
}));

describe('agentStore subagent event routing', () => {
  let onEvent: ((event: string) => void) | undefined;
  const sessionId = 'session-subagent-routing';

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    onEvent = undefined;
  });

  async function prime() {
    const { useAgentStore } = await import('./agentStore');
    const { useSessionStore } = await import('./sessionStore');
    const { useSubagentStore } = await import('./subagentStore');

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

    startSessionMock.mockImplementation(async (_id, _prompt, _cwd, eventSink) => {
      onEvent = eventSink;
    });

    return { useAgentStore, useSubagentStore };
  }

  it('routes subagent events to subagentStore and keeps them out of the parent timeline', async () => {
    const { useAgentStore, useSubagentStore } = await prime();

    await useAgentStore.getState().startQuery(sessionId, 'launch agent', 'D:\\workspace');
    expect(onEvent).toBeDefined();

    onEvent?.(JSON.stringify({
      type: 'subagent_upsert',
      session_id: sessionId,
      subagent_id: 'toolu_1',
      provider: 'claude',
      title: 'Explore',
      status: 'running',
      tool_call_id: 'toolu_1',
      event_id: 'u1',
    }));
    onEvent?.(JSON.stringify({
      type: 'subagent_timeline',
      session_id: sessionId,
      subagent_id: 'toolu_1',
      event: { type: 'tool_started', tool_use_id: 'c1', name: 'Grep', input: {}, event_id: 'e1', sequence: 0 },
      event_id: 'env-1',
    }));
    onEvent?.(JSON.stringify({
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

    onEvent?.(JSON.stringify({
      type: 'assistant',
      uuid: 'a-sidechain',
      session_id: 'claude-native',
      isSidechain: true,
      parent_tool_use_id: 'toolu_1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'sidechain chatter' }] },
    }));
    onEvent?.(JSON.stringify({ type: 'sidecar_query_done' }));

    const parentEvents = useAgentStore.getState().events[sessionId] ?? [];
    // The sidechain assistant message must not enter the parent timeline.
    expect(parentEvents.some((event) => event.kind === 'assistant')).toBe(false);
    expect(parentEvents.some((event) => (event.data as { parent_tool_use_id?: unknown })?.parent_tool_use_id)).toBe(false);
    expect(useSubagentStore.getState().sessions[sessionId]).toBeUndefined();
  });
});
