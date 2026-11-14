// @vitest-environment jsdom
// Regression tests for multi-segment assistant turns (OpenCode emits
// thinking → assistant_message → text → assistant_message repeatedly within
// one turn). Guards the StreamingContent visibility rules in CodeMuxThread.

import { cleanup, render, act, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore } from '../../../stores/agentStore';
import { useActivityGroupStore } from '../../../stores/activityGroupStore';
import { useSessionStore } from '../../../stores/sessionStore';
import type { Session } from '../../../types/session';
import { useSettingsStore } from '../../../stores/settingsStore';
import { TooltipProvider } from '../../ui/tooltip';
import { CodeMuxAssistantRuntimeProvider } from './CodeMuxAssistantRuntime';
import { CodeMuxThread } from './CodeMuxThread';

const SESSION = 'session-streaming-segments';

const { sessionHandlers, sendMessageViaDaemonMock, tokenSpeedMock } = vi.hoisted(() => {
  const sessionHandlers = new Map<string, (raw: string) => void>();
  return {
    sessionHandlers,
    sendMessageViaDaemonMock: vi.fn<(sessionId: string, prompt: string, payload?: { text: string }, options?: { delivery?: 'steer'; requestId?: string }) => Promise<void>>(),
    tokenSpeedMock: vi.fn<() => number | null>(() => null),
  };
});

vi.mock('@/hooks/useTokenOutputSpeed', () => ({
  useTokenOutputSpeed: tokenSpeedMock,
}));

vi.mock('../../../lib/daemon-session-bridge', () => ({
  registerDaemonSessionHandler: vi.fn((sessionId: string, handler: (raw: string) => void) => {
    sessionHandlers.set(sessionId, handler);
  }),
  unregisterDaemonSessionHandler: vi.fn((sessionId: string) => {
    sessionHandlers.delete(sessionId);
  }),
  getLastEventSequence: vi.fn(() => -1),
  setLastEventSequence: vi.fn(),
  catchUpTimelineAfterSequence: vi.fn(),
  teardownDaemonSession: vi.fn(),
  resetDaemonSessionBridge: vi.fn(),
}));

vi.mock('../../../lib/facades/daemon-facade', () => ({
  ensureDaemonClient: vi.fn(() => Promise.resolve({ sendMessage: sendMessageViaDaemonMock })),
  daemonFacade: {
    updateSessionTitle: vi.fn(() => Promise.resolve()),
    ensureClient: vi.fn(),
    getAgentSessionInfo: vi.fn(() => Promise.resolve({ agentSessionId: null, messagePath: null })),
    session: {
      sendMessage: sendMessageViaDaemonMock,
      interrupt: vi.fn(),
      respondToPermission: vi.fn(),
      respondToInteractive: vi.fn(),
      rewind: vi.fn(),
      resyncFromNative: vi.fn(),
      updateWorkingPath: vi.fn(() => Promise.resolve()),
      touch: vi.fn(() => Promise.resolve()),
      list: vi.fn(() => Promise.resolve([])),
      listArchived: vi.fn(() => Promise.resolve([])),
      enrichAttachments: vi.fn(),
      loadLatestTokenUsage: vi.fn(() => Promise.resolve(null)),
      loadSubagents: vi.fn(() => Promise.resolve({ subagents: [], timelines: {} })),
      ensureAgent: vi.fn(() => Promise.resolve()),
      isTurnActive: vi.fn(() => Promise.resolve(false)),
    },
    timeline: {
      get: vi.fn(async () => ({ events: [], hasMore: false })),
    },
    project: {
      list: vi.fn(() => Promise.resolve([])),
    },
  },
  getDaemonClientInitError: vi.fn(() => null),
  resetDaemonClient: vi.fn(),
}));

function Harness() {
  return (
    <TooltipProvider>
      <CodeMuxAssistantRuntimeProvider
        sessionId={SESSION}
        onSend={vi.fn(async () => {})}
        onCommand={vi.fn(async () => {})}
      >
        <CodeMuxThread sessionId={SESSION} />
      </CodeMuxAssistantRuntimeProvider>
    </TooltipProvider>
  );
}

describe('CodeMuxThread multi-segment streaming visibility', () => {
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // 过程组展开状态是应用运行期 store：逐测试重置，避免用例间点击串味。
    useActivityGroupStore.setState({ openByKey: {} });
    class MockResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

    sessionHandlers.clear();
    sendMessageViaDaemonMock.mockReset();
    tokenSpeedMock.mockReset();
    tokenSpeedMock.mockReturnValue(null);
    sendMessageViaDaemonMock.mockImplementation(async (sessionId: string, prompt: string) => {
      const handler = sessionHandlers.get(sessionId);
      if (!handler) return;
      // startQuery path passes through the daemon bridge; keep the prompt for assertions.
      void prompt;
    });

    const session: Session = {
      id: SESSION,
      title: 'streaming segments',
      agent_kind: 'opencode',
      provider_id: null,
      model: 'glm-5.3-flash',
      mode: 'agent',
      project_id: null,
      created_at: '',
      updated_at: '',
    };
    useSessionStore.setState({ sessions: [session], archivedSessions: [], activeSessionId: SESSION, isLoading: false, error: null });
    useAgentStore.setState({
      events: {}, eventTimestamps: {}, turns: {}, isRunning: {}, backgroundLive: {}, error: {},
      mcpRuntimeStatus: {}, todos: {}, tokenUsageBySession: {}, tokenUsageRefreshRequests: {},
      streamingThinking: {}, streamingText: {}, streamingEstimatedOutputTokens: {}, streamingVersion: {},
      committedThinkingVersion: {}, streamingThinkingEpoch: {},
      forceStopped: {}, queuedQueries: {}, queuePaused: {},
      streamingToolInputs: {}, streamingToolMeta: {}, streamingToolIndexMap: {}, streamedToolUseIds: {},
      changedFiles: {}, fileOriginals: {}, acknowledgedFiles: {}, pendingPermissions: {},
      queryStartTime: {},
    });
    useSettingsStore.setState({
      config: {
        model_providers: [],
        active_provider_id: null,
        agent_defaults: { default_agent_kind: 'opencode' },
        agent_configs: { claude_code: {}, codex: {}, gemini_cli: {}, opencode: {} },
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
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function startTurnWithUserMessage() {
    await useAgentStore.getState().startQuery(SESSION, 'multi segment turn', 'D:/project/x');
    const send = (event: Record<string, unknown>) => {
      act(() => {
        const handler = sessionHandlers.get(SESSION);
        handler?.(JSON.stringify({ session_id: SESSION, ...event }));
      });
    };
    const flush = async () => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    };
    return { send, flush };
  }

  function expectLiveReasoning(container: HTMLElement, present: boolean) {
    const row = container.querySelector('[data-streaming-reasoning="true"]');
    if (present) {
      expect(row).toBeTruthy();
    } else {
      expect(row).toBeNull();
    }
  }

  it('shows later-segment thinking after an earlier segment committed within one turn', async () => {
    const { container } = render(<Harness />);
    const { send, flush } = await startTurnWithUserMessage();

    // Segment 1: thinking streams, then commits as its own assistant_message.
    send({ type: 'content_started', event_id: 'e1', index: 0, content_kind: 'reasoning' });
    send({ type: 'reasoning_delta', event_id: 'e2', index: 0, text: 'SEG1 thinking' });
    await flush();
    expectLiveReasoning(container, true);
    // 实时思考默认收起：正文不进 DOM，先展开再断言字号。
    const liveTrigger = container.querySelector(
      '[data-streaming-reasoning="true"] [data-slot="reasoning-trigger"]',
    );
    expect(liveTrigger?.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(liveTrigger!);
    // 实时思考正文与完成后（ActivityStepThinking 自己的正文容器）同字号：都走全局正文档。
    const liveThinkingBody = container.querySelector(
      '[data-streaming-reasoning="true"] [data-slot="activity-step-body"] pre',
    );
    expect(liveThinkingBody?.getAttribute('class')).toContain('text-ui-body');
    expect(liveThinkingBody?.getAttribute('class')).not.toContain('text-ui-caption');

    send({ type: 'assistant_message', event_id: 'em1', content: [{ type: 'thinking', thinking: 'SEG1 thinking' }], provider_message_id: 'msg-1' });
    await flush();
    expectLiveReasoning(container, false);

    // Segment 2: fresh thinking stream — 并入运行尾段（已提交 1 步 + 实时 1 步 = 成组）：
    // 实时面板不再直接显示，组头出现并跟随 SEG2 的尾部摘要（默认收起）。
    send({ type: 'content_started', event_id: 'e3', index: 1, content_kind: 'reasoning' });
    send({ type: 'reasoning_delta', event_id: 'e4', index: 1, text: 'SEG2 brand new thinking' });
    await flush();
    expectLiveReasoning(container, false);
    const header = container.querySelector('[data-slot="activity-run-trigger"]');
    expect(header).not.toBeNull();
    expect(header?.getAttribute('data-live')).toBe('true');
    expect(header?.getAttribute('aria-expanded')).toBe('false');
    expect(header?.getAttribute('aria-label')).toContain('SEG2 brand new thinking');

    // 展开组：已提交的 SEG1 思考与 SEG2 实时思考都可见。
    fireEvent.click(header!);
    expect(container.querySelectorAll('[data-slot="reasoning-trigger"]')).toHaveLength(2);
    expect(container.querySelector('[data-streaming-reasoning="true"]')).not.toBeNull();
  }, 30000);

  it('keeps committed segments in the timeline across a full two-segment turn', async () => {
    const { container } = render(<Harness />);
    const { send, flush } = await startTurnWithUserMessage();

    // Segment 1: thinking → commit → text → commit.
    send({ type: 'content_started', event_id: 'e1', index: 0, content_kind: 'reasoning' });
    send({ type: 'reasoning_delta', event_id: 'e2', index: 0, text: 'THINK-1 first round' });
    await flush();
    expectLiveReasoning(container, true);

    send({ type: 'assistant_message', event_id: 'em1', content: [{ type: 'thinking', thinking: 'THINK-1 first round' }], provider_message_id: 'msg-1' });
    send({ type: 'content_started', event_id: 'e3', index: 1, content_kind: 'text' });
    send({ type: 'text_delta', event_id: 'e4', index: 1, text: 'ANSWER-1 final answer' });
    await flush();
    expect(container.querySelector('[data-streaming-text="markdown"]')).toBeTruthy();
    // 实时正文气泡与完成后正文同字号（text-ui-body），不再自降一档成 text-sm。
    const liveTextBubble = container.querySelector('[data-streaming-text="markdown"]');
    expect(liveTextBubble?.getAttribute('class')).toContain('text-ui-body');
    expect(liveTextBubble?.getAttribute('class')).not.toContain('text-sm');

    send({ type: 'assistant_message', event_id: 'em2', content: [{ type: 'text', text: 'ANSWER-1 final answer' }], provider_message_id: 'msg-1' });
    await flush();

    // Segment 2: same cycle; segment 1 content must remain visible.
    send({ type: 'content_started', event_id: 'f1', index: 2, content_kind: 'reasoning' });
    send({ type: 'reasoning_delta', event_id: 'f2', index: 2, text: 'THINK-2 second round' });
    await flush();
    expectLiveReasoning(container, true);

    send({ type: 'assistant_message', event_id: 'em3', content: [{ type: 'thinking', thinking: 'THINK-2 second round' }], provider_message_id: 'msg-2' });
    send({ type: 'content_started', event_id: 'f3', index: 3, content_kind: 'text' });
    send({ type: 'text_delta', event_id: 'f4', index: 3, text: 'ANSWER-2 second answer' });
    send({ type: 'assistant_message', event_id: 'em4', content: [{ type: 'text', text: 'ANSWER-2 second answer' }], provider_message_id: 'msg-2' });
    send({ type: 'turn_finished', event_id: 'em5', outcome: 'completed', duration_ms: 10 });
    await flush();
    await act(async () => {
      useAgentStore.setState((state) => ({ isRunning: { ...state.isRunning, [SESSION]: false } }));
    });
    await flush();

    const text = container.textContent ?? '';
    expect(text).toContain('ANSWER-1 final answer');
    expect(text).toContain('ANSWER-2 second answer');
    // 无段组头：过程按源码顺序平铺，两条已提交的思考各是一行收起的单行摘要。
    expect(container.querySelectorAll('[data-slot="activity-run-trigger"]')).toHaveLength(0);
    const triggers = container.querySelectorAll('[data-slot="reasoning-trigger"]');
    expect(triggers).toHaveLength(2);
    expect(triggers[0]?.getAttribute('aria-expanded')).toBe('false');
    expect(triggers[1]?.getAttribute('aria-expanded')).toBe('false');
  }, 30000);

  it('shows the estimated output speed only while the turn is running', async () => {
    tokenSpeedMock.mockReturnValue(42.42);
    const { container } = render(<Harness />);
    const { send, flush } = await startTurnWithUserMessage();

    expect(container.textContent).toContain('42.4 tok/s');
    const speedStatus = container.querySelector('[aria-label*="估算输出速度"]');
    expect(speedStatus?.getAttribute('aria-label')).toContain('42.4');
    expect(speedStatus?.getAttribute('tabindex')).toBe('0');
    expect(speedStatus?.className).toContain('text-ui-body');
    expect(speedStatus?.className).toContain('leading-none');
    expect(speedStatus?.textContent).toMatch(/·\s*42\.4 tok\/s/);

    send({ type: 'turn_finished', event_id: 'speed-finished', outcome: 'completed', duration_ms: 10 });
    await flush();
    expect(container.textContent).not.toContain('tok/s');
  });

  it('does not render a speed placeholder before a reading is available', async () => {
    const { container } = render(<Harness />);
    const { send, flush } = await startTurnWithUserMessage();

    send({ type: 'tool_started', event_id: 'speed-tool', tool_use_id: 'tool-speed', name: 'Bash', input: { command: 'pwd' } });
    await flush();
    expect(container.textContent).not.toContain('tok/s');
  });

  it('「工作中」状态行自带固定上间距，紧跟任何类型的上一项都不改变', async () => {
    const { container } = render(<Harness />);
    const { send, flush } = await startTurnWithUserMessage();
    await flush();

    const footer = () => container.querySelector('[data-testid="streaming-status-footer"]');

    // 没有实时内容：状态行直接跟在最后一条消息行后面，中间不留会叠加 margin 的空壳。
    expect(footer()).toBeTruthy();
    expect(footer()!.previousElementSibling?.hasAttribute('data-message-row')).toBe(true);

    // 实时思考出现：状态行仍在实时内容容器之外，间距只由它自己的 mt-3 承担。
    send({ type: 'content_started', event_id: 'gap-e1', index: 0, content_kind: 'reasoning' });
    send({ type: 'reasoning_delta', event_id: 'gap-e2', index: 0, text: 'GAP thinking' });
    await flush();
    expect(footer()).toBeTruthy();
    expect(footer()!.closest('[data-streaming-reasoning="true"]')).toBeNull();
    expect(
      footer()!.previousElementSibling?.querySelector('[data-streaming-reasoning="true"]'),
    ).toBeTruthy();

    // 思考提交后实时内容消失，状态行前面换回消息行 —— 间距来源不变。
    send({ type: 'assistant_message', event_id: 'gap-em1', content: [{ type: 'thinking', thinking: 'GAP thinking' }], provider_message_id: 'msg-gap' });
    await flush();
    expect(footer()).toBeTruthy();
    expect(footer()!.previousElementSibling?.hasAttribute('data-message-row')).toBe(true);

    // 三种前置形态共用同一份类名（自己承担的上间距），不再依赖上一项的行尾 margin。
    expect(footer()!.className).toContain('mt-3');
    expect(footer()!.className).not.toContain('pt-2');
  }, 30000);
});
