// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../types/session';
import type { AgentUserMessageLocator } from '../types/agent';

import { daemonFacade } from '../lib/facades/daemon-facade';
// 静态导入:如果在 it() 内 await import,首次模块图加载会计入测试超时(15s)。
import {
  AGENT_REWIND_CAPABILITIES,
  extractChangedFilesFromEvents,
  supportsRewindMode,
  useAgentStore,
} from './agentStore';
import { useSessionStore } from './sessionStore';
import { useSettingsStore } from './settingsStore';
import { useSubagentStore } from './subagentStore';

const {
  startSessionMock,
  enrichAttachmentsMock,
  saveEventsMock,
  getEventsMock,
  loadClaudeSessionEventsMock,
  loadCodexSessionEventsMock,
  loadSessionEventsMock,
  resyncSessionFromNativeMock,
  loadLatestTokenUsageMock,
  rewindSessionMock,
  respondToAgentPermissionMock,
  respondToComputerUseApprovalMock,
  sessionHandlers,
  sessionStateHandlers,
  sessionTimelineResetHandlers,
  reconcileHistorySequenceMock,
  resetLastEventSequenceMock,
  sendMessageViaDaemonMock,
  interruptViaDaemonMock,
  getTimelineMock,
  updateWorkingPathMock,
  catchUpTimelineAfterSequenceMock,
} = vi.hoisted(() => {
  const sessionHandlers = new Map<string, (raw: string) => void>();
  const sessionStateHandlers = new Map<string, (running: boolean) => void>();
  const sessionTimelineResetHandlers = new Map<string, () => void>();
  const reconcileHistorySequenceMock = vi.fn<
    (sessionId: string, highest: number) => 'reset' | 'advanced' | 'unchanged'
  >();
  const resetLastEventSequenceMock = vi.fn<(sessionId: string, sequence?: number) => void>();
  const loadClaudeSessionEventsMock = vi.fn<(appSessionId: string) => Promise<Record<string, unknown>[]>>();
  const loadCodexSessionEventsMock = vi.fn<(appSessionId: string) => Promise<Record<string, unknown>[]>>();
  const loadSessionEventsMock = vi.fn<(appSessionId: string) => Promise<Record<string, unknown>[]>>();
  const startSessionMock = vi.fn<
    (
      sessionId: string,
      prompt: string,
      cwd: string,
      onEvent: (event: string) => void,
      reasoningEffort?: string,
      inputPayload?: { text: string },
    ) => Promise<void>
  >();
  const sendMessageViaDaemonMock = vi.fn<
    (sessionId: string, prompt: string, payload?: { text: string }, options?: { delivery?: 'steer'; requestId?: string }) => Promise<void>
  >();
  const interruptViaDaemonMock = vi.fn<(sessionId: string) => Promise<void>>();
  const getTimelineMock = vi.fn(async (sessionId: string) => {
    const { useSessionStore } = await import('./sessionStore');
    const session = useSessionStore.getState().sessions.find((entry) => entry.id === sessionId)
      ?? useSessionStore.getState().archivedSessions.find((entry) => entry.id === sessionId);
    const agentKind = session?.agent_kind ?? 'claude_code';
    let events = await loadSessionEventsMock(sessionId);
    if (!events?.length) {
      if (agentKind === 'codex') {
        events = await loadCodexSessionEventsMock(sessionId);
      } else {
        events = await loadClaudeSessionEventsMock(sessionId);
      }
    }
    return { events: events ?? [], hasMore: false };
  });
  return {
    sessionHandlers,
    sessionStateHandlers,
    sessionTimelineResetHandlers,
    reconcileHistorySequenceMock,
    resetLastEventSequenceMock,
    startSessionMock,
    enrichAttachmentsMock: vi.fn<
      (attachments: Array<{ type: string; name: string; mediaType: string; dataUrl: string }>) => Promise<{ blocks: Array<{ attachment_name: string; markdown: string; ok: boolean; error?: string }> }>
    >(),
    saveEventsMock: vi.fn<(sessionId: string, eventsJson: string) => Promise<void>>(),
    getEventsMock: vi.fn<(sessionId: string) => Promise<string>>(),
    loadClaudeSessionEventsMock,
    loadCodexSessionEventsMock,
    loadSessionEventsMock,
    resyncSessionFromNativeMock: vi.fn<(appSessionId: string) => Promise<{ eventCount: number }>>(),
    loadLatestTokenUsageMock: vi.fn<(appSessionId: string, agentKind: string, freshness: 'live_synced' | 'restored') => Promise<Record<string, unknown> | null>>(),
    rewindSessionMock: vi.fn<(appSessionId: string, agentKind: string, target?: AgentUserMessageLocator, mode?: string) => Promise<{ filesChanged?: number }>>(),
    respondToAgentPermissionMock: vi.fn(),
    respondToComputerUseApprovalMock: vi.fn(),
    sendMessageViaDaemonMock,
    interruptViaDaemonMock,
    getTimelineMock,
    updateWorkingPathMock: vi.fn<(sessionId: string, workingPath: string) => Promise<unknown>>(
      () => Promise.resolve(),
    ),
    catchUpTimelineAfterSequenceMock: vi.fn<(sessionId: string) => Promise<void>>(),
  };
});

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../lib/daemon-session-bridge', () => ({
  registerDaemonSessionHandler: vi.fn((
    sessionId: string,
    handler: (raw: string) => void,
    onState?: (running: boolean) => void,
    onTimelineReset?: () => void,
  ) => {
    sessionHandlers.set(sessionId, handler);
    if (onState) sessionStateHandlers.set(sessionId, onState);
    if (onTimelineReset) sessionTimelineResetHandlers.set(sessionId, onTimelineReset);
  }),
  unregisterDaemonSessionHandler: vi.fn((sessionId: string) => {
    sessionHandlers.delete(sessionId);
    sessionStateHandlers.delete(sessionId);
    sessionTimelineResetHandlers.delete(sessionId);
  }),
  getLastEventSequence: vi.fn(() => -1),
  setLastEventSequence: vi.fn(),
  resetLastEventSequence: resetLastEventSequenceMock,
  reconcileHistorySequence: reconcileHistorySequenceMock,
  catchUpTimelineAfterSequence: catchUpTimelineAfterSequenceMock,
  markTimelineSequencesAccepted: vi.fn(),
}));

vi.mock('../lib/facades/daemon-facade', () => ({
  ensureDaemonClient: vi.fn(() => Promise.resolve({
    sendMessage: sendMessageViaDaemonMock,
    getTimeline: getTimelineMock,
  })),
  daemonFacade: {
    sendMessageViaDaemon: sendMessageViaDaemonMock,
    getTimeline: getTimelineMock,
    interruptViaDaemon: interruptViaDaemonMock,
    respondToPermissionViaDaemon: respondToAgentPermissionMock,
    respondToComputerUseApproval: respondToComputerUseApprovalMock,
    respondToInteractiveViaDaemon: vi.fn(),
    rewindSession: rewindSessionMock,
    resyncSessionFromNative: resyncSessionFromNativeMock,
    updateWorkingPath: updateWorkingPathMock,
    touchSession: vi.fn(() => Promise.resolve()),
    updateSessionTitle: vi.fn(() => Promise.resolve()),
    listSessions: vi.fn(() => Promise.resolve([])),
    listArchivedSessions: vi.fn(() => Promise.resolve([])),
    listProjects: vi.fn(() => Promise.resolve([])),
    ensureClient: vi.fn(),
    enrichAttachments: enrichAttachmentsMock,
    loadLatestTokenUsage: loadLatestTokenUsageMock,
    loadSessionSubagents: vi.fn(() => Promise.resolve({ subagents: [], timelines: {} })),
    ensureAgentSession: vi.fn(() => Promise.resolve()),
    getAgentSessionInfo: vi.fn(() => Promise.resolve({ agentSessionId: null, messagePath: null })),
    isSessionTurnActive: vi.fn(() => Promise.resolve(false)),
  },
  getDaemonClientInitError: vi.fn(() => null),
  resetDaemonClient: vi.fn(),
}));

const { agentLoggerSpies } = vi.hoisted(() => ({
  agentLoggerSpies: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// `agentStore` 的 logger 是模块私有的（`const logger = createLogger('agentStore')`），
// 只能在模块工厂这一层换成 spy，才能对"一次流式突发发出几条"做计数断言。
// 其余导出（`serializeError` / `setMinLogLevel` …）保持真实实现。
vi.mock('../lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/logger')>();
  return {
    ...actual,
    createLogger: () => agentLoggerSpies,
  };
});

describe('agent store Codex history loading', () => {
  async function primeSession(agentKind: Session['agent_kind']) {

    const session: Session = {
      id: `session-${agentKind}-1`,
      title: `${agentKind} History`,
      agent_kind: agentKind,
      provider_id: null,
      model: 'o4-mini',
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

    useAgentStore.setState({
      events: {},
      eventTimestamps: {},
      isRunning: {},
      backgroundLive: {},
      error: {},
      mcpRuntimeStatus: {},
      todos: {},
      tokenUsageBySession: {},
      tokenUsageRefreshRequests: {},
      streamingThinking: {},
      streamingText: {},
      streamingEstimatedOutputTokens: {},
      forceStopped: {},
      queuedQueries: {},
      queuePaused: {},
      streamingToolInputs: {},
      streamingToolMeta: {},
      streamingToolIndexMap: {},
      streamedToolUseIds: {},
      changedFiles: {},
      fileOriginals: {},
      acknowledgedFiles: {},
      pendingPermissions: {},
    });

    return session;
  }

  beforeEach(async () => {
    vi.useRealTimers();
    startSessionMock.mockClear();
    enrichAttachmentsMock.mockClear();
    sendMessageViaDaemonMock.mockClear();
    interruptViaDaemonMock.mockClear();
    getTimelineMock.mockClear();
    loadSessionEventsMock.mockClear();
    loadClaudeSessionEventsMock.mockClear();
    loadCodexSessionEventsMock.mockClear();
    resyncSessionFromNativeMock.mockClear();
    loadLatestTokenUsageMock.mockClear();
    rewindSessionMock.mockClear();
    saveEventsMock.mockClear();
    getEventsMock.mockClear();
    respondToAgentPermissionMock.mockClear();
    catchUpTimelineAfterSequenceMock.mockClear();
    respondToComputerUseApprovalMock.mockClear();
    enrichAttachmentsMock.mockResolvedValue({
      blocks: [{ attachment_name: 'screen.png', markdown: 'Visible terminal error.', ok: true }],
    });

    useSettingsStore.setState({
      config: {
        model_providers: [],
        active_provider_id: null,
        agent_defaults: { default_agent_kind: 'codex' },
        agent_configs: {
          claude_code: {},
          codex: {},
          gemini_cli: {},
          opencode: {},
        },
        compact_ai_output: false,
        default_open_target: 'cursor',
        notifications: { system_enabled: true, sound_enabled: true, sound: 'ding' },
        theme: 'System',
        attachment_enrichment: { enabled: false, api_key: '', base_url: '', model: '' },
      },
      isLoading: false,
      error: null,
      proxyRunning: false,
      proxyUrl: null,
      proxyToggling: false,
    });

    startSessionMock.mockImplementation(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Codex reply' }],
        },
      }));
      onEvent(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-1',
        session_id: sessionId,
        duration_ms: 5,
        duration_api_ms: 4,
        num_turns: 1,
        result: '',
        usage: {
          input_tokens: 5,
          output_tokens: 7,
        },
      }));
      onEvent(JSON.stringify({ type: 'sidecar_query_done' }));
    });

    interruptViaDaemonMock.mockResolvedValue(undefined);

    sendMessageViaDaemonMock.mockImplementation(async (sessionId, prompt, payload, options) => {
      if (options?.delivery === 'steer') {
        return;
      }
      const handler = sessionHandlers.get(sessionId);
      if (!handler) return;
      await startSessionMock(sessionId, prompt, '', handler, undefined, payload);
    });

    loadSessionEventsMock.mockResolvedValue([]);
    getEventsMock.mockResolvedValue(JSON.stringify({
      events: [
        { kind: 'user', data: { content: 'stale sqlite event' } },
      ],
      timestamps: [1],
    }));
    loadClaudeSessionEventsMock.mockResolvedValue([]);
    loadCodexSessionEventsMock.mockResolvedValue([]);
    loadLatestTokenUsageMock.mockResolvedValue(null);
    rewindSessionMock.mockResolvedValue({});
    localStorage.clear();
  });

  it('queues messages submitted during a running turn and dispatches them in order', async () => {
    const session = await primeSession('codex');
    let finishFirstTurn: ((event: string) => void) | undefined;

    startSessionMock.mockImplementationOnce(async (_sessionId, _prompt, _cwd, onEvent) => {
      finishFirstTurn = onEvent;
    });

    await useAgentStore.getState().startQuery(session.id, 'first message', 'D:\\workspace');
    await useAgentStore.getState().startQuery(session.id, 'second message', 'D:\\workspace');
    await useAgentStore.getState().startQuery(session.id, 'third message', 'D:\\workspace');

    expect(useAgentStore.getState().isRunning[session.id]).toBe(true);
    expect(useAgentStore.getState().queuedQueries[session.id]?.map((query) => query.prompt)).toEqual([
      'second message',
      'third message',
    ]);

    finishFirstTurn?.(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      session_id: session.id,
    }));

    await vi.waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledTimes(3);
      expect(startSessionMock.mock.calls[1]?.[1]).toBe('second message');
      expect(startSessionMock.mock.calls[2]?.[1]).toBe('third message');
    });
    expect(useAgentStore.getState().queuedQueries[session.id]).toEqual([]);
  });

  it('queues messages while background subagents run and dispatches when the flow settles', async () => {
    const session = await primeSession('claude_code');

    // 回合 1 正常跑完(注册会话 handler),子智能体仍在后台运行。
    await useAgentStore.getState().startQuery(session.id, 'first message', 'D:\\workspace');
    useSubagentStore.getState().applyUpsert(session.id, {
      subagent_id: 'sub-1',
      provider: 'claude',
      status: 'running',
      tool_call_id: 'sub-1',
    });

    // 子智能体未收尾:新消息进本地可见队列,不直发 daemon。
    await useAgentStore.getState().startQuery(session.id, 'second message', 'D:\\workspace');
    expect(useAgentStore.getState().queuedQueries[session.id]?.map((query) => query.prompt)).toEqual([
      'second message',
    ]);
    expect(sendMessageViaDaemonMock).toHaveBeenCalledTimes(1);

    // 最后一个子智能体结束,汇总回合以合成边界收尾 → 队列按序派发。
    useSubagentStore.getState().applyUpsert(session.id, { subagent_id: 'sub-1', status: 'completed' });
    sessionHandlers.get(session.id)?.(JSON.stringify({
      type: 'turn_finished',
      session_id: session.id,
      outcome: 'completed',
      synthetic: true,
    }));

    await vi.waitFor(() => {
      expect(sendMessageViaDaemonMock).toHaveBeenCalledWith(
        session.id,
        'second message',
        expect.objectContaining({ text: 'second message' }),
      );
    });
    expect(useAgentStore.getState().queuedQueries[session.id]).toEqual([]);
  });

  it('background real-result terminal clears isRunning and drains the queue', async () => {
    const session = await primeSession('claude_code');

    await useAgentStore.getState().startQuery(session.id, 'first message', 'D:\\workspace');
    useSubagentStore.getState().applyUpsert(session.id, {
      subagent_id: 'sub-1',
      provider: 'claude',
      status: 'running',
      tool_call_id: 'sub-1',
    });
    await useAgentStore.getState().startQuery(session.id, 'second message', 'D:\\workspace');
    expect(useAgentStore.getState().queuedQueries[session.id]?.length).toBe(1);

    // 汇总回合被 daemon state 帧置为 running,随后以真实 result 收尾:
    // 背景回合终点要清掉卡真的 isRunning 并派发队列。
    useSubagentStore.getState().applyUpsert(session.id, { subagent_id: 'sub-1', status: 'completed' });
    useAgentStore.setState({ isRunning: { [session.id]: true } });
    sessionHandlers.get(session.id)?.(JSON.stringify({
      type: 'turn_finished',
      session_id: session.id,
      outcome: 'completed',
    }));

    await vi.waitFor(() => {
      expect(sendMessageViaDaemonMock).toHaveBeenCalledWith(
        session.id,
        'second message',
        expect.objectContaining({ text: 'second message' }),
      );
    });
    expect(useAgentStore.getState().isRunning[session.id]).toBe(false);
    expect(useAgentStore.getState().queuedQueries[session.id]).toEqual([]);
  });

  it('does not let a background synthetic boundary steal an active user turn', async () => {
    const session = await primeSession('claude_code');
    startSessionMock.mockImplementationOnce(async (_sessionId, _prompt, _cwd, onEvent) => {
      void onEvent;
    });

    await useAgentStore.getState().startQuery(session.id, 'first message', 'D:\\workspace');
    expect(useAgentStore.getState().isRunning[session.id]).toBe(true);

    await useAgentStore.getState().startQuery(session.id, 'second message', 'D:\\workspace');
    expect(useAgentStore.getState().queuedQueries[session.id]?.map((query) => query.prompt)).toEqual([
      'second message',
    ]);

    // 后台流的合成边界在用户回合进行中到达:不得派发、不得终止用户回合。
    sessionHandlers.get(session.id)?.(JSON.stringify({
      type: 'turn_finished',
      session_id: session.id,
      outcome: 'completed',
      synthetic: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(useAgentStore.getState().isRunning[session.id]).toBe(true);
    expect(useAgentStore.getState().queuedQueries[session.id]?.map((query) => query.prompt)).toEqual([
      'second message',
    ]);
    expect(sendMessageViaDaemonMock).toHaveBeenCalledTimes(1);
  });

  it('queues pi follow-ups during a running turn instead of sending them immediately', async () => {
    const session = await primeSession('pi');
    startSessionMock.mockImplementationOnce(async () => undefined);

    await useAgentStore.getState().startQuery(session.id, 'first message', 'D:\\workspace');
    await useAgentStore.getState().startQuery(session.id, 'second message', 'D:\\workspace');
    await useAgentStore.getState().startQuery(session.id, 'third message', 'D:\\workspace');

    expect(startSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMessageViaDaemonMock).toHaveBeenCalledTimes(1);
    expect(sendMessageViaDaemonMock).toHaveBeenCalledWith(
      session.id,
      'first message',
      expect.objectContaining({ text: 'first message' }),
    );
    expect(useAgentStore.getState().queuedQueries[session.id]?.map((query) => query.prompt)).toEqual([
      'second message',
      'third message',
    ]);
  });

  it('runQueuedQueryNow steers a running pi turn and keeps the remaining queue', async () => {
    const session = await primeSession('pi');
    let firstOnEvent: ((event: string) => void) | undefined;

    startSessionMock.mockImplementationOnce(async (_sessionId, _prompt, _cwd, onEvent) => {
      firstOnEvent = onEvent;
    });

    await useAgentStore.getState().startQuery(session.id, 'first message', 'D:\\workspace');
    await useAgentStore.getState().startQuery(session.id, 'second message', 'D:\\workspace');
    await useAgentStore.getState().startQuery(session.id, 'third message', 'D:\\workspace');

    const queueBefore = useAgentStore.getState().queuedQueries[session.id] ?? [];
    const promoted = queueBefore[1];
    expect(promoted?.prompt).toBe('third message');

    await useAgentStore.getState().runQueuedQueryNow(session.id, promoted!.id);

    expect(interruptViaDaemonMock).not.toHaveBeenCalled();
    expect(startSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMessageViaDaemonMock).toHaveBeenCalledWith(
      session.id,
      'third message',
      undefined,
      expect.objectContaining({ delivery: 'steer', requestId: expect.any(String) }),
    );
    expect(useAgentStore.getState().queuedQueries[session.id]?.map((query) => query.prompt)).toEqual([
      'second message',
    ]);
    expect(useAgentStore.getState().isRunning[session.id]).toBe(true);

    firstOnEvent?.(JSON.stringify({
      type: 'steer_result',
      request_id: (sendMessageViaDaemonMock.mock.calls.find((call) => (
        (call[3] as { delivery?: string })?.delivery === 'steer'
      ))?.[3] as { requestId: string }).requestId,
      ok: true,
    }));
    expect(useAgentStore.getState().queuedQueries[session.id]?.map((query) => query.prompt)).toEqual([
      'second message',
    ]);
  });

  it('does not stop a live desktop query when attaching to a background turn', async () => {
    const session = await primeSession('codex');
    vi.mocked(daemonFacade.isSessionTurnActive).mockResolvedValue(false);

    startSessionMock.mockImplementationOnce(async () => undefined);

    await useAgentStore.getState().startQuery(session.id, '1111', 'D:\\workspace');
    expect(useAgentStore.getState().isRunning[session.id]).toBe(true);

    await useAgentStore.getState().attachToActiveTurn(session.id, 'D:\\workspace');

    expect(useAgentStore.getState().isRunning[session.id]).toBe(true);
    expect(useAgentStore.getState().events[session.id]?.some((event) => (
      event.kind === 'user' && event.data.content === '1111'
    ))).toBe(true);
  });

  it('attachLiveSession subscribes the daemon stream and ends with the turn after a refresh', async () => {
    const session = await primeSession('codex');
    sessionHandlers.clear();
    vi.mocked(daemonFacade.isSessionTurnActive).mockResolvedValue(true);

    const attached = await useAgentStore.getState().attachLiveSession(session.id);

    expect(attached).toBe(true);
    expect(useAgentStore.getState().isRunning[session.id]).toBe(true);
    expect(sessionHandlers.has(session.id)).toBe(true);

    sessionHandlers.get(session.id)?.(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      session_id: session.id,
    }));

    await vi.waitFor(() => {
      expect(useAgentStore.getState().isRunning[session.id]).toBe(false);
    });
    expect(sessionHandlers.has(session.id)).toBe(true);
  });

  it('daemon 说会话已空闲时兜底清除卡住的回合(终止帧丢失场景)', async () => {
    const session = await primeSession('codex');
    sessionHandlers.clear();
    sessionStateHandlers.clear();

    // 回合起跑之后终止帧丢失(时间线重建导致去重水位线错位):isRunning 一直是 true。
    startSessionMock.mockImplementationOnce(async () => undefined);
    await useAgentStore.getState().startQuery(session.id, '卡住的回合', 'D:\\workspace');
    useAgentStore.setState({ streamingEstimatedOutputTokens: { [session.id]: 42 } });
    expect(useAgentStore.getState().isRunning[session.id]).toBe(true);

    const onState = sessionStateHandlers.get(session.id);
    expect(typeof onState).toBe('function');
    // 兜底收尾是边沿触发:daemon 先为这一回合置过活跃标记,之后的空闲才算「回合结束」。
    onState?.(true);
    onState?.(false);

    expect(useAgentStore.getState().isRunning[session.id]).toBe(false);
    expect(useAgentStore.getState().queryStartTime[session.id]).toBeUndefined();
    expect(useAgentStore.getState().streamingEstimatedOutputTokens[session.id]).toBe(0);
    // 兜底收尾后必须对账一次时间线尾部:把乱序窗口里漏掉的低频帧(产物汇总等)补回来。
    expect(catchUpTimelineAfterSequenceMock).toHaveBeenCalledWith(session.id);
  });

  it('daemon state 帧抢跑收尾时,summary 先被补拉再收到原帧,卡片不重复不丢失', async () => {
    // 生产实测时序(12:42 轮):sidecar 依次发 summary+result,但客户端先收到
    // state(false) 触发兜底收尾,补拉把 summary/result 喂进 store,随后原帧又到。
    const session = await primeSession('claude_code');
    sessionHandlers.clear();
    sessionStateHandlers.clear();

    const wireEvents = [
      {
        type: 'tool_started',
        session_id: session.id,
        tool_use_id: 'call_edit_1',
        name: 'Edit',
        input: { file_path: 'D:/demo/package.json', old_string: '"pi-desktop4"', new_string: '"pi-desktop5"' },
      },
      {
        type: 'file_snapshot',
        session_id: session.id,
        file_path: 'D:/demo/package.json',
        original_content: '{"name": "pi-desktop4"}',
        is_new: false,
        tool_use_id: 'call_edit_1',
      },
      {
        type: 'tool_finished',
        session_id: session.id,
        tool_use_id: 'call_edit_1',
        content: 'ok',
        is_error: false,
      },
      {
        type: 'assistant_message',
        session_id: session.id,
        content: [{ type: 'text', text: '已完成,name 已改为 "pi-desktop5"。' }],
      },
      {
        type: 'system_event',
        subtype: 'session_summary',
        session_id: session.id,
        event_id: 'summary-race-1',
        diffs: [{ file: 'D:/demo/package.json', before: '{"name": "pi-desktop4"}', after: '{"name": "pi-desktop5"}', additions: 1, deletions: 1 }],
      },
      {
        type: 'turn_finished',
        session_id: session.id,
        outcome: 'completed',
      },
    ];

    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      // 客户端在收尾帧之前先收到 state(false):补拉兜底把整段尾部喂进 store。
      for (const wireEvent of wireEvents) {
        sessionHandlers.get(sessionId)?.(JSON.stringify(wireEvent));
      }
      onEvent(JSON.stringify(wireEvents[4]));
      onEvent(JSON.stringify(wireEvents[5]));
    });

    await useAgentStore.getState().startQuery(session.id, '改 name', 'D:\\demo');

    const storeEvents = useAgentStore.getState().events[session.id];
    const summaries = storeEvents.filter((event) => event.kind === 'session_summary');
    expect(summaries.length, 'summary 必须恰好在时间线里出现一次(补拉与原帧去重)').toBe(1);

    // 与运行时一致:用 store 构建的 turns 走完整转换,断言卡片真的挂得上去。
    const { convertAgentEventsToAssistantMessages } = await import('../components/agent/assistant-ui/convertAgentEvents');
    const messages = convertAgentEventsToAssistantMessages(storeEvents, useAgentStore.getState().turns[session.id]);
    const parts = messages
      .flatMap((message) => message.content)
      .filter((part) => part.type === 'data-codemux-event' && part.eventKind === 'session_summary');
    expect(parts.length, '转换后必须产出一张产物卡片').toBe(1);
  });

  it('daemon idle fallback commits a pending one-shot assistant before settling', async () => {
    vi.useFakeTimers();
    let emitEvent: ((event: string) => void) | undefined;
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      emitEvent = onEvent;
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-before-idle',
        session_id: sessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'one-shot final answer' }] },
      }));
    });

    try {
      const session = await primeSession('codex');
      sessionHandlers.clear();
      sessionStateHandlers.clear();
      await useAgentStore.getState().startQuery(session.id, 'one-shot', 'D:/workspace');
      await vi.advanceTimersByTimeAsync(40);
      expect(useAgentStore.getState().streamingText[session.id]).toContain('one-shot');

      sessionStateHandlers.get(session.id)?.(true);
      sessionStateHandlers.get(session.id)?.(false);

      expect(useAgentStore.getState().events[session.id]).toContainEqual(
        expect.objectContaining({ kind: 'assistant' }),
      );
      expect(useAgentStore.getState().streamingText[session.id]).toBe('');
      expect(useAgentStore.getState().streamingEstimatedOutputTokens[session.id]).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('刚发出的回合不会被紧跟而来的 state=false 抢跑', async () => {
    const session = await primeSession('codex');
    sessionHandlers.clear();
    sessionStateHandlers.clear();

    startSessionMock.mockImplementationOnce(async () => undefined);
    await useAgentStore.getState().startQuery(session.id, '刚发出', 'D:\\workspace');

    // 从没见过 daemon 为这一回合报 running=true(上一回合的收尾帧、或订阅建立时的
    // 状态帧可能紧接着到达):这只是「标记还没到」的假空闲,不能收尾。
    sessionStateHandlers.get(session.id)?.(false);

    expect(useAgentStore.getState().isRunning[session.id]).toBe(true);
  });

  it('历史加载发现序号回退时用本页最高序号对账水位线', async () => {
    const session = await primeSession('codex');
    reconcileHistorySequenceMock.mockClear();
    getTimelineMock.mockResolvedValueOnce({
      events: [
        { type: 'user_message', session_id: session.id, event_id: 'e1', sequence: 0 },
        { type: 'user_message', session_id: session.id, event_id: 'e2', sequence: 311 },
      ],
      hasMore: false,
    });

    await useAgentStore.getState().loadSessionMessages(session.id, { force: true });

    // daemon 重建时间线后序号从 0 重新编号:必须交给 reconcile 判断回退,
    // 而不是原来的 `Math.max(水位线, 本页最高序号)`(那样水位线永远降不下来)。
    expect(reconcileHistorySequenceMock).toHaveBeenCalledWith(session.id, 311);
  });

  it('从 CLI 同步历史后先回退去重水位线再重新加载', async () => {
    const session = await primeSession('codex');
    resetLastEventSequenceMock.mockClear();
    resyncSessionFromNativeMock.mockResolvedValue({ eventCount: 312 });

    await useAgentStore.getState().resyncSessionFromNative(session.id);

    expect(resetLastEventSequenceMock).toHaveBeenCalledWith(session.id, -1);
  });

  it('时间线重建后,在飞的旧页不会把水位线重新抬高', async () => {
    const session = await primeSession('codex');
    sessionHandlers.clear();
    sessionTimelineResetHandlers.clear();

    startSessionMock.mockImplementationOnce(async () => undefined);
    await useAgentStore.getState().startQuery(session.id, '占位', 'D:\\workspace');
    reconcileHistorySequenceMock.mockClear();

    let releaseStalePage: (() => void) | undefined;
    getTimelineMock.mockImplementationOnce(() => new Promise((resolve) => {
      releaseStalePage = () => resolve({
        events: [{ type: 'user_message', session_id: session.id, event_id: 'stale-1', sequence: 500 }],
        hasMore: false,
      });
    }));

    const staleLoad = useAgentStore.getState().loadSessionMessages(session.id, { force: true });
    // 重建广播到达:在飞的那一页读的是重建前的序号空间,必须被作废。
    sessionTimelineResetHandlers.get(session.id)?.();
    releaseStalePage?.();
    await staleLoad;

    expect(reconcileHistorySequenceMock).not.toHaveBeenCalledWith(session.id, 500);
  });

  it('后台回合的完成探测由事件驱动，不用等被节流的兜底节拍', async () => {
    const session = await primeSession('codex');
    sessionHandlers.clear();
    vi.mocked(daemonFacade.isSessionTurnActive).mockResolvedValue(true);

    // 附着到进行中的回合（这会注册 WS 事件处理器），再把它标记成"后台回合"。
    expect(await useAgentStore.getState().attachLiveSession(session.id)).toBe(true);
    useAgentStore.setState((state) => ({
      backgroundLive: { ...state.backgroundLive, [session.id]: true },
    }));

    const probesBefore = vi.mocked(daemonFacade.isSessionTurnActive).mock.calls.length;

    // 普通事件到达：不该等 1s 兜底节拍（窗口隐藏时它还会被浏览器压到分钟级），
    // 防抖 250ms 之后就应当去探测一次。
    sessionHandlers.get(session.id)?.(JSON.stringify({
      type: 'assistant',
      session_id: session.id,
      message: { role: 'assistant', content: [{ type: 'text', text: '还在跑' }] },
    }));

    await vi.waitFor(() => {
      expect(vi.mocked(daemonFacade.isSessionTurnActive).mock.calls.length)
        .toBeGreaterThan(probesBefore);
    }, { timeout: 900, interval: 25 });
  });

  it('settling a background turn clears late stream buffers and estimated tokens', async () => {
    const session = await primeSession('codex');
    vi.mocked(daemonFacade.isSessionTurnActive).mockResolvedValue(false);
    useAgentStore.setState({
      backgroundLive: { [session.id]: true },
      isRunning: { [session.id]: true },
      queryStartTime: { [session.id]: Date.now() },
      streamingText: { [session.id]: 'late text' },
      streamingEstimatedOutputTokens: { [session.id]: 42 },
    });

    await useAgentStore.getState().completeBackgroundLiveIfIdle(session.id);

    expect(useAgentStore.getState().backgroundLive[session.id]).toBeUndefined();
    expect(useAgentStore.getState().isRunning[session.id]).toBe(false);
    expect(useAgentStore.getState().streamingText[session.id]).toBe('');
    expect(useAgentStore.getState().streamingEstimatedOutputTokens[session.id]).toBe(0);
  });

  it('proxy_status updates the settings indicator without entering the timeline', async () => {
    const session = await primeSession('codex');
    sessionHandlers.clear();
    vi.mocked(daemonFacade.isSessionTurnActive).mockResolvedValue(true);

    expect(await useAgentStore.getState().attachLiveSession(session.id)).toBe(true);

    sessionHandlers.get(session.id)?.(JSON.stringify({
      type: 'proxy_status',
      session_id: session.id,
      running: true,
      port: 15722,
      upstreamBaseUrl: 'https://gateway.example.com/v1',
    }));

    await vi.waitFor(() => {
      expect(useSettingsStore.getState().proxyRunning).toBe(true);
    });
    expect(useSettingsStore.getState().proxyUrl).toBe('http://127.0.0.1:15722');
    expect(
      (useAgentStore.getState().events[session.id] ?? []).some((entry) => entry.kind === 'proxy_status'),
    ).toBe(false);

    sessionHandlers.get(session.id)?.(JSON.stringify({
      type: 'proxy_status',
      session_id: session.id,
      running: false,
      port: null,
      upstreamBaseUrl: null,
    }));

    await vi.waitFor(() => {
      expect(useSettingsStore.getState().proxyRunning).toBe(false);
    });
    expect(useSettingsStore.getState().proxyUrl).toBeNull();
  });

  it('attachLiveSession is a no-op when the daemon turn is not active', async () => {
    const session = await primeSession('codex');
    sessionHandlers.clear();
    vi.mocked(daemonFacade.isSessionTurnActive).mockResolvedValue(false);

    const attached = await useAgentStore.getState().attachLiveSession(session.id);

    expect(attached).toBe(false);
    expect(useAgentStore.getState().isRunning[session.id]).toBeFalsy();
    expect(sessionHandlers.has(session.id)).toBe(false);
  });

  it('runQueuedQueryNow steers the active Codex turn without interrupting', async () => {
    const session = await primeSession('codex');

    startSessionMock.mockImplementationOnce(async () => undefined);

    await useAgentStore.getState().startQuery(session.id, 'first message', 'D:\\workspace');
    await useAgentStore.getState().startQuery(session.id, 'second message', 'D:\\workspace');
    await useAgentStore.getState().startQuery(session.id, 'third message', 'D:\\workspace');

    const queueBefore = useAgentStore.getState().queuedQueries[session.id] ?? [];
    const promoted = queueBefore[1];
    expect(promoted?.prompt).toBe('third message');
    expect(useAgentStore.getState().isRunning[session.id]).toBe(true);

    await useAgentStore.getState().runQueuedQueryNow(session.id, promoted!.id);

    expect(interruptViaDaemonMock).not.toHaveBeenCalled();
    expect(startSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMessageViaDaemonMock).toHaveBeenCalledWith(
      session.id,
      'third message',
      undefined,
      expect.objectContaining({ delivery: 'steer' }),
    );
    expect(useAgentStore.getState().queuedQueries[session.id]?.map((query) => query.prompt)).toEqual([
      'second message',
    ]);
    expect(useAgentStore.getState().isRunning[session.id]).toBe(true);
    expect(useAgentStore.getState().queuePaused[session.id]).toBeFalsy();
  });

  it('keeps isRunning true after runQueuedQueryNow steers the queued message', async () => {
    const session = await primeSession('codex');

    startSessionMock.mockImplementationOnce(async () => undefined);

    await useAgentStore.getState().startQuery(session.id, 'first message', 'D:\\workspace');
    await useAgentStore.getState().startQuery(session.id, 'queued second', 'D:\\workspace');

    const queued = useAgentStore.getState().queuedQueries[session.id]?.[0];
    expect(queued?.prompt).toBe('queued second');

    await useAgentStore.getState().runQueuedQueryNow(session.id, queued!.id);

    expect(sendMessageViaDaemonMock).toHaveBeenCalledWith(
      session.id,
      'queued second',
      undefined,
      expect.objectContaining({ delivery: 'steer' }),
    );
    expect(startSessionMock).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().isRunning[session.id]).toBe(true);
    expect(useAgentStore.getState().queuedQueries[session.id]).toEqual([]);
  });

  it('runQueuedQueryNow interrupts a slash command instead of steering', async () => {
    const session = await primeSession('codex');
    let firstOnEvent: ((event: string) => void) | undefined;

    startSessionMock.mockImplementationOnce(async (_sessionId, _prompt, _cwd, onEvent) => {
      firstOnEvent = onEvent;
    });

    await useAgentStore.getState().startQuery(session.id, 'first message', 'D:\\workspace');
    await useAgentStore.getState().startQuery(session.id, '/compact', 'D:\\workspace');

    const queued = useAgentStore.getState().queuedQueries[session.id]?.[0];
    expect(queued?.prompt).toBe('/compact');

    const runPromise = useAgentStore.getState().runQueuedQueryNow(session.id, queued!.id);
    expect(sendMessageViaDaemonMock).toHaveBeenCalledTimes(1);
    expect(interruptViaDaemonMock).toHaveBeenCalledWith(session.id);

    firstOnEvent?.(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      session_id: session.id,
    }));
    await runPromise;

    await vi.waitFor(() => {
      expect(startSessionMock.mock.calls.map((call) => call[1])).toEqual([
        'first message',
        '/compact',
      ]);
    });
  });

  it('runQueuedQueryNow interrupts agents that cannot steer', async () => {
    const session = await primeSession('gemini_cli');
    let firstOnEvent: ((event: string) => void) | undefined;

    startSessionMock.mockImplementationOnce(async (_sessionId, _prompt, _cwd, onEvent) => {
      firstOnEvent = onEvent;
    });

    await useAgentStore.getState().startQuery(session.id, 'first message', 'D:\\workspace');
    await useAgentStore.getState().startQuery(session.id, 'second message', 'D:\\workspace');

    const queued = useAgentStore.getState().queuedQueries[session.id]?.[0];
    const runPromise = useAgentStore.getState().runQueuedQueryNow(session.id, queued!.id);

    expect(sendMessageViaDaemonMock).toHaveBeenCalledTimes(1);
    expect(interruptViaDaemonMock).toHaveBeenCalledWith(session.id);

    firstOnEvent?.(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      session_id: session.id,
    }));
    await runPromise;

    await vi.waitFor(() => {
      expect(startSessionMock.mock.calls.map((call) => call[1])).toEqual([
        'first message',
        'second message',
      ]);
    });
  });

  it('runQueuedQueryNow interrupts when the user prefers interrupt over steer', async () => {
    const session = await primeSession('codex');
    let firstOnEvent: ((event: string) => void) | undefined;

    useSettingsStore.setState((state) => ({
      config: state.config
        ? { ...state.config, immediate_run_mode: 'interrupt' }
        : state.config,
    }));

    startSessionMock.mockImplementationOnce(async (_sessionId, _prompt, _cwd, onEvent) => {
      firstOnEvent = onEvent;
    });

    await useAgentStore.getState().startQuery(session.id, 'first message', 'D:\\workspace');
    await useAgentStore.getState().startQuery(session.id, 'second message', 'D:\\workspace');

    const queued = useAgentStore.getState().queuedQueries[session.id]?.[0];
    const runPromise = useAgentStore.getState().runQueuedQueryNow(session.id, queued!.id);

    expect(sendMessageViaDaemonMock).toHaveBeenCalledTimes(1);
    expect(interruptViaDaemonMock).toHaveBeenCalledWith(session.id);

    firstOnEvent?.(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      session_id: session.id,
    }));
    await runPromise;

    await vi.waitFor(() => {
      expect(startSessionMock.mock.calls.map((call) => call[1])).toEqual([
        'first message',
        'second message',
      ]);
    });
  });

  it('falls back to interrupt when steer_result reports unavailable', async () => {
    const session = await primeSession('codex');
    let firstOnEvent: ((event: string) => void) | undefined;

    startSessionMock.mockImplementationOnce(async (_sessionId, _prompt, _cwd, onEvent) => {
      firstOnEvent = onEvent;
    });

    await useAgentStore.getState().startQuery(session.id, 'first message', 'D:\\workspace');
    await useAgentStore.getState().startQuery(session.id, 'steer me', 'D:\\workspace');

    const queued = useAgentStore.getState().queuedQueries[session.id]?.[0];
    await useAgentStore.getState().runQueuedQueryNow(session.id, queued!.id);

    const steerCall = sendMessageViaDaemonMock.mock.calls.find((call) => (
      (call[3] as { delivery?: string })?.delivery === 'steer'
    ));
    const requestId = (steerCall?.[3] as { requestId: string }).requestId;
    expect(useAgentStore.getState().queuedQueries[session.id]).toEqual([]);

    firstOnEvent?.(JSON.stringify({
      type: 'steer_result',
      request_id: requestId,
      ok: false,
      unavailable: true,
    }));

    await vi.waitFor(() => {
      expect(interruptViaDaemonMock).toHaveBeenCalledWith(session.id);
    });
    expect(useAgentStore.getState().queuedQueries[session.id]?.[0]?.prompt).toBe('steer me');

    firstOnEvent?.(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      session_id: session.id,
    }));

    await vi.waitFor(() => {
      expect(startSessionMock.mock.calls.map((call) => call[1])).toEqual([
        'first message',
        'steer me',
      ]);
    });
  });

  it('dispatches composer input immediately after a failed turn even when queuePaused', async () => {
    const session = await primeSession('codex');
    let finishFirstTurn: ((event: string) => void) | undefined;

    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      finishFirstTurn = onEvent;
    });

    await useAgentStore.getState().startQuery(session.id, 'first message', 'D:\\workspace');

    finishFirstTurn?.(JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      uuid: 'failed-result',
      session_id: session.id,
      duration_ms: 5,
      duration_api_ms: 4,
      num_turns: 1,
      result: 'failed',
    }));

    await vi.waitFor(() => {
      expect(useAgentStore.getState().queuePaused[session.id]).toBe(true);
      expect(useAgentStore.getState().isRunning[session.id]).toBe(false);
    });

    startSessionMock.mockImplementationOnce(async () => {});

    await useAgentStore.getState().startQuery(session.id, 'retry from composer', 'D:\\workspace');

    expect(useAgentStore.getState().queuedQueries[session.id] ?? []).toEqual([]);
    expect(useAgentStore.getState().queuePaused[session.id]).toBe(false);
    expect(startSessionMock).toHaveBeenCalledTimes(2);
    expect(startSessionMock.mock.calls[1]?.[1]).toBe('retry from composer');
  });

  it('dispatches composer input after failure before retaining and running prior queued messages', async () => {
    const session = await primeSession('codex');
    let finishFirstTurn: ((event: string) => void) | undefined;

    startSessionMock.mockImplementationOnce(async (_sessionId, _prompt, _cwd, onEvent) => {
      finishFirstTurn = onEvent;
    });

    await useAgentStore.getState().startQuery(session.id, 'first message', 'D:\\workspace');
    await useAgentStore.getState().startQuery(session.id, 'queued during run', 'D:\\workspace');

    expect(useAgentStore.getState().queuedQueries[session.id]?.map((query) => query.prompt)).toEqual([
      'queued during run',
    ]);

    finishFirstTurn?.(JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      uuid: 'failed-result',
      session_id: session.id,
      duration_ms: 5,
      duration_api_ms: 4,
      num_turns: 1,
      result: 'failed',
    }));

    await vi.waitFor(() => {
      expect(useAgentStore.getState().queuePaused[session.id]).toBe(true);
      expect(useAgentStore.getState().isRunning[session.id]).toBe(false);
    });

    let finishRetryTurn: ((event: string) => void) | undefined;

    startSessionMock.mockImplementationOnce(async (_sessionId, _prompt, _cwd, onEvent) => {
      finishRetryTurn = onEvent;
    });

    await useAgentStore.getState().startQuery(session.id, 'retry from composer', 'D:\\workspace');

    expect(useAgentStore.getState().queuedQueries[session.id]?.map((query) => query.prompt)).toEqual([
      'queued during run',
    ]);
    expect(useAgentStore.getState().queuePaused[session.id]).toBe(false);
    expect(startSessionMock).toHaveBeenCalledTimes(2);
    expect(startSessionMock.mock.calls[1]?.[1]).toBe('retry from composer');

    finishRetryTurn?.(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      session_id: session.id,
    }));

    startSessionMock.mockImplementationOnce(async () => {});

    await vi.waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledTimes(3);
      expect(startSessionMock.mock.calls[2]?.[1]).toBe('queued during run');
    });
    expect(useAgentStore.getState().queuedQueries[session.id]).toEqual([]);
  });

  it('runQueuedQueryNow promotes the chosen message without interrupting when nothing is running', async () => {
    const session = await primeSession('codex');

    useAgentStore.setState({
      queuedQueries: {
        [session.id]: [
          { id: 'queued-a', prompt: 'alpha', cwd: 'D:\\workspace', createdAt: 1 },
          { id: 'queued-b', prompt: 'beta', cwd: 'D:\\workspace', createdAt: 2 },
        ],
      },
      queuePaused: { [session.id]: true },
    });

    await useAgentStore.getState().runQueuedQueryNow(session.id, 'queued-b');

    expect(interruptViaDaemonMock).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(startSessionMock.mock.calls.map((call) => call[1])).toEqual(['beta', 'alpha']);
    });
    expect(useAgentStore.getState().queuedQueries[session.id]).toEqual([]);
  });

  it('deduplicates concurrent loads but refreshes history on later loads', async () => {
    const session = await primeSession('claude_code');
    let resolveHistory: ((events: Record<string, unknown>[]) => void) | undefined;
    loadClaudeSessionEventsMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveHistory = resolve;
    }));

    const first = useAgentStore.getState().loadSessionMessages(session.id);
    const second = useAgentStore.getState().loadSessionMessages(session.id);

    await vi.waitFor(() => {
      expect(getTimelineMock).toHaveBeenCalledTimes(1);
      expect(loadClaudeSessionEventsMock).toHaveBeenCalledTimes(1);
    });
    resolveHistory?.([]);
    await Promise.all([first, second]);

    await useAgentStore.getState().loadSessionMessages(session.id);
    expect(loadClaudeSessionEventsMock).toHaveBeenCalledTimes(2);
    expect(useAgentStore.getState().events[session.id]).toEqual([]);
  });

  it('replaces a partial in-memory history snapshot with the latest persisted history', async () => {
    const session = await primeSession('claude_code');
    const persistedUser = {
      type: 'user',
      uuid: 'persisted-user',
      session_id: session.id,
      message: {
        role: 'user',
        content: [{ type: 'text', text: '完整历史消息' }],
      },
    };

    useAgentStore.setState((state) => ({
      events: {
        ...state.events,
        [session.id]: [{ kind: 'user', data: { content: '旧的局部快照' } }],
      },
      eventTimestamps: {
        ...state.eventTimestamps,
        [session.id]: [1],
      },
    }));
    loadClaudeSessionEventsMock.mockResolvedValueOnce([persistedUser]);

    await useAgentStore.getState().loadSessionMessages(session.id, { force: true });

    expect(loadClaudeSessionEventsMock).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().events[session.id]?.[0]).toMatchObject({
      kind: 'user',
      data: { content: '完整历史消息' },
    });
  });

  it('loads CodeMUX timeline events through loadSessionEvents when reopening a session', async () => {
    const session = await primeSession('opencode');
    loadSessionEventsMock.mockResolvedValueOnce([
      {
        type: 'user_message',
        sequence: 0,
        session_id: session.id,
        event_id: 'timeline-user',
        content: 'timeline hello',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        type: 'assistant_message',
        sequence: 1,
        session_id: session.id,
        event_id: 'timeline-assistant',
        content: [{ type: 'text', text: 'timeline reply' }],
        timestamp: '2026-01-01T00:00:01.000Z',
      },
    ]);

    await useAgentStore.getState().loadSessionMessages(session.id);

    expect(loadSessionEventsMock).toHaveBeenCalledWith(session.id);
    expect(loadClaudeSessionEventsMock).not.toHaveBeenCalled();
    expect(loadCodexSessionEventsMock).not.toHaveBeenCalled();
    expect(useAgentStore.getState().events[session.id]?.[0]).toMatchObject({
      kind: 'user',
      data: { content: 'timeline hello' },
    });
    expect(useAgentStore.getState().events[session.id]?.[1]).toMatchObject({
      kind: 'assistant',
      data: {
        message: {
          content: [{ type: 'text', text: 'timeline reply' }],
        },
      },
    });
  });

  it('dedupes persisted timeline rows that share an event_id when reloading history', async () => {
    const session = await primeSession('opencode');
    loadSessionEventsMock.mockResolvedValueOnce([
      {
        type: 'user_message',
        sequence: 0,
        session_id: session.id,
        event_id: 'dup-user',
        content: '你好',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        type: 'user_message',
        sequence: 1,
        session_id: session.id,
        event_id: 'dup-user',
        content: '你好',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        type: 'assistant_message',
        sequence: 2,
        session_id: session.id,
        event_id: 'dup-assistant',
        content: [{ type: 'text', text: 'reply' }],
        timestamp: '2026-01-01T00:00:01.000Z',
      },
    ]);

    await useAgentStore.getState().loadSessionMessages(session.id);

    const messages = useAgentStore.getState().events[session.id] ?? [];
    expect(messages[0]).toMatchObject({ kind: 'user', data: { content: '你好' } });
    expect(messages[1]).toMatchObject({ kind: 'assistant' });
    expect(messages.filter((entry) => entry.kind === 'user')).toHaveLength(1);
  });

  it('resyncSessionFromNative replaces cached history from CLI and reloads UI state', async () => {
    const session = await primeSession('claude_code');
    resyncSessionFromNativeMock.mockResolvedValueOnce({ eventCount: 2 });
    loadSessionEventsMock.mockResolvedValueOnce([
      {
        type: 'user_message',
        session_id: session.id,
        event_id: 'resync-user',
        content: 'cli hello',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        type: 'assistant_message',
        session_id: session.id,
        event_id: 'resync-assistant',
        content: [{ type: 'text', text: 'cli reply' }],
        timestamp: '2026-01-01T00:00:01.000Z',
      },
    ]);
    useAgentStore.setState({
      events: {
        [session.id]: [{
          kind: 'user',
          data: { content: 'stale cached message' },
        }],
      },
    });

    const eventCount = await useAgentStore.getState().resyncSessionFromNative(session.id);

    expect(eventCount).toBe(2);
    expect(resyncSessionFromNativeMock).toHaveBeenCalledWith(session.id);
    expect(loadSessionEventsMock).toHaveBeenCalledWith(session.id);
    expect(useAgentStore.getState().events[session.id]?.[0]).toMatchObject({
      kind: 'user',
      data: { content: 'cli hello' },
    });
  });

  it('resyncSessionFromNative preserves ask_user_question rows from persisted timeline', async () => {
    const session = await primeSession('pi');
    resyncSessionFromNativeMock.mockResolvedValueOnce({ eventCount: 4 });
    loadSessionEventsMock.mockResolvedValueOnce([
      {
        type: 'user_message',
        session_id: session.id,
        event_id: 'resync-user',
        content: [{ type: 'text', text: '使用 ask_user_question' }],
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        type: 'user_input_requested',
        session_id: session.id,
        event_id: 'resync-ask',
        tool_use_id: 'call-1',
        questions: [{
          question: '你更喜欢哪种编程语言？',
          options: [{ label: 'Python' }],
        }],
        timestamp: '2026-01-01T00:00:01.000Z',
      },
      {
        type: 'tool_finished',
        session_id: session.id,
        event_id: 'resync-tool-result',
        tool_use_id: 'call-1',
        content: '你更喜欢哪种编程语言？: Python',
        is_error: false,
        timestamp: '2026-01-01T00:00:02.000Z',
      },
      {
        type: 'assistant_message',
        session_id: session.id,
        event_id: 'resync-assistant',
        content: [{ type: 'text', text: '谢谢你的回答！' }],
        timestamp: '2026-01-01T00:00:03.000Z',
      },
      {
        type: 'turn_finished',
        session_id: session.id,
        event_id: 'resync-turn',
        outcome: 'completed',
        duration_ms: 36000,
        timestamp: '2026-01-01T00:00:03.500Z',
      },
    ]);
    useAgentStore.setState({
      events: {
        [session.id]: [{
          kind: 'ask_user_question',
          data: {
            tool_use_id: 'call-1',
            questions: [{ question: '你更喜欢哪种编程语言？', options: [{ label: 'Python' }] }],
          },
        }],
      },
    });

    await useAgentStore.getState().resyncSessionFromNative(session.id);

    const events = useAgentStore.getState().events[session.id] ?? [];
    expect(events.some((event) => event.kind === 'ask_user_question')).toBe(true);
    expect(events.find((event) => event.kind === 'ask_user_question')).toMatchObject({
      kind: 'ask_user_question',
      data: {
        tool_use_id: 'call-1',
        questions: [{ question: '你更喜欢哪种编程语言？', options: [{ label: 'Python' }] }],
      },
    });
  });

  it('resyncSessionFromNative rejects while a turn is running', async () => {
    const session = await primeSession('codex');
    useAgentStore.setState({ isRunning: { [session.id]: true } });

    await expect(useAgentStore.getState().resyncSessionFromNative(session.id))
      .rejects.toThrow('会话正在运行，请先停止后再同步');
    expect(resyncSessionFromNativeMock).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['codex', 'claude_code'] as const)('does not persist %s history snapshots into SQLite', async (agentKind) => {
    const session = await primeSession(agentKind);

    await useAgentStore
      .getState()
      .startQuery(session.id, 'Explain the fix', 'D:\\project\\ai-code\\codeMUX');

    expect(saveEventsMock).not.toHaveBeenCalled();
  });

  it('重新抛出 Runtime 启动失败，让新建会话流程可以回滚并提示用户', async () => {
    startSessionMock.mockRejectedValueOnce('Claude Code Runtime 未安装或不可用，请先在设置中安装');

    const session = await primeSession('claude_code');

    await expect(
      useAgentStore.getState().startQuery(session.id, 'Explain the fix', 'D:\\project\\ai-code\\codeMUX'),
    ).rejects.toBe('Claude Code Runtime 未安装或不可用，请先在设置中安装');

    expect(useAgentStore.getState().isRunning[session.id]).toBe(false);
    expect(useAgentStore.getState().error[session.id]).toBe('Claude Code Runtime 未安装或不可用，请先在设置中安装');
  });

  it('stops running after a successful result even if sidecar_query_done never arrives', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Codex reply' }],
        },
      }));
      onEvent(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-1',
        session_id: sessionId,
        duration_ms: 5,
        duration_api_ms: 4,
        num_turns: 1,
        result: '',
        usage: {
          input_tokens: 5,
          output_tokens: 7,
        },
      }));
    });

    const session = await primeSession('codex');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'Explain the fix', 'D:\\project\\ai-code\\codeMUX');

    expect(useAgentStore.getState().isRunning[session.id]).toBe(false);
  });

  it('updates the session selector when Claude enters plan mode', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'permission_mode_changed',
        session_id: sessionId,
        plan_mode: 'on',
      }));
      onEvent(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-plan-mode',
        session_id: sessionId,
        duration_ms: 5,
        duration_api_ms: 4,
        num_turns: 1,
        result: '',
      }));
    });

    const session = await primeSession('claude_code');

    await useAgentStore.getState().startQuery(session.id, 'Enter plan mode', 'D:\\project\\ai-code\\codeMUX');

    expect(useSessionStore.getState().sessions[0]?.plan_mode).toBe('on');
  });

  it('refreshes Claude Code token usage from history after a successful result and ignores result usage', async () => {
    loadLatestTokenUsageMock.mockResolvedValueOnce({
      total: {
        totalTokens: 25_440,
        inputTokens: 352,
        cachedInputTokens: 25_088,
        outputTokens: 152,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: 25_440,
        inputTokens: 352,
        cachedInputTokens: 25_088,
        outputTokens: 152,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 258_400,
      contextUsageSource: 'history_file',
      contextUsageFreshness: 'live_synced',
    });
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-live-usage',
        session_id: sessionId,
        duration_ms: 5,
        duration_api_ms: 4,
        num_turns: 1,
        result: '',
        usage: {
          input_tokens: 999_999,
          output_tokens: 25,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 0,
        },
      }));
    });

    const session = await primeSession('claude_code');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'Explain the fix', 'D:\\project\\ai-code\\codeMUX');

    await vi.waitFor(() => {
      expect(loadLatestTokenUsageMock).toHaveBeenCalledWith(session.id, 'claude_code', 'live_synced');
    });
    expect(useAgentStore.getState().tokenUsageBySession[session.id]).toMatchObject({
      last: {
        totalTokens: 25_440,
        inputTokens: 352,
        cachedInputTokens: 25_088,
        outputTokens: 152,
      },
      modelContextWindow: 258_400,
      contextUsageSource: 'history_file',
      contextUsageFreshness: 'live_synced',
    });
  });

  it('does not refresh token usage for failed results', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'result',
        subtype: 'error',
        is_error: true,
        uuid: 'failed-result',
        session_id: sessionId,
        duration_ms: 5,
        duration_api_ms: 4,
        num_turns: 1,
        result: 'failed',
      }));
    });

    const session = await primeSession('claude_code');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'Explain the fix', 'D:\\project\\ai-code\\codeMUX');

    expect(loadLatestTokenUsageMock).not.toHaveBeenCalled();
    expect(useAgentStore.getState().tokenUsageBySession[session.id]).toBeUndefined();
  });

  it('ignores legacy sidecar token_usage_update events without appending a message', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'token_usage_update',
        session_id: sessionId,
        token_usage: {
          total: { totalTokens: 55_074, inputTokens: 21_700, cachedInputTokens: 32_800, outputTokens: 574 },
          last: { totalTokens: 55_074, inputTokens: 21_700, cachedInputTokens: 32_800, outputTokens: 574 },
          modelContextWindow: 258_400,
        },
      }));
    });

    const session = await primeSession('claude_code');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'Explain the fix', 'D:\\project\\ai-code\\codeMUX');

    expect(useAgentStore.getState().events[session.id].map((event) => event.kind)).toEqual([
      'user',
    ]);
    expect(loadLatestTokenUsageMock).not.toHaveBeenCalled();
    expect(useAgentStore.getState().tokenUsageBySession[session.id]).toBeUndefined();
  });

  it('keeps existing token usage while syncing and ignores stale refresh responses', async () => {
    let resolveFirst: (value: Record<string, unknown> | null) => void = () => {};
    let resolveSecond: (value: Record<string, unknown> | null) => void = () => {};
    loadLatestTokenUsageMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve; }));

    const session = await primeSession('codex');
    useAgentStore.getState().setSessionTokenUsage(session.id, {
      total: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 0 },
      last: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 0 },
      modelContextWindow: 258_400,
      contextUsageSource: 'history_file',
      contextUsageFreshness: 'restored',
    });

    const first = useAgentStore.getState().refreshLatestTokenUsage(session.id, 'live_synced');
    const second = useAgentStore.getState().refreshLatestTokenUsage(session.id, 'live_synced');

    expect(useAgentStore.getState().tokenUsageBySession[session.id]).toMatchObject({
      last: { totalTokens: 100 },
      contextUsageFreshness: 'syncing',
    });

    resolveSecond({
      total: { totalTokens: 200, inputTokens: 180, cachedInputTokens: 70, outputTokens: 20, reasoningOutputTokens: 0 },
      last: { totalTokens: 200, inputTokens: 180, cachedInputTokens: 70, outputTokens: 20, reasoningOutputTokens: 0 },
      modelContextWindow: 258_400,
      contextUsageSource: 'history_file',
      contextUsageFreshness: 'live_synced',
    });
    await second;

    resolveFirst({
      total: { totalTokens: 150, inputTokens: 140, cachedInputTokens: 60, outputTokens: 10, reasoningOutputTokens: 0 },
      last: { totalTokens: 150, inputTokens: 140, cachedInputTokens: 60, outputTokens: 10, reasoningOutputTokens: 0 },
      modelContextWindow: 258_400,
      contextUsageSource: 'history_file',
      contextUsageFreshness: 'live_synced',
    });
    await first;

    expect(useAgentStore.getState().tokenUsageBySession[session.id]).toMatchObject({
      last: { totalTokens: 200 },
      contextUsageFreshness: 'live_synced',
    });
  });

  it('removes reconnecting stream status after a successful Codex result', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'sidecar_stream_status',
        message: 'Reconnecting... 5/5 (stream disconnected before completion: stream closed before response.completed)',
        is_reconnecting: true,
      }));
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Recovered reply' }],
        },
      }));
      onEvent(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-1',
        session_id: sessionId,
        duration_ms: 5,
        duration_api_ms: 4,
        num_turns: 1,
        result: '',
        usage: {
          input_tokens: 5,
          output_tokens: 7,
        },
      }));
    });

    const session = await primeSession('codex');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'Explain the fix', 'D:\\project\\ai-code\\codeMUX');

    expect(useAgentStore.getState().events[session.id].some((event) => event.kind === 'stream_status')).toBe(false);
  });

  it('preserves Codex mode-blocked stream diagnostics', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'sidecar_stream_status',
        message: 'Codex collaboration mode blocked item/tool/requestUserInput: request_user_input_blocked_in_default_mode.',
        is_reconnecting: false,
        mode_blocked: {
          blocked_method: 'item/tool/requestUserInput',
          effective_mode: 'code',
          reason_code: 'request_user_input_blocked_in_default_mode',
          reason: 'requestUserInput is blocked while effective_mode=code',
          suggestion: 'Switch to Plan mode and resend the prompt when user input is needed.',
          request_id: 'tool-1',
        },
      }));
    });

    const session = await primeSession('codex');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'Explain the fix', 'D:\\project\\ai-code\\codeMUX');

    expect(useAgentStore.getState().events[session.id]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'stream_status',
          data: expect.objectContaining({
            mode_blocked: expect.objectContaining({
              reason_code: 'request_user_input_blocked_in_default_mode',
            }),
          }),
        }),
      ]),
    );
  });

  it('keeps the first file snapshot as the diff baseline across repeated edits', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      const filePath = 'D:\\project\\ai-code\\codeMUX\\src\\example.ts';

      onEvent(JSON.stringify({
        type: 'file_snapshot',
        file_path: filePath,
        original_content: 'alpha\nbeta\ngamma\n',
        is_new: false,
        tool_use_id: 'tool-1',
      }));
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-edit-1',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'tool-1',
            name: 'Edit',
            input: {
              file_path: filePath,
              old_string: 'alpha',
              new_string: 'ALPHA',
            },
          }],
        },
      }));
      onEvent(JSON.stringify({
        type: 'file_snapshot',
        file_path: filePath,
        original_content: 'ALPHA\nbeta\ngamma\n',
        is_new: false,
        tool_use_id: 'tool-2',
      }));
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-edit-2',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'tool-2',
            name: 'Edit',
            input: {
              file_path: filePath,
              old_string: 'gamma',
              new_string: 'GAMMA',
            },
          }],
        },
      }));
      onEvent(JSON.stringify({ type: 'sidecar_query_done' }));
    });

    const session = await primeSession('claude_code');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'Edit the same file twice', 'D:\\project\\ai-code\\codeMUX');

    const [changedFile] = useAgentStore.getState().changedFiles[session.id];
    expect(changedFile.originalContent).toBe('alpha\nbeta\ngamma\n');
    expect(changedFile.currentContent).toBe('ALPHA\nbeta\nGAMMA\n');
    expect(changedFile.additions).toBe(2);
    expect(changedFile.deletions).toBe(2);
  });

  it('extracts OpenCode lowercase tools and camelCase file arguments', async () => {
    const filePath = 'D:\\project\\ai-code\\codeMUX\\index.html';
    const changedFiles = extractChangedFilesFromEvents([
      {
        kind: 'file_snapshot',
        data: {
          file_path: filePath,
          original_content: '<h3>old</h3>\n',
          is_new: false,
          tool_use_id: 'call-edit-1',
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-opencode-edit-1',
          session_id: 'session-1',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: 'call-edit-1',
              name: 'edit',
              input: {
                filePath,
                oldString: '<h3>old</h3>',
                newString: '<h3>new</h3>',
              },
            }],
          },
          parent_tool_use_id: null,
        },
      },
    ] as never);

    expect(changedFiles).toEqual([expect.objectContaining({
      path: filePath,
      originalContent: '<h3>old</h3>\n',
      currentContent: '<h3>new</h3>\n',
      additions: 1,
      deletions: 1,
    })]);
  });

  it('does not expose unused git baseline state', async () => {

    expect(useAgentStore.getState()).not.toHaveProperty('gitBaselines');
  });

  it('commits pending simulated assistant text before the result event', async () => {
    const session = await primeSession('codex');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'Explain the fix', 'D:\\project\\ai-code\\codeMUX');

    const kinds = useAgentStore.getState().events[session.id]?.map((event) => event.kind) ?? [];
    expect(kinds.indexOf('assistant')).toBeLessThan(kinds.indexOf('result'));
  });

  it('can send a runtime prompt while showing separate user-facing content', async () => {
    const session = await primeSession('codex');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'TEMPLATE: review current changes', 'D:\\project\\ai-code\\codeMUX', undefined, '/review');

    expect(sendMessageViaDaemonMock).toHaveBeenCalledWith(
      session.id,
      'TEMPLATE: review current changes',
      { text: 'TEMPLATE: review current changes' },
    );
    expect(useAgentStore.getState().events[session.id]?.[0]).toEqual({
      kind: 'user',
      data: { content: '/review' },
    });
  });

  it('deduplicates the canonical Sidecar user message against the optimistic local message', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'user_message',
        session_id: sessionId,
        content: 'hello',
        event_id: 'user-event-1',
        sequence: 0,
      }));
    });
    const session = await primeSession('codex');

    await useAgentStore.getState().startQuery(session.id, 'hello', 'D:\\project\\ai-code\\codeMUX');

    expect(useAgentStore.getState().events[session.id]?.filter((event) => event.kind === 'user')).toHaveLength(1);
  });

  it('deduplicates a canonical user message even when a system event arrives first', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'system_event',
        session_id: sessionId,
        subtype: 'init',
        event_id: 'system-event-1',
        sequence: 0,
      }));
      onEvent(JSON.stringify({
        type: 'user_message',
        session_id: sessionId,
        content: 'hello',
        event_id: 'user-event-1',
        sequence: 1,
      }));
    });
    const session = await primeSession('codex');

    await useAgentStore.getState().startQuery(session.id, 'hello', 'D:\\project\\ai-code\\codeMUX');

    expect(useAgentStore.getState().events[session.id]?.filter((event) => event.kind === 'user')).toHaveLength(1);
  });

  it('treats isMeta user events from the live stream as raw, not as user turns', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: 'expanded slash command prompt' },
      }));
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        session_id: sessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      }));
      onEvent(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-1',
        session_id: sessionId,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: '',
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });

    const session = await primeSession('claude_code');

    await useAgentStore
      .getState()
      .startQuery(session.id, '/review', 'D:\\project\\ai-code\\codeMUX', undefined, undefined, undefined, undefined, undefined, '/review');

    const events = useAgentStore.getState().events[session.id] ?? [];
    const userEvents = events.filter((event) => event.kind === 'user');
    expect(userEvents).toHaveLength(1);
    expect(userEvents[0]).toEqual({ kind: 'user', data: { content: '/review' } });
  });

  it('restores Codex task progress from persisted update_plan calls', async () => {
    const session = await primeSession('codex');

    loadCodexSessionEventsMock.mockResolvedValueOnce([
      {
        type: 'assistant',
        timestamp: '2026-06-21T08:00:01.174Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'call-plan-1',
            name: 'update_plan',
            input: {
              explanation: 'all done',
              plan: [
                { status: 'completed', step: 'Task 1' },
                { status: 'completed', step: 'Task 2' },
                { status: 'completed', step: 'Task 3' },
              ],
            },
          }],
        },
        parent_tool_use_id: null,
      },
    ]);

    await useAgentStore.getState().loadSessionMessages(session.id);

    expect(useAgentStore.getState().todos[session.id]).toEqual([
      { content: 'Task 1', status: 'completed', activeForm: undefined },
      { content: 'Task 2', status: 'completed', activeForm: undefined },
      { content: 'Task 3', status: 'completed', activeForm: undefined },
    ]);
  });

  it('lets live Codex update_plan completion override an earlier todo list state', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'todo-1',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'todo-list-1',
            name: 'todowrite',
            input: {
              todos: [
                { content: 'Task 1', status: 'completed' },
                { content: 'Task 2', status: 'completed' },
                { content: 'Task 3', status: 'in_progress' },
              ],
            },
          }],
        },
        parent_tool_use_id: null,
      }));
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'plan-1',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'call-plan-1',
            name: 'update_plan',
            input: {
              plan: [
                { status: 'completed', step: 'Task 1' },
                { status: 'completed', step: 'Task 2' },
                { status: 'completed', step: 'Task 3' },
              ],
            },
          }],
        },
        parent_tool_use_id: null,
      }));
      onEvent(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-1',
        session_id: sessionId,
        duration_ms: 5,
        duration_api_ms: 4,
        num_turns: 1,
        result: '',
        usage: {
          input_tokens: 5,
          output_tokens: 7,
        },
      }));
    });

    const session = await primeSession('codex');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'continue', 'D:\\project\\ai-code\\codeMUX');

    expect(useAgentStore.getState().todos[session.id]).toEqual([
      { content: 'Task 1', status: 'completed', activeForm: undefined },
      { content: 'Task 2', status: 'completed', activeForm: undefined },
      { content: 'Task 3', status: 'completed', activeForm: undefined },
    ]);
  });

  it('updates task progress from Codex todo state events without adding chat messages', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'codex_todo_list',
        session_id: sessionId,
        todos: [
          { content: 'Task 1', status: 'completed' },
          { content: 'Task 2', status: 'pending' },
        ],
      }));
      onEvent(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-1',
        session_id: sessionId,
        duration_ms: 5,
        duration_api_ms: 4,
        num_turns: 1,
        result: '',
        usage: {
          input_tokens: 5,
          output_tokens: 7,
        },
      }));
    });

    const session = await primeSession('codex');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'continue', 'D:\\project\\ai-code\\codeMUX');

    expect(useAgentStore.getState().todos[session.id]).toEqual([
      { content: 'Task 1', status: 'completed' },
      { content: 'Task 2', status: 'pending' },
    ]);
    expect(useAgentStore.getState().events[session.id]).toEqual([
      { kind: 'user', data: { content: 'continue' } },
      expect.objectContaining({ kind: 'result' }),
    ]);
  });

  it('applies leading-edge streaming thinking and coalesces later deltas', async () => {
    vi.useFakeTimers();
    const requestAnimationFrameMock = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 16));
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle: number) => clearTimeout(handle));

    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'stream_event',
        session_id: sessionId,
        event: { type: 'content_block_start', content_block: { type: 'thinking' } },
      }));

      for (let index = 0; index < 5; index += 1) {
        onEvent(JSON.stringify({
          type: 'stream_event',
          session_id: sessionId,
          event: {
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking: `chunk-${index};` },
          },
        }));
      }
    });

    try {
      const session = await primeSession('codex');

      await useAgentStore
        .getState()
        .startQuery(session.id, 'stream thinking', 'D:\\project\\ai-code\\codeMUX');

      // Leading edge: first delta is visible immediately.
      expect(useAgentStore.getState().streamingThinking[session.id] ?? '').toBe('chunk-0;');

      await vi.advanceTimersByTimeAsync(60);
      expect(useAgentStore.getState().streamingThinking[session.id]).toBe(
        'chunk-0;chunk-1;chunk-2;chunk-3;chunk-4;',
      );
      expect('streamingThinkingDurations' in useAgentStore.getState()).toBe(false);
    } finally {
      requestAnimationFrameMock.mockRestore();
      vi.useRealTimers();
    }
  });

  it('clears committed thinking from the live buffer before following tools arrive', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'stream_event',
        session_id: sessionId,
        event: { type: 'content_block_start', content_block: { type: 'thinking' } },
      }));
      onEvent(JSON.stringify({
        type: 'stream_event',
        session_id: sessionId,
        event: {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: '先确认测试数据的来源。' },
        },
      }));
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'committed-thinking',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: '先确认测试数据的来源。' }],
        },
        parent_tool_use_id: null,
      }));
    });

    const session = await primeSession('codex');

    await useAgentStore
      .getState()
      .startQuery(session.id, '测试数据是哪里来的？', 'D:\\project\\ai-code\\codeMUX');

    expect(useAgentStore.getState().streamingThinking[session.id] ?? '').toBe('');
    expect(useAgentStore.getState().events[session.id]).toContainEqual(
      expect.objectContaining({
        kind: 'assistant',
        data: expect.objectContaining({
          message: expect.objectContaining({
            content: [{ type: 'thinking', thinking: '先确认测试数据的来源。' }],
          }),
        }),
      }),
    );
  });

  it('uses a trailing Claude thinking flush to avoid duplicate render commits', async () => {
    vi.useFakeTimers();

    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'stream_event',
        session_id: sessionId,
        event: { type: 'content_block_start', content_block: { type: 'thinking' } },
      }));
      onEvent(JSON.stringify({
        type: 'stream_event',
        session_id: sessionId,
        event: {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: 'claude-thinking' },
        },
      }));
    });

    try {
      const session = await primeSession('claude_code');

      await useAgentStore
        .getState()
        .startQuery(session.id, 'stream Claude thinking', 'D:\\project\\ai-code\\codeMUX');

      expect(useAgentStore.getState().streamingThinking[session.id] ?? '').toBe('');
      await vi.advanceTimersByTimeAsync(99);
      expect(useAgentStore.getState().streamingThinking[session.id] ?? '').toBe('');
      await vi.advanceTimersByTimeAsync(1);
      expect(useAgentStore.getState().streamingThinking[session.id]).toBe('claude-thinking');
    } finally {
      vi.useRealTimers();
    }
  });

  it('queues concurrent native permission requests for the same session', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'permission_requested',
        session_id: sessionId,
        request_id: 'permission-local',
        permission_type: 'external_directory',
        description: 'external_directory',
        metadata: { filepath: 'C:\\Users\\94910\\AppData\\Local' },
      }));
      onEvent(JSON.stringify({
        type: 'permission_requested',
        session_id: sessionId,
        request_id: 'permission-roaming',
        permission_type: 'external_directory',
        description: 'external_directory',
        metadata: { filepath: 'C:\\Users\\94910\\AppData\\Roaming' },
      }));
    });

    const session = await primeSession('opencode');

    await useAgentStore.getState().startQuery(session.id, '检查目录', 'D:\\project\\ai-code\\codeMUX');

    expect(useAgentStore.getState().pendingPermissions[session.id]).toMatchObject([
      { request_id: 'permission-local' },
      { request_id: 'permission-roaming' },
    ]);

    await useAgentStore.getState().respondToPermission(session.id, 'permission-roaming', 'once');

    expect(respondToAgentPermissionMock).toHaveBeenCalledWith(session.id, 'permission-roaming', 'once');
    expect(useAgentStore.getState().pendingPermissions[session.id]).toMatchObject([
      { request_id: 'permission-local' },
    ]);
  });

  it('mirrors computer-use approval requests and settles them through the daemon', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'computer-use-approval-request',
        requestId: 'cu-1',
        sessionId,
        tool: 'browser_snapshot',
        op: 'snapshot',
        summary: '读取页面快照(编号截图加元素列表)',
        risk: 'readOnly',
        sensitive: null,
        rememberable: true,
        params: {},
      }));
      onEvent(JSON.stringify({
        type: 'computer-use-approval-request',
        requestId: 'cu-1',
        sessionId,
        tool: 'browser_snapshot',
        op: 'snapshot',
        summary: '读取页面快照(编号截图加元素列表)',
        risk: 'readOnly',
        sensitive: null,
        rememberable: true,
        params: {},
      }));
      onEvent(JSON.stringify({
        type: 'computer-use-approval-request',
        requestId: 'cu-2',
        sessionId,
        tool: 'browser_type',
        op: 'type',
        summary: '在元素 e7 输入 12 个字符',
        risk: 'input',
        sensitive: null,
        rememberable: false,
        params: { elementId: 'e7' },
      }));
    });

    const session = await primeSession('claude_code');
    await useAgentStore.getState().startQuery(session.id, '填表', 'D:\project\ai-code\codeMUX');

    const pending = useAgentStore.getState().pendingComputerUseApprovals[session.id];
    expect(pending.map((item) => item.request_id)).toEqual(['cu-1', 'cu-2']);
    expect(pending[1]).toMatchObject({ op: 'type', risk: 'input', rememberable: false });
    // 审批事件不进时间线。
    expect((useAgentStore.getState().events[session.id] ?? []).some((message) => (
      message.kind === 'raw' && (message.data as { type?: string }).type === 'computer-use-approval-request'
    ))).toBe(false);

    await useAgentStore.getState().respondToComputerUseApproval(session.id, 'cu-2', 'reject');

    expect(respondToComputerUseApprovalMock).toHaveBeenCalledWith('cu-2', 'reject');
    expect(
      useAgentStore.getState().pendingComputerUseApprovals[session.id].map((item) => item.request_id),
    ).toEqual(['cu-1']);

    sessionHandlers.get(session.id)?.(
      JSON.stringify({ type: 'computer-use-approval-resolved', requestId: 'cu-1', decision: 'always' }),
    );
    expect(useAgentStore.getState().pendingComputerUseApprovals[session.id]).toEqual([]);
  });

  it('replaces superseded assistant events in place to keep timeline order', async () => {
    vi.useFakeTimers();
    let emitEvent: ((event: string) => void) | undefined;

    startSessionMock.mockImplementationOnce(async (_sessionId, _prompt, _cwd, onEvent) => {
      emitEvent = onEvent;
    });

    try {
      const session = await primeSession('opencode');
      await useAgentStore
        .getState()
        .startQuery(session.id, 'late narration', 'D:\\project\\ai-code\\codeMUX');

      const emit = (payload: Record<string, unknown>) => {
        emitEvent?.(JSON.stringify({ session_id: session.id, ...payload }));
      };

      // Live OpenCode order: thinking → provisional narration → tools → late final narration.
      emit({
        type: 'assistant_message',
        event_id: 'evt-think',
        provider_message_id: 'msg-1',
        content: [{ type: 'thinking', thinking: 't' }],
      });
      emit({
        type: 'assistant_message',
        event_id: 'evt-text-prov',
        provider_message_id: 'msg-1:part-1',
        content: [{ type: 'text', text: 'partial narration' }],
      });
      emit({
        type: 'tool_started',
        event_id: 'evt-tool',
        tool_use_id: 'call-1',
        name: 'bash',
        input: {},
      });
      emit({
        type: 'tool_finished',
        event_id: 'evt-tool-done',
        tool_use_id: 'call-1',
        content: 'ok',
        is_error: false,
      });
      emit({
        type: 'assistant_message',
        event_id: 'evt-text-final',
        provider_message_id: 'msg-1',
        supersedes_provider_message_ids: ['msg-1:part-1'],
        content: [{ type: 'text', text: 'full narration' }],
      });

      await vi.advanceTimersByTimeAsync(100);

      const events = useAgentStore.getState().events[session.id] ?? [];
      const textOf = (event: AgentMessage) => (
        event.kind === 'assistant'
          ? (event.data.message.content as Array<{ type: string; text?: string }>)
            .filter((block) => block.type === 'text')
            .map((block) => block.text ?? '')
            .join('')
            : ''
        );
        const finalTextIndex = events.findIndex((event) => textOf(event) === 'full narration');
      const toolResultIndex = events.findIndex((event) => event.kind === 'tool_result');

      expect(finalTextIndex).toBeGreaterThanOrEqual(0);
      expect(events.some((event) => textOf(event) === 'partial narration')).toBe(false);
      // The late final narration must keep the provisional event's position,
      // i.e. stay before the tool events instead of being appended at the end.
      expect(finalTextIndex).toBeLessThan(toolResultIndex);
    } finally {
      vi.useRealTimers();
    }
  });

  it('inserts late narration before a pending tool when sidecar emits tool_started first', async () => {
    vi.useFakeTimers();
    let emitEvent: ((event: string) => void) | undefined;

    startSessionMock.mockImplementationOnce(async (_sessionId, _prompt, _cwd, onEvent) => {
      emitEvent = onEvent;
    });

    try {
      const session = await primeSession('opencode');
      await useAgentStore
        .getState()
        .startQuery(session.id, 'late narration after tool', 'D:\\project\\ai-code\\codeMUX');

      const emit = (payload: Record<string, unknown>) => {
        emitEvent?.(JSON.stringify({ session_id: session.id, ...payload }));
      };

      emit({
        type: 'tool_started',
        event_id: 'evt-tool',
        tool_use_id: 'call-1',
        name: 'read',
        input: { filePath: 'src/App.tsx' },
      });
      emit({
        type: 'assistant_message',
        event_id: 'evt-text',
        provider_message_id: 'msg-1',
        content: [{ type: 'text', text: '先看这个文件：' }],
      });
      emit({
        type: 'tool_finished',
        event_id: 'evt-tool-done',
        tool_use_id: 'call-1',
        content: 'ok',
        is_error: false,
      });

      await vi.advanceTimersByTimeAsync(100);

      const events = useAgentStore.getState().events[session.id] ?? [];
      const textIndex = events.findIndex((event) => (
        event.kind === 'assistant'
        && (event.data.message.content as Array<{ type?: string; text?: string }>).some((block) => block.type === 'text' && block.text === '先看这个文件：')
      ));
      const toolAssistantIndex = events.findIndex((event) => (
        event.kind === 'assistant'
        && (event.data.message.content as Array<{ type?: string }>).some((block) => block.type === 'tool_use')
      ));

      expect(textIndex).toBeGreaterThanOrEqual(0);
      expect(toolAssistantIndex).toBeGreaterThanOrEqual(0);
      expect(textIndex).toBeLessThan(toolAssistantIndex);
    } finally {
      vi.useRealTimers();
    }
  });

  it('inserts late narration before a finished tool when sidecar finalizes text after tool_finished', async () => {
    vi.useFakeTimers();
    let emitEvent: ((event: string) => void) | undefined;

    startSessionMock.mockImplementationOnce(async (_sessionId, _prompt, _cwd, onEvent) => {
      emitEvent = onEvent;
    });

    try {
      const session = await primeSession('opencode');
      await useAgentStore
        .getState()
        .startQuery(session.id, 'late narration after tool finished', 'D:\\project\\ai-code\\codeMUX');

      const emit = (payload: Record<string, unknown>) => {
        emitEvent?.(JSON.stringify({ session_id: session.id, ...payload }));
      };

      emit({
        type: 'tool_started',
        event_id: 'evt-tool',
        tool_use_id: 'call-1',
        name: 'bash',
        input: { command: 'pwd' },
      });
      emit({
        type: 'tool_finished',
        event_id: 'evt-tool-done',
        tool_use_id: 'call-1',
        content: 'ok',
        is_error: false,
      });
      emit({
        type: 'assistant_message',
        event_id: 'evt-text',
        provider_message_id: 'msg-1',
        content: [{ type: 'text', text: '先看两个页面的现状——' }],
      });

      await vi.advanceTimersByTimeAsync(100);

      const events = useAgentStore.getState().events[session.id] ?? [];
      const textIndex = events.findIndex((event) => (
        event.kind === 'assistant'
        && (event.data.message.content as Array<{ type?: string; text?: string }>).some((block) => block.type === 'text' && block.text === '先看两个页面的现状——')
      ));
      const toolAssistantIndex = events.findIndex((event) => (
        event.kind === 'assistant'
        && (event.data.message.content as Array<{ type?: string }>).some((block) => block.type === 'tool_use')
      ));

      expect(textIndex).toBeGreaterThanOrEqual(0);
      expect(toolAssistantIndex).toBeGreaterThanOrEqual(0);
      expect(textIndex).toBeLessThan(toolAssistantIndex);
    } finally {
      vi.useRealTimers();
    }
  });

  it('commits live streaming narration before tool_started interrupts answer streaming', async () => {
    vi.useFakeTimers();
    let emitEvent: ((event: string) => void) | undefined;

    startSessionMock.mockImplementationOnce(async (_sessionId, _prompt, _cwd, onEvent) => {
      emitEvent = onEvent;
    });

    try {
      const session = await primeSession('claude_code');
      await useAgentStore
        .getState()
        .startQuery(session.id, 'stream then tool', 'D:\\project\\ai-code\\codeMUX');

      emitEvent?.(JSON.stringify({
        type: 'stream_event',
        session_id: session.id,
        event: { type: 'content_block_start', content_block: { type: 'text' } },
      }));
      emitEvent?.(JSON.stringify({
        type: 'stream_event',
        session_id: session.id,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '先看两个页面的现状——' } },
      }));

      await vi.advanceTimersByTimeAsync(100);

      expect(useAgentStore.getState().streamingText[session.id]).toBe('先看两个页面的现状——');

      emitEvent?.(JSON.stringify({
        session_id: session.id,
        type: 'tool_started',
        event_id: 'evt-tool',
        tool_use_id: 'call-1',
        name: 'bash',
        input: { command: 'pwd' },
      }));

      await vi.advanceTimersByTimeAsync(100);

      const events = useAgentStore.getState().events[session.id] ?? [];
      const textIndex = events.findIndex((event) => (
        event.kind === 'assistant'
        && (event.data.message.content as Array<{ type?: string; text?: string }>).some((block) => block.type === 'text' && block.text === '先看两个页面的现状——')
      ));
      const toolAssistantIndex = events.findIndex((event) => (
        event.kind === 'assistant'
        && (event.data.message.content as Array<{ type?: string }>).some((block) => block.type === 'tool_use')
      ));

      expect(useAgentStore.getState().streamingText[session.id] ?? '').toBe('');
      expect(textIndex).toBeGreaterThanOrEqual(0);
      expect(toolAssistantIndex).toBeGreaterThanOrEqual(0);
      expect(textIndex).toBeLessThan(toolAssistantIndex);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps Claude answer deltas out of the thinking stream', async () => {
    vi.useFakeTimers();
    let emitEvent: ((event: string) => void) | undefined;

    startSessionMock.mockImplementationOnce(async (_sessionId, _prompt, _cwd, onEvent) => {
      emitEvent = onEvent;
    });

    try {
      const session = await primeSession('claude_code');
      await useAgentStore
        .getState()
        .startQuery(session.id, 'stream Claude answer', 'D:\\project\\ai-code\\codeMUX');

      emitEvent?.(JSON.stringify({
        type: 'stream_event',
        session_id: session.id,
        event: { type: 'content_block_start', content_block: { type: 'text' } },
      }));
      emitEvent?.(JSON.stringify({
        type: 'stream_event',
        session_id: session.id,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ordinary answer' } },
      }));

      await vi.advanceTimersByTimeAsync(100);

      expect(useAgentStore.getState().streamingThinking[session.id] ?? '').toBe('');
      expect(useAgentStore.getState().streamingText[session.id]).toBe('ordinary answer');

      emitEvent?.(JSON.stringify({
        type: 'stream_event',
        session_id: session.id,
        event: { type: 'content_block_stop', index: 0, content_block: { type: 'text' } },
      }));
      await vi.advanceTimersByTimeAsync(100);

      emitEvent?.(JSON.stringify({
        type: 'stream_event',
        session_id: session.id,
        event: { type: 'content_block_start', content_block: { type: 'thinking' } },
      }));
      emitEvent?.(JSON.stringify({
        type: 'stream_event',
        session_id: session.id,
        event: {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: 'final reasoning' },
        },
      }));
      emitEvent?.(JSON.stringify({
        type: 'stream_event',
        session_id: session.id,
        event: { type: 'content_block_start', content_block: { type: 'text' } },
      }));
      emitEvent?.(JSON.stringify({
        type: 'stream_event',
        session_id: session.id,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'final answer' } },
      }));

      await vi.advanceTimersByTimeAsync(250);

      expect(useAgentStore.getState().streamingThinking[session.id] ?? '').toBe('');
      expect(useAgentStore.getState().streamingText[session.id]).toBe('final answer');
    } finally {
      vi.useRealTimers();
    }
  });

  it('accumulates estimated tokens from real text and reasoning deltas across content blocks', async () => {
    vi.useFakeTimers();
    let emitEvent: ((event: string) => void) | undefined;
    startSessionMock.mockImplementationOnce(async (_sessionId, _prompt, _cwd, onEvent) => {
      emitEvent = onEvent;
    });

    try {
      const session = await primeSession('claude_code');
      await useAgentStore.getState().startQuery(session.id, 'count real deltas', 'D:/workspace');
      const send = (event: Record<string, unknown>) => {
        emitEvent?.(JSON.stringify({ session_id: session.id, type: 'stream_event', event }));
      };

      send({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
      send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'abcd' } });
      await vi.advanceTimersByTimeAsync(120);
      expect(useAgentStore.getState().streamingEstimatedOutputTokens[session.id]).toBeCloseTo(1);

      send({ type: 'content_block_stop', index: 0, content_block: { type: 'thinking' } });
      send({ type: 'content_block_start', index: 1, content_block: { type: 'text' } });
      send({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好' } });
      await vi.advanceTimersByTimeAsync(120);
      expect(useAgentStore.getState().streamingEstimatedOutputTokens[session.id]).toBeCloseTo(1 + 2 / 1.8);

      const beforeToolInput = useAgentStore.getState().streamingEstimatedOutputTokens[session.id];
      send({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash' } });
      send({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' } });
      await vi.advanceTimersByTimeAsync(120);
      expect(useAgentStore.getState().streamingEstimatedOutputTokens[session.id]).toBe(beforeToolInput);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clearEvents removes both estimated tokens and the session streaming version', () => {
    const session = { id: 'clear-speed' };
    useAgentStore.setState({
      streamingEstimatedOutputTokens: { [session.id]: 42 },
      streamingVersion: { [session.id]: 7 },
    });

    useAgentStore.getState().clearEvents(session.id);

    expect(useAgentStore.getState().streamingEstimatedOutputTokens[session.id]).toBeUndefined();
    expect(useAgentStore.getState().streamingVersion[session.id]).toBeUndefined();
  });

  it('throttles simulated streaming text instead of updating visible state for every chunk', async () => {
    vi.useFakeTimers();
    const simulatedText = 'simulated-stream-text '.repeat(40);

    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-simulated-stream',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: simulatedText }],
        },
        parent_tool_use_id: null,
      }));
    });

    try {
      const session = await primeSession('codex');

      await useAgentStore
        .getState()
        .startQuery(session.id, 'simulate stream', 'D:\\project\\ai-code\\codeMUX');

      // Leading-edge flush: first sim tick paints immediately after the 30ms start delay.
      await vi.advanceTimersByTimeAsync(40);
      expect(useAgentStore.getState().streamingText[session.id] ?? '').toContain('simulated-stream-text');
      expect((useAgentStore.getState().streamingText[session.id] ?? '').length).toBeLessThan(simulatedText.length);

      await vi.advanceTimersByTimeAsync(80);
      expect((useAgentStore.getState().streamingText[session.id] ?? '').length).toBeGreaterThan(0);
      expect((useAgentStore.getState().streamingText[session.id] ?? '').length).toBeLessThan(simulatedText.length);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(useAgentStore.getState().streamingText[session.id] ?? '').toBe('');
      expect(useAgentStore.getState().streamingEstimatedOutputTokens[session.id] ?? 0).toBe(0);
      expect(useAgentStore.getState().events[session.id]).toContainEqual(
        expect.objectContaining({ kind: 'assistant' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('interrupt cancels a buffered delta and resets estimated output tokens', async () => {
    vi.useFakeTimers();
    let emitEvent: ((event: string) => void) | undefined;
    startSessionMock.mockImplementationOnce(async (_sessionId, _prompt, _cwd, onEvent) => {
      emitEvent = onEvent;
    });

    try {
      const session = await primeSession('claude_code');
      await useAgentStore.getState().startQuery(session.id, 'interrupt tail', 'D:/workspace');
      emitEvent?.(JSON.stringify({
        type: 'stream_event',
        session_id: session.id,
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      }));
      emitEvent?.(JSON.stringify({
        type: 'stream_event',
        session_id: session.id,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'abcd' } },
      }));

      await useAgentStore.getState().interrupt(session.id);
      expect(useAgentStore.getState().streamingEstimatedOutputTokens[session.id]).toBe(0);
      expect(useAgentStore.getState().streamingText[session.id]).toBe('');

      await vi.advanceTimersByTimeAsync(200);
      expect(useAgentStore.getState().streamingText[session.id]).toBe('');
      expect(useAgentStore.getState().streamingEstimatedOutputTokens[session.id]).toBe(0);

      emitEvent?.(JSON.stringify({
        type: 'result', subtype: 'success', is_error: false, result: '',
        duration_ms: 1, duration_api_ms: 1, num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 }, session_id: session.id,
      }));
      expect(useAgentStore.getState().streamingEstimatedOutputTokens[session.id]).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('buffers streaming tool input deltas without notifying the store for every partial json chunk', async () => {
    vi.useFakeTimers();

    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'stream_event',
        session_id: sessionId,
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash' },
        },
      }));

      for (let index = 0; index < 10; index += 1) {
        onEvent(JSON.stringify({
          type: 'stream_event',
          session_id: sessionId,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: index === 0 ? '{"command":"' : `part-${index}` },
          },
        }));
      }
    });

    try {
      const session = await primeSession('codex');
      let toolInputNotifications = 0;
      const unsubscribe = useAgentStore.subscribe((state, previousState) => {
        if (state.streamingToolInputs !== previousState.streamingToolInputs) {
          toolInputNotifications += 1;
        }
      });

      await useAgentStore
        .getState()
        .startQuery(session.id, 'stream tool args', 'D:\\project\\ai-code\\codeMUX');

      unsubscribe();
      expect(toolInputNotifications).toBe(1);
      expect(useAgentStore.getState().streamingToolInputs[session.id]?.['tool-1']).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces a live streamed tool placeholder with the complete assistant tool call', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'stream_event',
        session_id: sessionId,
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash' },
        },
      }));
      onEvent(JSON.stringify({
        type: 'stream_event',
        session_id: sessionId,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: '{"command":"powershell.exe -Command Get-Content src\\\\stores\\\\agentStore.ts"}',
          },
        },
      }));
      onEvent(JSON.stringify({
        type: 'stream_event',
        session_id: sessionId,
        event: {
          type: 'content_block_stop',
          index: 0,
        },
      }));
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-complete-tool',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'tool-1',
            name: 'shell_command',
            input: {
              command: 'Get-Content src\\stores\\agentStore.ts',
              timeout_ms: 10000,
              workdir: 'D:\\project\\ai-code\\codeMUX',
            },
          }],
        },
        parent_tool_use_id: null,
      }));
    });

    const session = await primeSession('codex');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'inspect store', 'D:\\project\\ai-code\\codeMUX');

    const toolBlocks = (useAgentStore.getState().events[session.id] ?? [])
      .filter((event) => event.kind === 'assistant')
      .flatMap((event) => event.data.message.content)
      .filter((block) => block.type === 'tool_use' && block.id === 'tool-1');

    expect(toolBlocks).toHaveLength(1);
    expect(toolBlocks[0]).toEqual({
      type: 'tool_use',
      id: 'tool-1',
      name: 'shell_command',
      input: {
        command: 'Get-Content src\\stores\\agentStore.ts',
        timeout_ms: 10000,
        workdir: 'D:\\project\\ai-code\\codeMUX',
      },
    });
  });

  it('keeps a complete assistant tool call when a streamed id exists without a replaceable tool block', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      useAgentStore.setState((state) => ({
        streamedToolUseIds: {
          ...state.streamedToolUseIds,
          [sessionId]: new Set(['tool-race']),
        },
      }));

      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-complete-tool-race',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'tool-race',
            name: 'shell_command',
            input: {
              command: 'rg --files',
              workdir: 'D:\\project\\ai-code\\codeMUX',
            },
          }],
        },
        parent_tool_use_id: null,
      }));
    });

    const session = await primeSession('codex');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'inspect files', 'D:\\project\\ai-code\\codeMUX');

    const toolBlocks = (useAgentStore.getState().events[session.id] ?? [])
      .filter((event) => event.kind === 'assistant')
      .flatMap((event) => event.data.message.content)
      .filter((block) => block.type === 'tool_use' && block.id === 'tool-race');

    expect(toolBlocks).toEqual([{
      type: 'tool_use',
      id: 'tool-race',
      name: 'shell_command',
      input: {
        command: 'rg --files',
        workdir: 'D:\\project\\ai-code\\codeMUX',
      },
    }]);
  });

  it('drops sidecar debug events instead of appending them to the conversation event list', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      for (let index = 0; index < 20; index += 1) {
        onEvent(JSON.stringify({
          type: 'sidecar_debug',
          message: `[debug] noisy stream log ${index}`,
        }));
      }

      onEvent(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-debug',
        session_id: sessionId,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: '',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      }));
    });

    const session = await primeSession('codex');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'debug noise', 'D:\\project\\ai-code\\codeMUX');

    expect(useAgentStore.getState().events[session.id]).toEqual([
      { kind: 'user', data: { content: 'debug noise' } },
      expect.objectContaining({ kind: 'result' }),
    ]);
  });

  it('drops live Claude compact summary user events while keeping the compact marker', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            'This session is being continued from a previous conversation that ran out of context.',
            'The summary below covers the earlier portion of the conversation.',
            '',
            'Summary:',
          ].join('\n'),
        },
        parent_tool_use_id: null,
      }));
      onEvent(JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: {
          trigger: 'manual',
          preTokens: 34000,
        },
      }));
      onEvent(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-compact-live',
        session_id: sessionId,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: '',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      }));
    });

    const session = await primeSession('claude_code');

    await useAgentStore
      .getState()
      .startQuery(session.id, '/compact', 'D:\\project\\ai-code\\codeMUX');

    expect(useAgentStore.getState().events[session.id]).toEqual([
      expect.objectContaining({ kind: 'user', data: expect.objectContaining({ content: '/compact' }) }),
      expect.objectContaining({ kind: 'compact' }),
      expect.objectContaining({ kind: 'result' }),
    ]);
  });

  it('maps live raw Codex compacted events to compact markers', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'compacted',
        timestamp: '2026-07-03T17:22:53.471Z',
        payload: {
          trigger: 'auto',
          pre_tokens: 42000,
          post_tokens: 3000,
        },
      }));
      onEvent(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-compact-live',
        session_id: sessionId,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: '',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      }));
    });

    const session = await primeSession('codex');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'trigger compact', 'D:\\project\\ai-code\\codeMUX');

    expect(useAgentStore.getState().events[session.id]).toEqual([
      { kind: 'user', data: { content: 'trigger compact' } },
      expect.objectContaining({
        kind: 'compact',
        data: expect.objectContaining({
          compact_metadata: expect.objectContaining({
            trigger: 'auto',
            pre_tokens: 42000,
          }),
        }),
      }),
      expect.objectContaining({ kind: 'result' }),
    ]);
  });

  it('replaces the compacting placeholder when the completed compact boundary arrives', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'system_event',
        subtype: 'compact_boundary',
        session_id: sessionId,
        event_id: 'compact-loading',
        content: 'Conversation compacted',
        compact_metadata: { trigger: 'manual', status: 'compacting', pre_tokens: 0, post_tokens: 0 },
      }));
      onEvent(JSON.stringify({
        type: 'system_event',
        subtype: 'compact_boundary',
        session_id: sessionId,
        event_id: 'compact-done',
        content: 'Conversation compacted',
        compact_metadata: { trigger: 'manual', status: 'completed', pre_tokens: 0, post_tokens: 0 },
      }));
      onEvent(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-compact-live',
        session_id: sessionId,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: '',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      }));
    });

    const session = await primeSession('codex');

    await useAgentStore
      .getState()
      .startQuery(session.id, '/compact', 'D:\\project\\ai-code\\codeMUX');

    const compactEvents = useAgentStore
      .getState()
      .events[session.id]
      .filter((event) => event.kind === 'compact');

    // The completed boundary replaced its loading placeholder — no stacked marker.
    expect(compactEvents).toHaveLength(1);
    expect(compactEvents[0]).toMatchObject({
      kind: 'compact',
      data: expect.objectContaining({
        compact_metadata: expect.objectContaining({
          trigger: 'manual',
          status: 'completed',
        }),
      }),
    });
  });

  it('keeps a live session_summary system event in the claude conversation timeline', async () => {
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'system_event',
        subtype: 'session_summary',
        session_id: sessionId,
        event_id: 'summary-live-1',
        diffs: [
          { file: 'D:/demo/src/app.ts', before: 'alpha', after: 'ALPHA', additions: 1, deletions: 1 },
        ],
      }));
      onEvent(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'result-live-summary',
        session_id: sessionId,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: '',
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });

    const session = await primeSession('claude_code');

    await useAgentStore
      .getState()
      .startQuery(session.id, 'edit a file', 'D:\\demo');

    const summaries = useAgentStore
      .getState()
      .events[session.id]
      .filter((event) => event.kind === 'session_summary');

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      kind: 'session_summary',
      data: expect.objectContaining({
        subtype: 'session_summary',
        diffs: [expect.objectContaining({ file: 'D:/demo/src/app.ts' })],
      }),
    });
  });

  it('processes batched stream events without appending the batch to the conversation event list', async () => {
    vi.useFakeTimers();

    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'stream_event_batch',
        session_id: sessionId,
        events: [
          { type: 'content_block_start', content_block: { type: 'text' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello ' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } },
        ],
      }));
    });

    try {
      const session = await primeSession('codex');

      await useAgentStore
        .getState()
        .startQuery(session.id, 'batched stream', 'D:\\project\\ai-code\\codeMUX');

      await vi.advanceTimersByTimeAsync(120);

      expect(useAgentStore.getState().streamingText[session.id]).toBe('hello world');
      expect(useAgentStore.getState().events[session.id]).toEqual([
        { kind: 'user', data: { content: 'batched stream' } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces live Codex text streaming with the final assistant event without duplicate visible text', async () => {
    vi.useFakeTimers();

    let capturedOnEvent: ((event: string) => void) | undefined;
    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      capturedOnEvent = onEvent;
      onEvent(JSON.stringify({
        type: 'stream_event',
        session_id: sessionId,
        event: { type: 'content_block_start', content_block: { type: 'text' } },
      }));
      onEvent(JSON.stringify({
        type: 'stream_event',
        session_id: sessionId,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'final streamed answer' } },
      }));
    });

    try {
      const session = await primeSession('codex');

      await useAgentStore
        .getState()
        .startQuery(session.id, 'stream then final', 'D:\\project\\ai-code\\codeMUX');

      await vi.advanceTimersByTimeAsync(120);
      expect(useAgentStore.getState().streamingText[session.id]).toBe('final streamed answer');

      capturedOnEvent?.(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-final',
        session_id: session.id,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'final streamed answer' }],
        },
      }));

      expect(useAgentStore.getState().streamingText[session.id]).toBe('');
      expect(useAgentStore.getState().events[session.id]).toEqual([
        { kind: 'user', data: { content: 'stream then final' } },
        expect.objectContaining({ kind: 'assistant' }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['codex', loadCodexSessionEventsMock],
    ['claude_code', loadClaudeSessionEventsMock],
  ] as const)('does not fall back to SQLite when %s JSONL history is unavailable', async (agentKind, loaderMock) => {
    const session = await primeSession(agentKind);

    await useAgentStore.getState().loadSessionMessages(session.id);

    expect(loaderMock).toHaveBeenCalledWith(session.id);
    expect(getEventsMock).not.toHaveBeenCalled();
    expect(useAgentStore.getState().events[session.id]).toEqual([]);
  });

  it('loads Codex history CodeMUX tool and outcome events through the live adapter', async () => {
    const session = await primeSession('codex');

    loadCodexSessionEventsMock.mockResolvedValueOnce([
      {
        type: 'tool_started',
        session_id: session.id,
        tool_use_id: 'call-read',
        name: 'read_file',
        input: { path: 'README.md' },
        timestamp: '2026-07-10T12:00:01.000Z',
        event_id: 'history-event-1',
        sequence: 0,
      },
      {
        type: 'tool_finished',
        session_id: session.id,
        tool_use_id: 'call-read',
        content: '内容',
        is_error: false,
        timestamp: '2026-07-10T12:00:02.000Z',
        event_id: 'history-event-2',
        sequence: 1,
      },
      {
        type: 'turn_finished',
        session_id: session.id,
        outcome: 'completed',
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
        timestamp: '2026-07-10T12:00:03.000Z',
        event_id: 'history-event-3',
        sequence: 2,
      },
    ]);

    await useAgentStore.getState().loadSessionMessages(session.id);

    expect(useAgentStore.getState().events[session.id]).toEqual([
      expect.objectContaining({
        kind: 'assistant',
        data: expect.objectContaining({ uuid: 'history-event-1' }),
      }),
      expect.objectContaining({
        kind: 'tool_result',
        data: expect.objectContaining({ uuid: 'history-event-2' }),
      }),
      expect.objectContaining({
        kind: 'result',
        data: expect.objectContaining({ subtype: 'success', uuid: 'history-event-3' }),
      }),
    ]);
  });

  it('refreshes Claude Code token usage from history after loading historical messages', async () => {
    const session = await primeSession('claude_code');
    loadLatestTokenUsageMock.mockResolvedValueOnce({
      total: {
        totalTokens: 260,
        inputTokens: 200,
        cachedInputTokens: 60,
        outputTokens: 40,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: 260,
        inputTokens: 200,
        cachedInputTokens: 60,
        outputTokens: 40,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 258_400,
      contextUsageSource: 'history_file',
      contextUsageFreshness: 'restored',
    });

    loadClaudeSessionEventsMock.mockResolvedValueOnce([
      {
        type: 'user',
        timestamp: '2026-07-10T12:00:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-07-10T12:00:03.000Z',
        uuid: 'assistant-historical',
        session_id: session.id,
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'reply' }],
          usage: {
            input_tokens: 200,
            output_tokens: 40,
            cache_read_input_tokens: 60,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ]);

    await useAgentStore.getState().loadSessionMessages(session.id);

    expect(useAgentStore.getState().events[session.id]).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'result' })]),
    );
    expect(useAgentStore.getState().turns[session.id]).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'completed' })]),
    );
    expect(loadLatestTokenUsageMock).toHaveBeenCalledWith(session.id, 'claude_code', 'restored');
    expect(useAgentStore.getState().tokenUsageBySession[session.id]).toMatchObject({
      total: {
        totalTokens: 260,
        inputTokens: 200,
        cachedInputTokens: 60,
        outputTokens: 40,
      },
      contextUsageSource: 'history_file',
      contextUsageFreshness: 'restored',
    });
  });

  it('restores a completed Turn from normalized assistant usage without a synthetic result', async () => {
    const session = await primeSession('claude_code');
 
    loadClaudeSessionEventsMock.mockResolvedValueOnce([
      {
        type: 'user_message',
        session_id: session.id,
        event_id: 'history-user-1',
        timestamp: '2026-08-15T09:22:56.188Z',
        content: [{ type: 'text', text: 'hello' }],
      },
      {
        type: 'assistant_message',
        session_id: session.id,
        event_id: 'history-assistant-1',
        timestamp: '2026-08-15T09:24:21.552Z',
        content: [{ type: 'text', text: 'reply' }],
        usage: {
          input_tokens: 200,
          output_tokens: 40,
          cache_read_input_tokens: 60,
          cache_creation_input_tokens: 0,
        },
        stop_reason: 'end_turn',
      },
    ]);
 
    await useAgentStore.getState().loadSessionMessages(session.id);
 
    const events = useAgentStore.getState().events[session.id] ?? [];
    expect(events.some((event) => event.kind === 'result')).toBe(false);
    expect(useAgentStore.getState().turns[session.id]?.[0]).toMatchObject({
      status: 'completed',
      durationMs: 85_364,
    });
 
    const assistant = events.find((event) => event.kind === 'assistant');
    expect(assistant?.kind === 'assistant' && assistant.data.message.usage).toMatchObject({
      input_tokens: 200,
      output_tokens: 40,
    });
  });
 
  it('loads historical Claude Agent tool calls without subagent linkage and filters sidechain history', async () => {
    const session = await primeSession('claude_code');

    loadClaudeSessionEventsMock.mockResolvedValueOnce([
      {
        type: 'assistant',
        uuid: 'assistant-agent',
        session_id: session.id,
        timestamp: '2026-06-29T15:34:22.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_22bf1cc2e7484a108461feb0',
              name: 'Agent',
              input: { description: 'Read package.json', prompt: 'Read the file' },
            },
          ],
        },
        parent_tool_use_id: null,
      },
      {
        type: 'assistant',
        uuid: 'sidechain-assistant',
        session_id: session.id,
        isSidechain: true,
        timestamp: '2026-06-29T15:34:25.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'subagent transcript should not be in main history' }],
        },
        parent_tool_use_id: null,
      },
    ]);

    await useAgentStore.getState().loadSessionMessages(session.id);

    const events = useAgentStore.getState().events[session.id] ?? [];
    expect(events).toHaveLength(1);
    const block = events[0]?.kind === 'assistant' ? events[0].data.message.content[0] : undefined;
    expect(block).toMatchObject({
      type: 'tool_use',
      id: 'call_22bf1cc2e7484a108461feb0',
      name: 'Agent',
    });
    expect(block).not.toHaveProperty('agentId');
    expect(block).not.toHaveProperty('subAgentKey');
  });

  it('filters live Claude subagent stream events from the main event list', async () => {
    const session = await primeSession('claude_code');

    startSessionMock.mockImplementationOnce(async (sessionId, _prompt, _cwd, onEvent) => {
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-agent-live',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_live_agent',
              name: 'Agent',
              input: { description: 'Explore', prompt: 'inspect' },
            },
          ],
        },
        parent_tool_use_id: null,
      }));
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-subagent-live',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_read', name: 'Read', input: { file_path: 'package.json' } }],
        },
        parent_tool_use_id: 'call_live_agent',
      }));
      onEvent(JSON.stringify({
        type: 'user',
        uuid: 'tool-result-subagent-live',
        session_id: sessionId,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_read', content: 'package contents' }],
        },
        parent_tool_use_id: 'call_live_agent',
      }));
      onEvent(JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-subagent-summary-live',
        session_id: sessionId,
        isSidechain: true,
        parentUuid: 'tool-result-subagent-live',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Here are the requested values from package.json.' }],
        },
      }));
    });

    await useAgentStore.getState().startQuery(session.id, 'run agent', 'D:\\project\\ai-code\\codeMUX');
    await Promise.resolve();

    const events = useAgentStore.getState().events[session.id] ?? [];
    expect(events).toHaveLength(2);
    expect(events.some((event) => event.kind === 'assistant' && event.data.uuid === 'assistant-subagent-live')).toBe(false);
    expect(events.some((event) => event.kind === 'tool_result' && event.data.uuid === 'tool-result-subagent-live')).toBe(false);
    const block = events.find((event) => event.kind === 'assistant')?.kind === 'assistant'
      ? (events.find((event) => event.kind === 'assistant') as Extract<(typeof events)[number], { kind: 'assistant' }>).data.message.content[0]
      : undefined;
    expect(block).not.toHaveProperty('agentId');
    expect(block).not.toHaveProperty('subAgentKey');
  });

  it('sends image payloads for unknown models by default', async () => {
    const session = await primeSession('codex');
    const inputPayload = {
      text: 'inspect this',
      images: [{ name: 'screen.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,abc' }],
    };

    await useAgentStore
      .getState()
      .startQuery(session.id, inputPayload.text, 'D:\\project\\ai-code\\codeMUX', undefined, undefined, inputPayload, 'future-model-7');

    expect(sendMessageViaDaemonMock).toHaveBeenCalledWith(
      session.id,
      'inspect this',
      inputPayload,
    );
  });

  it.each([
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'mimo-v2.5-pro',
  ])('drops image payloads for explicit no-vision model %s but keeps local preview', async (model) => {
    const session = await primeSession('codex');
    const inputPayload = {
      text: 'inspect this',
      images: [{ name: 'screen.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,abc' }],
    };

    await useAgentStore
      .getState()
      .startQuery(session.id, inputPayload.text, 'D:\\project\\ai-code\\codeMUX', undefined, undefined, inputPayload, model);

    expect(sendMessageViaDaemonMock).toHaveBeenCalledWith(
      session.id,
      'inspect this',
      { text: 'inspect this' },
    );
    expect(useAgentStore.getState().events[session.id]?.[0]).toEqual({
      kind: 'user',
      data: {
        content: 'inspect this',
        attachments: [{ type: 'image', name: 'screen.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,abc' }],
      },
    });
  });

  it('enriches image payloads when enrichment is enabled for a no-vision model', async () => {
    useSettingsStore.setState((state) => ({
      config: state.config
        ? {
            ...state.config,
            attachment_enrichment: {
              enabled: true,
              api_key: 'sk-test',
              base_url: 'https://example.com/v1',
              model: 'glm-4.6v-flash',
            },
          }
        : state.config,
    }));

    const session = await primeSession('codex');
    const inputPayload = {
      text: 'inspect this',
      images: [{ name: 'screen.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,abc' }],
    };

    await useAgentStore
      .getState()
      .startQuery(session.id, inputPayload.text, 'D:\\project\\ai-code\\codeMUX', undefined, undefined, inputPayload, 'deepseek-v4-flash');

    expect(enrichAttachmentsMock).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'image', name: 'screen.png' }),
    ]);
    expect(sendMessageViaDaemonMock).toHaveBeenCalledWith(
      session.id,
      expect.stringContaining('<attachment_context>'),
      expect.objectContaining({ text: expect.stringContaining('inspect this') }),
    );
  });

  it('restores image previews directly from agent JSONL image blocks', async () => {
    const session = await primeSession('codex');
    loadCodexSessionEventsMock.mockResolvedValueOnce([
      {
        type: 'user',
        timestamp: '2026-06-28T12:00:00.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'inspect this' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'abc',
              },
            },
          ],
        },
      },
    ]);

    await useAgentStore.getState().loadSessionMessages(session.id);

    expect(useAgentStore.getState().events[session.id]?.[0]).toEqual({
      kind: 'user',
      data: {
        content: 'inspect this',
        attachments: [{ type: 'image', name: 'image-1.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,abc' }],
      },
    });
  });

  it('rewinds the last turn, clears derived state, and returns text plus image payload', async () => {
    const session = await primeSession('codex');

    useAgentStore.setState({
      events: {
        [session.id]: [
          { kind: 'user', data: { content: 'first turn' } },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-1',
              session_id: session.id,
              message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
              parent_tool_use_id: null,
            },
          },
          {
            kind: 'user',
            data: {
              content: 'inspect image',
              attachments: [{ type: 'image', name: 'screen.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,abc' }],
              locator: {
                providerMessageId: 'codex-user-2',
                lineIndex: 12,
                role: 'user',
                textFingerprint: 'inspect image',
                turnOrdinal: 2,
              },
            },
          },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-2',
              session_id: session.id,
              message: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
              parent_tool_use_id: null,
            },
          },
          {
            kind: 'result',
            data: {
              type: 'result',
              subtype: 'success',
              is_error: false,
              uuid: 'result-2',
              session_id: session.id,
              duration_ms: 10,
              duration_api_ms: 10,
              num_turns: 1,
              result: '',
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ],
      },
      eventTimestamps: { [session.id]: [1, 2, 3, 4, 5] },
      todos: { [session.id]: [{ content: 'old todo', status: 'pending' }] },
      streamingThinking: { [session.id]: 'thinking' },
      streamingText: { [session.id]: 'streaming' },
      changedFiles: { [session.id]: [{ path: 'src/app.ts', status: 'modified', originalContent: 'old', currentContent: 'new', additions: 1, deletions: 1 }] },
    });

    const payload = await useAgentStore.getState().rewindLastTurn(session.id);

    expect(rewindSessionMock).toHaveBeenCalledWith(session.id, 'codex', {
      providerMessageId: 'codex-user-2',
      lineIndex: 12,
      role: 'user',
      textFingerprint: 'inspect image',
      turnOrdinal: 2,
    }, 'conversation');
    expect(payload).toEqual({
      text: 'inspect image',
      images: [{ name: 'screen.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,abc' }],
    });
    expect(useAgentStore.getState().events[session.id]).toEqual([
      { kind: 'user', data: { content: 'first turn' } },
      expect.objectContaining({ kind: 'assistant' }),
    ]);
    expect(useAgentStore.getState().eventTimestamps[session.id]).toEqual([1, 2]);
    expect(useAgentStore.getState().todos[session.id]).toBeUndefined();
    expect(useAgentStore.getState().streamingThinking[session.id]).toBe('');
    expect(useAgentStore.getState().streamingText[session.id]).toBe('');
    expect(useAgentStore.getState().changedFiles[session.id]).toBeUndefined();
  });

  it('rewinds optimistic live user messages without sending a weak target', async () => {
    const session = await primeSession('claude_code');

    useAgentStore.setState({
      events: {
        [session.id]: [
          { kind: 'user', data: { content: 'live prompt' } },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-live',
              session_id: session.id,
              message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
              parent_tool_use_id: null,
            },
          },
        ],
      },
      eventTimestamps: { [session.id]: [100, 200] },
    });

    await useAgentStore.getState().rewindLastTurn(session.id);

    expect(rewindSessionMock).toHaveBeenCalledWith(session.id, 'claude_code', undefined, 'conversation');
  });

  it('marks an inactive session unread after a rewound turn completes', async () => {
    const session = await primeSession('codex');

    useSessionStore.setState({ activeSessionId: 'other-session', unreadSessions: new Set() });
    useAgentStore.setState({
      events: {
        [session.id]: [
          { kind: 'user', data: { content: 'old prompt' } },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-old',
              session_id: session.id,
              message: { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
              parent_tool_use_id: null,
            },
          },
          {
            kind: 'result',
            data: {
              type: 'result',
              subtype: 'success',
              is_error: false,
              uuid: 'result-old',
              session_id: session.id,
              duration_ms: 10,
              duration_api_ms: 10,
              num_turns: 1,
              result: '',
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ],
      },
      eventTimestamps: { [session.id]: [1000, 2000, 3000] },
    });

    await useAgentStore.getState().rewindLastTurn(session.id);
    await useAgentStore.getState().startQuery(session.id, 'edited prompt', 'D:\\project\\ai-code\\codeMUX');

    expect(useSessionStore.getState().unreadSessions.has(session.id)).toBe(true);
  });

  it('rewinds an arbitrary earlier user message by index using its strong locator', async () => {
    const session = await primeSession('codex');

    const firstLocator: AgentUserMessageLocator = {
      providerMessageId: 'codex-user-1',
      lineIndex: 4,
      role: 'user',
      textFingerprint: 'first turn',
      turnOrdinal: 1,
    };
    useAgentStore.setState({
      events: {
        [session.id]: [
          { kind: 'user', data: { content: 'first turn', locator: firstLocator } },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-1',
              session_id: session.id,
              message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
              parent_tool_use_id: null,
            },
          },
          {
            kind: 'user',
            data: {
              content: 'second turn',
              locator: {
                providerMessageId: 'codex-user-2',
                lineIndex: 12,
                role: 'user',
                textFingerprint: 'second turn',
                turnOrdinal: 2,
              },
            },
          },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-2',
              session_id: session.id,
              message: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
              parent_tool_use_id: null,
            },
          },
        ],
      },
      eventTimestamps: { [session.id]: [1, 2, 3, 4] },
      todos: { [session.id]: [{ content: 'old todo', status: 'pending' }] },
      streamingText: { [session.id]: 'streaming' },
    });

    const payload = await useAgentStore.getState().rewindToMessage(session.id, 0);

    expect(rewindSessionMock).toHaveBeenCalledWith(session.id, 'codex', firstLocator, 'conversation');
    expect(payload).toEqual({ text: 'first turn' });
    expect(useAgentStore.getState().events[session.id]).toEqual([]);
    expect(useAgentStore.getState().eventTimestamps[session.id]).toEqual([]);
    expect(useAgentStore.getState().todos[session.id]).toBeUndefined();
    expect(useAgentStore.getState().streamingText[session.id]).toBe('');
  });

  it('clears estimated output tokens when rewinding the conversation', async () => {
    const session = await primeSession('codex');
    useAgentStore.setState({
      events: {
        [session.id]: [
          { kind: 'user', data: { content: 'turn to rewind' } },
          { kind: 'assistant', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } } },
        ],
      },
      eventTimestamps: { [session.id]: [1, 2] },
      streamingEstimatedOutputTokens: { [session.id]: 42 },
    });

    await useAgentStore.getState().rewindToMessage(session.id, 0);

    expect(useAgentStore.getState().streamingEstimatedOutputTokens[session.id]).toBeUndefined();
  });

  it('publishes the truncated transcript and its turn projection in a single store generation', async () => {
    const session = await primeSession('codex');

    const secondTurnLocator: AgentUserMessageLocator = {
      providerMessageId: 'codex-user-2',
      lineIndex: 12,
      role: 'user',
      textFingerprint: 'second turn',
      turnOrdinal: 2,
    };
    useAgentStore.setState({
      events: {
        [session.id]: [
          { kind: 'user', data: { content: 'first turn' } },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-single-generation-1',
              session_id: session.id,
              message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
              parent_tool_use_id: null,
            },
          },
          { kind: 'user', data: { content: 'second turn', locator: secondTurnLocator } },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-single-generation-2',
              session_id: session.id,
              message: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
              parent_tool_use_id: null,
            },
          },
        ],
      },
      eventTimestamps: { [session.id]: [1, 2, 3, 4] },
    });

    const generations: { events: boolean; turns: boolean }[] = [];
    const unsubscribe = useAgentStore.subscribe((state, previous) => {
      const eventsChanged = state.events[session.id] !== previous.events[session.id];
      const turnsChanged = state.turns[session.id] !== previous.turns[session.id];
      if (eventsChanged || turnsChanged) {
        generations.push({ events: eventsChanged, turns: turnsChanged });
      }
    });

    await useAgentStore.getState().rewindToMessage(session.id, 2);
    unsubscribe();

    // The transcript and its turn projection must land together. A separate
    // turns-only generation re-renders every surviving message row twice, which
    // is what made rewinding a long thread freeze the UI.
    expect(generations).toEqual([{ events: true, turns: true }]);
    expect(useAgentStore.getState().events[session.id]).toHaveLength(2);
    expect(useAgentStore.getState().turns[session.id]).toHaveLength(1);
  });

  it('publishes a streamed synthetic tool_use append in a single store generation', async () => {
    const session = await primeSession('claude_code');
    let emitEvent: ((event: string) => void) | undefined;

    startSessionMock.mockImplementationOnce(async (_sessionId, _prompt, _cwd, onEvent) => {
      emitEvent = onEvent;
    });

    await useAgentStore.getState().startQuery(session.id, 'stream a tool call', 'D:\\workspace');
    expect(useAgentStore.getState().isRunning[session.id]).toBe(true);

    const generations: {
      events: boolean;
      isRunning: boolean;
      forceStopped: boolean;
      timestamps: boolean;
      turns: boolean;
    }[] = [];
    let watchingAppend = true;
    const unsubscribe = useAgentStore.subscribe((state, previous) => {
      if (!watchingAppend) { return; }
      const eventsChanged = state.events[session.id] !== previous.events[session.id];
      const turnsChanged = state.turns[session.id] !== previous.turns[session.id];
      if (!eventsChanged && !turnsChanged) { return; }
      generations.push({
        events: eventsChanged,
        isRunning: state.isRunning[session.id] !== previous.isRunning[session.id],
        forceStopped: state.forceStopped[session.id] !== previous.forceStopped[session.id],
        timestamps: state.eventTimestamps[session.id] !== previous.eventTimestamps[session.id],
        turns: turnsChanged,
      });
      // Stop watching once the append itself was published: terminal handling
      // afterwards may legitimately derive `turns` from an `isRunning` change.
      if (eventsChanged) { watchingAppend = false; }
    });

    emitEvent?.(JSON.stringify({
      type: 'stream_event',
      session_id: session.id,
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu-single-generation', name: 'Read' },
      },
    }));
    emitEvent?.(JSON.stringify({
      type: 'stream_event',
      session_id: session.id,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"src/App.tsx"}' },
      },
    }));
    emitEvent?.(JSON.stringify({
      type: 'stream_event',
      session_id: session.id,
      event: { type: 'content_block_stop', index: 0, content_block: { type: 'tool_use' } },
    }));
    unsubscribe();

    // The synthetic append must actually have happened, otherwise the generation
    // assertions below would pass without exercising the path under test.
    const appendedSyntheticToolUse = (useAgentStore.getState().events[session.id] || []).some(
      (entry) => entry.kind === 'assistant'
        && (entry.data.message.content as Array<{ type?: string; id?: string }>).some(
          (block) => block.type === 'tool_use' && block.id === 'toolu-single-generation',
        ),
    );
    expect(appendedSyntheticToolUse).toBe(true);

    // The fingerprint of the old double publish: a generation that only rewrote
    // `turns` while none of its four derivation inputs changed. It forced a second
    // full re-render of every message row per streamed event.
    const purelyDerivedTurns = generations.filter(
      (generation) => !generation.events && !generation.isRunning
        && !generation.forceStopped && !generation.timestamps,
    );
    expect(generations.length).toBeGreaterThan(0);
    expect(purelyDerivedTurns).toEqual([]);
    // The append itself must publish events and turns together.
    expect(generations.some((generation) => generation.events && generation.turns)).toBe(true);
  });

  it('publishes a result append in a single store generation', async () => {
    const session = await primeSession('claude_code');
    let emitEvent: ((event: string) => void) | undefined;

    startSessionMock.mockImplementationOnce(async (_sessionId, _prompt, _cwd, onEvent) => {
      emitEvent = onEvent;
    });

    await useAgentStore.getState().startQuery(session.id, 'finish a turn', 'D:\\workspace');

    const generations: {
      events: boolean;
      isRunning: boolean;
      forceStopped: boolean;
      timestamps: boolean;
      turns: boolean;
    }[] = [];
    let watchingAppend = true;
    const unsubscribe = useAgentStore.subscribe((state, previous) => {
      if (!watchingAppend) { return; }
      const eventsChanged = state.events[session.id] !== previous.events[session.id];
      const turnsChanged = state.turns[session.id] !== previous.turns[session.id];
      if (!eventsChanged && !turnsChanged) { return; }
      generations.push({
        events: eventsChanged,
        isRunning: state.isRunning[session.id] !== previous.isRunning[session.id],
        forceStopped: state.forceStopped[session.id] !== previous.forceStopped[session.id],
        timestamps: state.eventTimestamps[session.id] !== previous.eventTimestamps[session.id],
        turns: turnsChanged,
      });
      // Stop watching once the append itself was published: terminal handling
      // afterwards may legitimately derive `turns` from an `isRunning` change.
      if (eventsChanged) { watchingAppend = false; }
    });

    emitEvent?.(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      session_id: session.id,
    }));
    unsubscribe();

    expect((useAgentStore.getState().events[session.id] || []).some((entry) => entry.kind === 'result')).toBe(true);
    // The fingerprint of the old double publish: a generation that only rewrote
    // `turns` while none of its four derivation inputs changed. It forced a second
    // full re-render of every message row for one appended event.
    const purelyDerivedTurns = generations.filter(
      (generation) => !generation.events && !generation.isRunning
        && !generation.forceStopped && !generation.timestamps,
    );
    expect(generations.length).toBeGreaterThan(0);
    expect(purelyDerivedTurns).toEqual([]);
    expect(generations.some((generation) => generation.events && generation.turns)).toBe(true);
  });

  it('rewinds an earlier user message by turn ordinal and text fingerprint', async () => {
    const session = await primeSession('claude_code');

    const events = [
      { kind: 'user', data: { content: 'first turn' } },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-1',
          session_id: session.id,
          message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
          parent_tool_use_id: null,
        },
      },
      { kind: 'user', data: { content: 'second turn' } },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-2',
          session_id: session.id,
          message: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
          parent_tool_use_id: null,
        },
      },
    ] as const;
    useAgentStore.setState({
      events: { [session.id]: [...events] },
      eventTimestamps: { [session.id]: [1, 2, 3, 4] },
    });

    const payload = await useAgentStore.getState().rewindToMessage(session.id, 0);

    expect(payload).toEqual({ text: 'first turn' });
    expect(rewindSessionMock).toHaveBeenCalledWith(session.id, 'claude_code', {
      role: 'user',
      textFingerprint: 'first turn',
      turnOrdinal: 1,
    }, 'conversation');
    expect(useAgentStore.getState().events[session.id]).toEqual([]);
  });

  it('allows rewinding the latest message without a strong locator via index fallback', async () => {
    const session = await primeSession('claude_code');

    useAgentStore.setState({
      events: {
        [session.id]: [
          { kind: 'user', data: { content: 'first turn' } },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-1',
              session_id: session.id,
              message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
              parent_tool_use_id: null,
            },
          },
          { kind: 'user', data: { content: 'second turn' } },
        ],
      },
      eventTimestamps: { [session.id]: [1, 2, 3] },
    });

    const payload = await useAgentStore.getState().rewindToMessage(session.id, 2);

    expect(payload).toEqual({ text: 'second turn' });
    expect(rewindSessionMock).toHaveBeenCalledWith(session.id, 'claude_code', undefined, 'conversation');
    expect(useAgentStore.getState().events[session.id]).toHaveLength(2);
  });

  it('falls back to ordinal rewind when the latest locator is missing from native history', async () => {
    const session = await primeSession('claude_code');
    const staleLocator = {
      providerMessageId: 'codemux-event-id-not-in-jsonl',
      role: 'user' as const,
      textFingerprint: 'second turn',
    };

    useAgentStore.setState({
      events: {
        [session.id]: [
          { kind: 'user', data: { content: 'first turn' } },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-1',
              session_id: session.id,
              message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
              parent_tool_use_id: null,
            },
          },
          { kind: 'user', data: { content: 'second turn', locator: staleLocator } },
        ],
      },
      eventTimestamps: { [session.id]: [1, 2, 3] },
    });

    rewindSessionMock
      .mockRejectedValueOnce(new Error('Target rewind user message not found in session history C:\\Users\\x.jsonl'))
      .mockResolvedValueOnce({});

    const payload = await useAgentStore.getState().rewindLastTurn(session.id);

    expect(payload).toEqual({ text: 'second turn' });
    expect(rewindSessionMock).toHaveBeenNthCalledWith(1, session.id, 'claude_code', {
      ...staleLocator,
      turnOrdinal: 2,
    }, 'conversation');
    expect(rewindSessionMock).toHaveBeenNthCalledWith(2, session.id, 'claude_code', {
      role: 'user',
      textFingerprint: 'second turn',
      turnOrdinal: 2,
    }, 'conversation');
    expect(useAgentStore.getState().events[session.id]).toHaveLength(2);
  });

  it('returns null when the target index is not a rewindable user event', async () => {
    const session = await primeSession('codex');

    useAgentStore.setState({
      events: {
        [session.id]: [
          { kind: 'user', data: { content: 'first turn' } },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-1',
              session_id: session.id,
              message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
              parent_tool_use_id: null,
            },
          },
        ],
      },
      eventTimestamps: { [session.id]: [1, 2] },
    });

    expect(await useAgentStore.getState().rewindToMessage(session.id, 1)).toBeNull();
    expect(await useAgentStore.getState().rewindToMessage(session.id, 9)).toBeNull();
    expect(rewindSessionMock).not.toHaveBeenCalled();
  });

  it('rejects rewinding an arbitrary message while the session is running', async () => {
    const session = await primeSession('codex');

    useAgentStore.setState({
      isRunning: { [session.id]: true },
      events: {
        [session.id]: [
          { kind: 'user', data: { content: 'first turn' } },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-1',
              session_id: session.id,
              message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
              parent_tool_use_id: null,
            },
          },
        ],
      },
    });

    expect(await useAgentStore.getState().rewindToMessage(session.id, 0)).toBeNull();
    expect(rewindSessionMock).not.toHaveBeenCalled();
  });

  it('rejects rewinding an arbitrary message in a read-only session', async () => {
    const session = await primeSession('codex');

    useSessionStore.setState({
      sessions: [{ ...session, is_read_only: true }],
    });
    useAgentStore.setState({
      events: {
        [session.id]: [
          { kind: 'user', data: { content: 'first turn' } },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-1',
              session_id: session.id,
              message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
              parent_tool_use_id: null,
            },
          },
        ],
      },
    });

    expect(await useAgentStore.getState().rewindToMessage(session.id, 0)).toBeNull();
    expect(rewindSessionMock).not.toHaveBeenCalled();
  });

  it('sends a fingerprint target for Claude file rewind without a provider locator', async () => {
    const session = await primeSession('claude_code');

    useAgentStore.setState({
      events: {
        [session.id]: [
          { kind: 'user', data: { content: 'first turn' } },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-1',
              session_id: session.id,
              message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
              parent_tool_use_id: null,
            },
          },
          { kind: 'user', data: { content: 'second turn' } },
        ],
      },
      eventTimestamps: { [session.id]: [1, 2, 3] },
    });

    rewindSessionMock.mockResolvedValueOnce({ filesChanged: 2 });

    const payload = await useAgentStore.getState().rewindToMessage(session.id, 0, 'files');

    expect(payload).toEqual({ text: 'first turn', filesChanged: 2 });
    expect(rewindSessionMock).toHaveBeenCalledWith(session.id, 'claude_code', {
      role: 'user',
      textFingerprint: 'first turn',
      turnOrdinal: 1,
    }, 'files');
    expect(useAgentStore.getState().events[session.id]).toHaveLength(3);
  });

  it('rejects file rewind for agents that do not support it', async () => {
    const session = await primeSession('codex');

    useAgentStore.setState({
      events: {
        [session.id]: [
          { kind: 'user', data: { content: 'first turn' } },
        ],
      },
    });

    expect(await useAgentStore.getState().rewindToMessage(session.id, 0, 'files')).toBeNull();
    expect(await useAgentStore.getState().rewindToMessage(session.id, 0, 'both')).toBeNull();
    expect(rewindSessionMock).not.toHaveBeenCalled();
  });

  it('keeps rewindLastTurn equivalent to rewinding the latest rewindable message', async () => {
    const session = await primeSession('codex');

    useAgentStore.setState({
      events: {
        [session.id]: [
          { kind: 'user', data: { content: 'first turn' } },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-1',
              session_id: session.id,
              message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
              parent_tool_use_id: null,
            },
          },
          { kind: 'user', data: { content: 'second turn' } },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-2',
              session_id: session.id,
              message: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
              parent_tool_use_id: null,
            },
          },
        ],
      },
      eventTimestamps: { [session.id]: [1, 2, 3, 4] },
    });

    const payload = await useAgentStore.getState().rewindLastTurn(session.id);

    expect(payload).toEqual({ text: 'second turn' });
    expect(rewindSessionMock).toHaveBeenCalledWith(session.id, 'codex', undefined, 'conversation');
    expect(useAgentStore.getState().events[session.id]).toHaveLength(2);
  });

  it('does not restore acknowledged changed-file state while loading history', async () => {
    const session = await primeSession('codex');

    localStorage.setItem(`acknowledged-files-${session.id}`, JSON.stringify(['src/old.ts']));
    loadCodexSessionEventsMock.mockResolvedValueOnce([
      {
        type: 'assistant',
        timestamp: '2026-06-18T12:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'history' }],
        },
      },
    ]);

    await useAgentStore.getState().loadSessionMessages(session.id);

    expect(useAgentStore.getState().acknowledgedFiles[session.id]).toBeUndefined();
  });

  it('does not rewind history when sending a new message after an interrupted turn', async () => {
    const session = await primeSession('claude_code');
    const previousPrompt = '系统怎么实现定时任务功能，在我确认方案之前不要改任何代码';
    const nextPrompt = '怎么实现定时任务功能，在我确认之前不要改任何代码';

    useAgentStore.setState({
      events: {
        [session.id]: [
          { kind: 'user', data: { content: previousPrompt } },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-interrupted',
              session_id: session.id,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: '我先探索一下代码库架构' }],
              },
              parent_tool_use_id: null,
            },
          },
        ],
      },
      eventTimestamps: { [session.id]: [1, 2] },
      isRunning: { [session.id]: false },
      forceStopped: { [session.id]: true },
    });

    rewindSessionMock.mockClear();
    startSessionMock.mockImplementationOnce(async () => {});

    await useAgentStore.getState().startQuery(session.id, nextPrompt, 'D:\\workspace');

    expect(rewindSessionMock).not.toHaveBeenCalled();
    expect(useAgentStore.getState().events[session.id]?.filter((event) => event.kind === 'user')).toEqual([
      { kind: 'user', data: { content: previousPrompt } },
      { kind: 'user', data: { content: nextPrompt } },
    ]);
  });

  it('allows sending the same content again after a completed turn', async () => {
    const session = await primeSession('claude_code');

    useAgentStore.setState({
      events: {
        [session.id]: [
          { kind: 'user', data: { content: 'repeat me' } },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-1',
              session_id: session.id,
              message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
              parent_tool_use_id: null,
            },
          },
          {
            kind: 'result',
            data: {
              type: 'result',
              subtype: 'success',
              is_error: false,
              uuid: 'result-1',
              session_id: session.id,
              duration_ms: 10,
              duration_api_ms: 10,
              num_turns: 1,
              result: '',
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ],
      },
      eventTimestamps: { [session.id]: [1, 2, 3] },
      isRunning: { [session.id]: false },
      forceStopped: { [session.id]: false },
    });

    rewindSessionMock.mockClear();
    startSessionMock.mockImplementationOnce(async () => {});

    await useAgentStore.getState().startQuery(session.id, 'repeat me', 'D:\\workspace');

    expect(rewindSessionMock).not.toHaveBeenCalled();
    expect(useAgentStore.getState().events[session.id]?.filter((event) => event.kind === 'user')).toHaveLength(2);
  });

  it('does not restore a rewound turn from a stale history reload before resend', async () => {
    const session = await primeSession('claude_code');
    const prompt = '系统怎么实现定时任务功能，在我确认方案之前不要改任何代码';

    useAgentStore.setState({
      events: {
        [session.id]: [
          { kind: 'user', data: { content: prompt } },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-1',
              session_id: session.id,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: '我先探索一下代码库架构，了解现有的模式，再设计定时任务方案。' }],
              },
              parent_tool_use_id: null,
            },
          },
        ],
      },
      eventTimestamps: { [session.id]: [1, 2] },
      isRunning: { [session.id]: false },
      forceStopped: { [session.id]: true },
    });

    let resolveTimeline: ((page: { events: Record<string, unknown>[]; hasMore: boolean }) => void) | undefined;
    getTimelineMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveTimeline = resolve;
    }));

    const staleLoad = useAgentStore.getState().loadSessionMessages(session.id);
    await useAgentStore.getState().rewindLastTurn(session.id);
    expect(useAgentStore.getState().events[session.id]).toEqual([]);

    resolveTimeline?.({
      events: [
        { type: 'user_message', session_id: session.id, content: prompt, event_id: 'stale-user' },
        {
          type: 'assistant_message',
          session_id: session.id,
          event_id: 'stale-assistant',
          content: [{ type: 'text', text: '我先探索一下代码库架构，了解现有的模式，再设计定时任务方案。' }],
        },
      ],
      hasMore: false,
    });
    await staleLoad;

    expect(useAgentStore.getState().events[session.id]).toEqual([]);

    startSessionMock.mockImplementationOnce(async () => {});
    await useAgentStore.getState().startQuery(session.id, prompt, 'D:\\workspace');

    expect(useAgentStore.getState().events[session.id]?.filter((event) => event.kind === 'user')).toEqual([
      { kind: 'user', data: { content: prompt } },
    ]);
  });

  it('does not replace richer local history with a partial timeline after rewind and stop', async () => {
    const session = await primeSession('claude_code');
    const firstPrompt = '分析企宽工单 micro 竣工环节';
    const continuePrompt = '继续';

    useAgentStore.setState({
      events: {
        [session.id]: [
          { kind: 'user', data: { content: firstPrompt } },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-before-continue',
              session_id: session.id,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: '我先梳理相关组件' }],
              },
              parent_tool_use_id: null,
            },
          },
          { kind: 'user', data: { content: continuePrompt } },
        ],
      },
      eventTimestamps: { [session.id]: [1, 2, 3] },
      isRunning: { [session.id]: false },
      forceStopped: { [session.id]: true },
    });

    loadSessionEventsMock.mockResolvedValueOnce([
      { type: 'user_message', session_id: session.id, content: continuePrompt, event_id: '4d6268c5-b87a-4ea9-8e97-2230c43f2d32' },
    ]);

    await useAgentStore.getState().loadSessionMessages(session.id);

    expect(useAgentStore.getState().events[session.id]?.filter((event) => event.kind === 'user')).toEqual([
      { kind: 'user', data: { content: firstPrompt } },
      { kind: 'user', data: { content: continuePrompt } },
    ]);
  });

  it('replaces the live narration in place when a pi thinking+text final message arrives', async () => {
    vi.useFakeTimers();
    let emitEvent: ((event: string) => void) | undefined;
    startSessionMock.mockImplementationOnce(async (_s: string, _p: string, _c: string, onEvent: (e: string) => void) => {
      emitEvent = onEvent;
    });
    try {
      const session = await primeSession('pi');
      await useAgentStore.getState().startQuery(session.id, '你好', 'D:/project/x');
      const send = (event: Record<string, unknown>) => emitEvent?.(JSON.stringify({ session_id: session.id, ...event }));
      send({ type: 'content_started', event_id: 'e1', index: 0, content_kind: 'reasoning' });
      send({ type: 'reasoning_delta', event_id: 'e2', index: 0, text: 'THINKING' });
      send({ type: 'content_finished', event_id: 'e3', index: 0 });
      send({ type: 'content_started', event_id: 'e4', index: 1, content_kind: 'text' });
      send({ type: 'text_delta', event_id: 'e5', index: 1, text: 'ANSWER' });
      send({ type: 'content_finished', event_id: 'e6', index: 1 });
      await vi.advanceTimersByTimeAsync(120);
      send({
        type: 'assistant_message',
        event_id: 'e7',
        content: [
          { type: 'thinking', thinking: 'THINKING' },
          { type: 'text', text: 'ANSWER' },
        ],
        provider_stop_reason: 'stop',
      });
      await vi.advanceTimersByTimeAsync(120);
      send({ type: 'turn_finished', event_id: 'e8', outcome: 'completed' });
      await vi.advanceTimersByTimeAsync(120);

      const events = useAgentStore.getState().events[session.id] ?? [];
      const assistantEvents = events.filter((e) => e.kind === 'assistant');
      // thinking+text 最终消息必须原地替换流式 narration，而不是追加第二条。
      expect(assistantEvents).toHaveLength(1);
      const content = (assistantEvents[0].data as { message?: { content?: Array<{ type?: string; text?: string; thinking?: string }> } }).message?.content ?? [];
      expect(content).toEqual([
        { type: 'thinking', thinking: 'THINKING' },
        { type: 'text', text: 'ANSWER' },
      ]);
      expect(useAgentStore.getState().streamingText[session.id] ?? '').toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('appends pi thinking+text final message after tool steps instead of inserting before them', async () => {
    vi.useFakeTimers();
    let emitEvent: ((event: string) => void) | undefined;
    startSessionMock.mockImplementationOnce(async (_s: string, _p: string, _c: string, onEvent: (e: string) => void) => {
      emitEvent = onEvent;
    });
    try {
      const session = await primeSession('pi');
      await useAgentStore.getState().startQuery(session.id, '熟悉架构', 'D:/project/x');
      const send = (event: Record<string, unknown>) => emitEvent?.(JSON.stringify({ session_id: session.id, ...event }));

      send({
        type: 'tool_started',
        event_id: 'tool-1',
        tool_use_id: 'call-1',
        name: 'bash',
        input: { command: 'ls' },
      });
      send({
        type: 'tool_finished',
        event_id: 'tool-1-done',
        tool_use_id: 'call-1',
        content: 'ok',
        is_error: false,
      });
      send({
        type: 'assistant_message',
        event_id: 'final-1',
        content: [
          { type: 'thinking', thinking: 'reviewing layout' },
          { type: 'text', text: '架构概览如下。' },
        ],
        provider_stop_reason: 'stop',
      });
      send({ type: 'turn_finished', event_id: 'turn-1', outcome: 'completed' });
      await vi.advanceTimersByTimeAsync(120);

      const events = useAgentStore.getState().events[session.id] ?? [];
      const toolAssistantIndex = events.findIndex((event) => (
        event.kind === 'assistant'
        && (event.data.message.content as Array<{ type?: string }>).some((block) => block.type === 'tool_use')
      ));
      const finalTextIndex = events.findIndex((event) => (
        event.kind === 'assistant'
        && (event.data.message.content as Array<{ type?: string; text?: string }>).some(
          (block) => block.type === 'text' && block.text === '架构概览如下。',
        )
      ));

      expect(toolAssistantIndex).toBeGreaterThanOrEqual(0);
      expect(finalTextIndex).toBeGreaterThan(toolAssistantIndex);
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves pi final answer after tools when live-stream narration was committed too early', async () => {
    vi.useFakeTimers();
    let emitEvent: ((event: string) => void) | undefined;
    startSessionMock.mockImplementationOnce(async (_s: string, _p: string, _c: string, onEvent: (e: string) => void) => {
      emitEvent = onEvent;
    });
    try {
      const session = await primeSession('pi');
      await useAgentStore.getState().startQuery(session.id, '排查接口', 'D:/project/x');

      const send = (event: Record<string, unknown>) => emitEvent?.(JSON.stringify({ session_id: session.id, ...event }));

      send({ type: 'content_started', event_id: 'e1', index: 0, content_kind: 'text' });
      send({ type: 'text_delta', event_id: 'e2', index: 0, text: '先看下代码' });
      send({ type: 'content_finished', event_id: 'e3', index: 0 });
      await vi.advanceTimersByTimeAsync(120);

      send({
        type: 'tool_started',
        event_id: 'tool-1',
        tool_use_id: 'call-1',
        name: 'read',
        input: { path: 'src/App.tsx' },
      });
      send({
        type: 'tool_finished',
        event_id: 'tool-1-done',
        tool_use_id: 'call-1',
        content: 'ok',
        is_error: false,
      });
      send({
        type: 'assistant_message',
        event_id: 'final-1',
        content: [
          { type: 'thinking', thinking: 'reviewing code' },
          { type: 'text', text: '先看下代码，然后给出结论。' },
        ],
        provider_stop_reason: 'stop',
      });
      send({ type: 'turn_finished', event_id: 'turn-1', outcome: 'completed' });
      await vi.advanceTimersByTimeAsync(120);

      const events = useAgentStore.getState().events[session.id] ?? [];
      const toolAssistantIndex = events.findIndex((event) => (
        event.kind === 'assistant'
        && (event.data.message.content as Array<{ type?: string }>).some((block) => block.type === 'tool_use')
      ));
      const finalTextIndex = events.findIndex((event) => (
        event.kind === 'assistant'
        && (event.data.message.content as Array<{ type?: string; text?: string }>).some(
          (block) => block.type === 'text' && block.text === '先看下代码，然后给出结论。',
        )
      ));

      expect(toolAssistantIndex).toBeGreaterThanOrEqual(0);
      expect(finalTextIndex).toBeGreaterThan(toolAssistantIndex);
      expect(events.filter((event) => (
        event.kind === 'assistant'
        && event.data.uuid === `live-stream-narration:${session.id}`
      ))).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('appends pi text-only final answer after existing tool steps', async () => {
    vi.useFakeTimers();
    let emitEvent: ((event: string) => void) | undefined;
    startSessionMock.mockImplementationOnce(async (_s: string, _p: string, _c: string, onEvent: (e: string) => void) => {
      emitEvent = onEvent;
    });
    try {
      const session = await primeSession('pi');
      await useAgentStore.getState().startQuery(session.id, '排查接口', 'D:/project/x');
      const send = (event: Record<string, unknown>) => emitEvent?.(JSON.stringify({ session_id: session.id, ...event }));

      send({
        type: 'tool_started',
        event_id: 'tool-1',
        tool_use_id: 'call-1',
        name: 'read',
        input: { path: 'src/App.tsx' },
      });
      send({
        type: 'tool_finished',
        event_id: 'tool-1-done',
        tool_use_id: 'call-1',
        content: 'ok',
        is_error: false,
      });
      send({
        type: 'assistant_message',
        event_id: 'final-1',
        content: [{ type: 'text', text: '最终结论。' }],
        provider_stop_reason: 'stop',
      });
      send({ type: 'turn_finished', event_id: 'turn-1', outcome: 'completed' });
      await vi.advanceTimersByTimeAsync(120);

      const events = useAgentStore.getState().events[session.id] ?? [];
      const toolAssistantIndex = events.findIndex((event) => (
        event.kind === 'assistant'
        && (event.data.message.content as Array<{ type?: string }>).some((block) => block.type === 'tool_use')
      ));
      const finalTextIndex = events.findIndex((event) => (
        event.kind === 'assistant'
        && (event.data.message.content as Array<{ type?: string; text?: string }>).some(
          (block) => block.type === 'text' && block.text === '最终结论。',
        )
      ));

      expect(toolAssistantIndex).toBeGreaterThanOrEqual(0);
      expect(finalTextIndex).toBeGreaterThan(toolAssistantIndex);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps pi text-only narration before the tool that follows it', async () => {
    vi.useFakeTimers();
    let emitEvent: ((event: string) => void) | undefined;
    startSessionMock.mockImplementationOnce(async (_s: string, _p: string, _c: string, onEvent: (e: string) => void) => {
      emitEvent = onEvent;
    });
    try {
      const session = await primeSession('pi');
      await useAgentStore.getState().startQuery(session.id, '排查接口', 'D:/project/x');
      const send = (event: Record<string, unknown>) => emitEvent?.(JSON.stringify({ session_id: session.id, ...event }));

      send({
        type: 'assistant_message',
        event_id: 'narration-1',
        content: [{ type: 'text', text: '先看下代码。' }],
        provider_stop_reason: 'tool_use',
      });
      send({
        type: 'tool_started',
        event_id: 'tool-1',
        tool_use_id: 'call-1',
        name: 'read',
        input: { path: 'src/App.tsx' },
      });
      send({
        type: 'tool_finished',
        event_id: 'tool-1-done',
        tool_use_id: 'call-1',
        content: 'ok',
        is_error: false,
      });
      await vi.advanceTimersByTimeAsync(120);

      // 实时阶段：工具到达时不得被提到叙述之上（用户实际看到的时序）。
      const liveEvents = useAgentStore.getState().events[session.id] ?? [];
      const liveNarrationIndex = liveEvents.findIndex((event) => (
        event.kind === 'assistant'
        && (event.data.message.content as Array<{ type?: string; text?: string }>).some(
          (block) => block.type === 'text' && block.text === '先看下代码。',
        )
      ));
      const liveToolIndex = liveEvents.findIndex((event) => (
        event.kind === 'assistant'
        && (event.data.message.content as Array<{ type?: string }>).some((block) => block.type === 'tool_use')
      ));
      expect(liveNarrationIndex).toBeGreaterThanOrEqual(0);
      expect(liveToolIndex).toBeGreaterThanOrEqual(0);
      expect(liveNarrationIndex).toBeLessThan(liveToolIndex);

      send({
        type: 'assistant_message',
        event_id: 'final-1',
        content: [
          { type: 'thinking', thinking: 'reviewing' },
          { type: 'text', text: '结论如下。' },
        ],
        provider_stop_reason: 'stop',
      });
      send({ type: 'turn_finished', event_id: 'turn-1', outcome: 'completed' });
      await vi.advanceTimersByTimeAsync(120);

      const events = useAgentStore.getState().events[session.id] ?? [];
      const narrationIndex = events.findIndex((event) => (
        event.kind === 'assistant'
        && (event.data.message.content as Array<{ type?: string; text?: string }>).some(
          (block) => block.type === 'text' && block.text === '先看下代码。',
        )
      ));
      const toolAssistantIndex = events.findIndex((event) => (
        event.kind === 'assistant'
        && (event.data.message.content as Array<{ type?: string }>).some((block) => block.type === 'tool_use')
      ));
      const finalTextIndex = events.findIndex((event) => (
        event.kind === 'assistant'
        && (event.data.message.content as Array<{ type?: string; text?: string }>).some(
          (block) => block.type === 'text' && block.text === '结论如下。',
        )
      ));

      // 落定后仍是「先叙述、后工具、再最终回答」的源码顺序。
      expect(narrationIndex).toBeGreaterThanOrEqual(0);
      expect(toolAssistantIndex).toBeGreaterThanOrEqual(0);
      expect(finalTextIndex).toBeGreaterThanOrEqual(0);
      expect(narrationIndex).toBeLessThan(toolAssistantIndex);
      expect(toolAssistantIndex).toBeLessThan(finalTextIndex);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps pi streaming thinking buffer when answer text block starts', async () => {
    vi.useFakeTimers();
    let emitEvent: ((event: string) => void) | undefined;
    startSessionMock.mockImplementationOnce(async (_s: string, _p: string, _c: string, onEvent: (e: string) => void) => {
      emitEvent = onEvent;
    });
    try {
      const session = await primeSession('pi');
      await useAgentStore.getState().startQuery(session.id, '分析函数', 'D:/project/x');
      const send = (event: Record<string, unknown>) => emitEvent?.(JSON.stringify({ session_id: session.id, ...event }));

      send({ type: 'content_started', event_id: 'e1', index: 0, content_kind: 'reasoning' });
      send({ type: 'reasoning_delta', event_id: 'e2', index: 0, text: '先理解函数职责' });
      send({ type: 'content_finished', event_id: 'e3', index: 0 });
      await vi.advanceTimersByTimeAsync(120);

      send({ type: 'content_started', event_id: 'e4', index: 1, content_kind: 'text' });
      send({ type: 'text_delta', event_id: 'e5', index: 1, text: '你说得对！' });
      await vi.advanceTimersByTimeAsync(120);

      expect(useAgentStore.getState().streamingThinking[session.id]).toBe('先理解函数职责');
      expect(useAgentStore.getState().streamingText[session.id]).toBe('你说得对！');
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies a daemon-pushed session_title_changed event without touching the timeline', async () => {
    const session = await primeSession('opencode');
    await useAgentStore.getState().startQuery(session.id, 'first message', 'D:/workspace');

    sessionHandlers.get(session.id)?.(JSON.stringify({
      type: 'session_title_changed',
      title: 'Generated native title',
    }));

    expect(useSessionStore.getState().sessions[0].title).toBe('Generated native title');
    // 不进时间线：没有 raw 事件被追加
    expect(useAgentStore.getState().events[session.id]?.some((entry) => entry.kind === 'raw')).toBe(false);
  });

  /**
   * 常开诊断（打包态也在跑的遥测/日志）必须收在构建期 DEV 门控里。
   *
   * 全部是**调用次数**断言：同一段假时钟流式突发在 DEV 与非 DEV 两臂下比较
   * 日志条数，不涉及毫秒。
   */
  describe('dev diagnostics gating', () => {
    const FLUSH_TELEMETRY = 'Streaming flush telemetry';
    const MODEL_TRACE_START_QUERY = 'MODEL_TRACE startQuery dispatching via Daemon Client';
    const MODEL_TRACE_FIRST_DELTA = 'MODEL_TRACE first streaming delta';

    const loggedMessages = (spy: typeof agentLoggerSpies.debug) =>
      spy.mock.calls.map(([message]) => message as string);
    const flushTelemetryCount = () =>
      loggedMessages(agentLoggerSpies.debug).filter((message) => message === FLUSH_TELEMETRY).length;

    /**
     * 1 秒流式突发（两个内容块、共 20 × 50ms 的 delta）：
     * 5 个 thinking delta + 一次 thinking block 收尾，15 个 text delta + 一次 text block 收尾。
     * 事件从 `registerDaemonSessionHandler` 注册的 handler 走，与真实流式同一条路径。
     */
    async function runOneSecondStreamingBurst() {
      const session = await primeSession('claude_code');
      // 默认的合成回放会在回合结束时清空流式状态，本用例自己喂事件。
      startSessionMock.mockImplementationOnce(async () => {});

      await useAgentStore.getState().startQuery(session.id, 'stream', 'D:/workspace');

      const send = (event: Record<string, unknown>) => {
        sessionHandlers.get(session.id)?.(JSON.stringify({ session_id: session.id, ...event }));
      };

      const sendBlock = async (index: number, kind: 'thinking' | 'text', ticks: number) => {
        const blockType = kind === 'thinking' ? 'thinking' : 'text';
        send({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: blockType } } });
        for (let tick = 0; tick < ticks; tick += 1) {
          const delta = kind === 'thinking'
            ? { type: 'thinking_delta', thinking: `think-${tick};` }
            : { type: 'text_delta', text: `chunk-${tick};` };
          send({ type: 'stream_event', event: { type: 'content_block_delta', index, delta } });
          await vi.advanceTimersByTimeAsync(50);
        }
        send({ type: 'stream_event', event: { type: 'content_block_stop', index, content_block: { type: blockType } } });
      };

      await sendBlock(0, 'thinking', 5);
      await sendBlock(1, 'text', 15);

      return session;
    }

    it('DEV 下：1 秒流式突发（thinking + text 两块）= 2 条 Streaming flush telemetry', async () => {
      vi.useFakeTimers();
      vi.stubEnv('DEV', true);
      agentLoggerSpies.debug.mockClear();
      agentLoggerSpies.info.mockClear();

      try {
        await runOneSecondStreamingBurst();

        // 实测口径：这条 telemetry 挂在"内容块收尾"上 —— `content_block_stop`
        // （agentStore.ts:2160 附近）与 `clearPendingStreaming`（agentStore.ts:508 附近），
        // **不是每次 flush（这里约 20 次）一条**。
        expect(flushTelemetryCount()).toBe(2);
        expect(flushTelemetryCount()).toBeLessThan(20);
        expect(loggedMessages(agentLoggerSpies.info)).toContain(MODEL_TRACE_START_QUERY);
        expect(loggedMessages(agentLoggerSpies.info)).toContain(MODEL_TRACE_FIRST_DELTA);
      } finally {
        vi.useRealTimers();
        vi.unstubAllEnvs();
      }
    });

    it('非 DEV 下：同一突发零诊断（telemetry 与两条 MODEL_TRACE 都不发）', async () => {
      vi.useFakeTimers();
      vi.stubEnv('DEV', false);
      agentLoggerSpies.debug.mockClear();
      agentLoggerSpies.info.mockClear();

      try {
        const session = await runOneSecondStreamingBurst();

        expect(flushTelemetryCount()).toBe(0);
        expect(loggedMessages(agentLoggerSpies.info)).not.toContain(MODEL_TRACE_START_QUERY);
        expect(loggedMessages(agentLoggerSpies.info)).not.toContain(MODEL_TRACE_FIRST_DELTA);
        // 门控只砍诊断：流式本身照旧逐段推进到 store（thinking 缓冲区在 text 块
        // 开始时按既有逻辑清空，所以这里只看正文）。
        expect(useAgentStore.getState().streamingText[session.id] ?? '').toContain('chunk-0;');
        expect(useAgentStore.getState().streamingText[session.id] ?? '').toContain('chunk-14;');
      } finally {
        vi.useRealTimers();
        vi.unstubAllEnvs();
      }
    });
  });
});

describe('agent rewind capabilities', () => {
  it('enables conversation-only rewind for pi (sidecar native fork)', async () => {
    expect(supportsRewindMode('pi', 'conversation')).toBe(true);
    expect(supportsRewindMode('pi', 'files')).toBe(false);
    expect(supportsRewindMode('pi', 'both')).toBe(false);
    expect(AGENT_REWIND_CAPABILITIES.pi).toEqual({
      conversation: true,
      files: false,
      both: false,
    });
  });
});

describe('agent store session start branch', () => {
  function branchSession(gitBranch: string | null): Session {
    return {
      id: 'session-branch-1',
      title: 'Branch Session',
      agent_kind: 'opencode',
      provider_id: null,
      model: null,
      mode: 'agent',
      project_id: null,
      working_path: null,
      git_branch: gitBranch,
      created_at: '',
      updated_at: '',
    };
  }

  it('backfills git_branch from the working path response', async () => {
    const session = branchSession(null);
    useSessionStore.setState({ sessions: [session], archivedSessions: [] });
    updateWorkingPathMock.mockResolvedValueOnce({ ...session, git_branch: 'feature/hover' });

    useAgentStore.getState().setSessionWorkingPath(session.id, 'D:/project/codeMUX');

    await vi.waitFor(() => {
      expect(useSessionStore.getState().sessions[0].git_branch).toBe('feature/hover');
    });
    expect(useSessionStore.getState().sessions[0].working_path).toBe('D:/project/codeMUX');
  });

  it('keeps the stored branch when the daemon response carries none', async () => {
    const session = branchSession('feature/keep');
    useSessionStore.setState({ sessions: [session], archivedSessions: [] });
    updateWorkingPathMock.mockResolvedValueOnce(undefined);

    useAgentStore.getState().setSessionWorkingPath(session.id, 'D:/project/codeMUX');

    await vi.waitFor(() => {
      expect(useSessionStore.getState().sessions[0].working_path).toBe('D:/project/codeMUX');
    });
    expect(useSessionStore.getState().sessions[0].git_branch).toBe('feature/keep');
  });
});
