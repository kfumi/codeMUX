import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../types/session';

// 组合集成测试:真实 daemon-session-bridge(水位线+已接受序号集合) + 真实
// agentStore(帧处理/收尾/补拉) + 真实 convertAgentEvents(卡片挂载)。
// 只 mock daemon facade(HTTP/WS 传输层),模拟 daemon 的帧序与时间线快照行为。

const {
  sendMessageViaDaemonMock,
  loadLatestTokenUsageMock,
  subscribeSessionImpl,
  timelineStore,
} = vi.hoisted(() => {
  const sendMessageViaDaemonMock = vi.fn<(sessionId: string, prompt: string) => Promise<void>>();
  const loadLatestTokenUsageMock = vi.fn(() => Promise.resolve(null));
  // daemon WS 订阅回调(由真实 bridge 注册)
  const subscribeHandlers = new Map<string, {
    onEvent: (event: unknown) => void;
    onState: (running: boolean) => void;
  }>();
  const subscribeSessionImpl = { handlers: subscribeHandlers };
  // 模拟 daemon 侧时间线(DB):补拉/历史加载都从这里读快照。
  const timelineStore = {
    frames: [] as Array<Record<string, unknown> & { sequence: number }>,
  };
  return { sendMessageViaDaemonMock, loadLatestTokenUsageMock, subscribeSessionImpl, timelineStore };
});

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), warning: vi.fn() },
}));

vi.mock('../lib/facades/daemon-facade', () => ({
  ensureDaemonClient: vi.fn(() => Promise.resolve({
    subscribeSession: vi.fn((sessionId: string, handlers: {
      onEvent: (event: unknown) => void;
      onState: (running: boolean) => void;
    }) => {
      subscribeSessionImpl.handlers.set(sessionId, handlers);
      return () => {};
    }),
    getTimeline: vi.fn(async () => ({
      events: timelineStore.frames.map((frame) => ({ ...frame })),
      seqEnd: timelineStore.frames.length - 1,
      hasOlder: false,
    })),
    sendMessage: sendMessageViaDaemonMock,
  })),
  daemonFacade: {
    sendMessageViaDaemon: sendMessageViaDaemonMock,
    getTimeline: vi.fn(async () => ({
      events: timelineStore.frames.map((frame) => ({ ...frame })),
      seqEnd: timelineStore.frames.length - 1,
      hasOlder: false,
    })),
    interruptViaDaemon: vi.fn(() => Promise.resolve()),
    respondToPermissionViaDaemon: vi.fn(),
    respondToInteractiveViaDaemon: vi.fn(),
    rewindSession: vi.fn(),
    resyncSessionFromNative: vi.fn(),
    updateWorkingPath: vi.fn(() => Promise.resolve(null)),
    touchSession: vi.fn(() => Promise.resolve()),
    updateSessionTitle: vi.fn(() => Promise.resolve()),
    listSessions: vi.fn(() => Promise.resolve([])),
    listArchivedSessions: vi.fn(() => Promise.resolve([])),
    listProjects: vi.fn(() => Promise.resolve([])),
    ensureClient: vi.fn(),
    enrichAttachments: vi.fn(async () => ({ blocks: [] })),
    loadLatestTokenUsage: loadLatestTokenUsageMock,
    loadSessionSubagents: vi.fn(() => Promise.resolve({ subagents: [], timelines: {} })),
    ensureAgentSession: vi.fn(() => Promise.resolve()),
    getAgentSessionInfo: vi.fn(() => Promise.resolve({ agentSessionId: null, messagePath: null })),
    isSessionTurnActive: vi.fn(() => Promise.resolve(false)),
  },
  getDaemonClientInitError: vi.fn(() => null),
  resetDaemonClient: vi.fn(),
}));

vi.mock('../lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/logger')>();
  return {
    ...actual,
    createLogger: () => ({
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { useAgentStore } from './agentStore';
import { useSessionStore } from './sessionStore';
import { useSettingsStore } from './settingsStore';
import { convertAgentEventsToAssistantMessages } from '../components/agent/assistant-ui/convertAgentEvents';
import { resetDaemonSessionBridge, getLastEventSequence } from '../lib/daemon-session-bridge';

async function primeSession(agentKind: Session['agent_kind']) {
  const session: Session = {
    id: `session-live-${agentKind}-1`,
    title: `${agentKind} live flow`,
    agent_kind: agentKind,
    provider_id: null,
    model: 'test-model',
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

/** 模拟 daemon:帧入库(分配 sequence)并经 WS 实时广播。 */
function emitFrame(sessionId: string, wire: Record<string, unknown>): number {
  const sequence = timelineStore.frames.length;
  const frame = { ...wire, sequence, session_id: sessionId };
  timelineStore.frames.push(frame);
  subscribeSessionImpl.handlers.get(sessionId)?.onEvent(frame);
  return sequence;
}

describe('session summary live attach (bridge + store integration)', () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetDaemonSessionBridge();
    timelineStore.frames = [];
    subscribeSessionImpl.handlers.clear();
    sendMessageViaDaemonMock.mockReset();
    loadLatestTokenUsageMock.mockReset();
    loadLatestTokenUsageMock.mockImplementation(() => Promise.resolve(null));

    useSettingsStore.setState({
      config: {
        model_providers: [],
        active_provider_id: null,
        agent_defaults: { default_agent_kind: 'claude_code' },
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
  });

  it('实时帧序 summary → turn_finished:回合结束后卡片必须挂在最终助手消息上', async () => {
    const session = await primeSession('claude_code');

    // 真实第三轮帧序(15:17:38-50):用户消息 → 工具三连 → 最终助手 → 汇总 → 回合结束。
    sendMessageViaDaemonMock.mockImplementation(async (sessionId) => {
      // 等真实 bridge 的 ensureDaemonSubscription 完成(异步),与生产一致:帧总在订阅建立后到达。
      await new Promise((resolve) => setTimeout(resolve, 0));
      emitFrame(sessionId, {
        type: 'user_message',
        content: '将 package.json 里的 name 改为 pi-desktop10',
      });
      emitFrame(sessionId, {
        type: 'tool_started',
        tool_use_id: 'call_edit_final',
        name: 'Edit',
        input: { file_path: 'D:/demo/package.json', old_string: '"pi-desktop9"', new_string: '"pi-desktop10"' },
      });
      emitFrame(sessionId, {
        type: 'file_snapshot',
        file_path: 'D:/demo/package.json',
        original_content: '{"name": "pi-desktop9"}',
        is_new: false,
        tool_use_id: 'call_edit_final',
      });
      emitFrame(sessionId, {
        type: 'tool_finished',
        tool_use_id: 'call_edit_final',
        content: 'ok',
        is_error: false,
      });
      emitFrame(sessionId, {
        type: 'assistant_message',
        content: [{ type: 'text', text: '已完成,name 已改为 "pi-desktop10"。' }],
      });
      emitFrame(sessionId, {
        type: 'system_event',
        subtype: 'session_summary',
        event_id: 'summary-live-1',
        diffs: [{ file: 'D:/demo/package.json', before: '{"name": "pi-desktop9"}', after: '{"name": "pi-desktop10"}', additions: 1, deletions: 1 }],
      });
      emitFrame(sessionId, {
        type: 'turn_finished',
        outcome: 'completed',
      });
    });

    await useAgentStore.getState().startQuery(session.id, '改 name', 'D:/demo');
    // 冲刷补拉等异步收尾。
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const storeEvents = useAgentStore.getState().events[session.id] ?? [];
    const summaries = storeEvents.filter((event) => event.kind === 'session_summary');
    expect(summaries.length, `summary 必须恰好在时间线出现一次,实际帧类型: ${storeEvents.map((e) => e.kind).join(',')}`).toBe(1);

    const turns = useAgentStore.getState().turns[session.id] ?? [];
    const messages = convertAgentEventsToAssistantMessages(storeEvents, turns);
    const cards = messages
      .flatMap((message) => message.content)
      .filter((part) => part.type === 'data-codemux-event' && part.eventKind === 'session_summary');
    expect(cards.length, '转换后必须产出一张产物卡片').toBe(1);
  });

  it('turn_finished 先于 summary 到达(乱序窗口):补拉补回 summary 后卡片恰好一张', async () => {
    const session = await primeSession('claude_code');

    sendMessageViaDaemonMock.mockImplementation(async (sessionId) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      emitFrame(sessionId, { type: 'user_message', content: '改 name' });
      emitFrame(sessionId, {
        type: 'tool_started',
        tool_use_id: 'call_edit_a',
        name: 'Edit',
        input: { file_path: 'D:/demo/package.json' },
      });
      emitFrame(sessionId, {
        type: 'file_snapshot',
        file_path: 'D:/demo/package.json',
        original_content: '{"name": "pi-desktop9"}',
        is_new: false,
        tool_use_id: 'call_edit_a',
      });
      emitFrame(sessionId, { type: 'tool_finished', tool_use_id: 'call_edit_a', content: 'ok', is_error: false });
      emitFrame(sessionId, {
        type: 'assistant_message',
        content: [{ type: 'text', text: '已完成。' }],
      });
      // 生产实测时序:summary 在乱序窗口里没被客户端收到,turn_finished 先抬高水位线。
      const summarySequence = timelineStore.frames.length;
      const summaryFrame = {
        type: 'system_event',
        subtype: 'session_summary',
        event_id: 'summary-reorder-1',
        diffs: [{ file: 'D:/demo/package.json', before: '{"name": "pi-desktop9"}', after: '{"name": "pi-desktop10"}', additions: 1, deletions: 1 }],
        sequence: summarySequence,
        session_id: sessionId,
      };
      timelineStore.frames.push(summaryFrame); // 只入库,不广播(模拟乱序窗口丢失)
      emitFrame(sessionId, { type: 'turn_finished', outcome: 'completed' });
    });

    await useAgentStore.getState().startQuery(session.id, '改 name', 'D:/demo');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const storeEvents = useAgentStore.getState().events[session.id] ?? [];
    const summaries = storeEvents.filter((event) => event.kind === 'session_summary');
    expect(summaries.length, '补拉必须把乱序丢失的 summary 补回且只补一次').toBe(1);

    const turns = useAgentStore.getState().turns[session.id] ?? [];
    const messages = convertAgentEventsToAssistantMessages(storeEvents, turns);
    const cards = messages
      .flatMap((message) => message.content)
      .filter((part) => part.type === 'data-codemux-event' && part.eventKind === 'session_summary');
    expect(cards.length, '转换后必须产出一张产物卡片').toBe(1);
    expect(getLastEventSequence(session.id)).toBeGreaterThan(0);
  });
});
