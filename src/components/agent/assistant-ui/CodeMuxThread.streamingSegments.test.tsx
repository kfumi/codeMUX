// @vitest-environment jsdom
// Regression tests for multi-segment assistant turns (OpenCode emits
// thinking → assistant_message → text → assistant_message repeatedly within
// one turn). Guards the StreamingContent visibility rules in CodeMuxThread.

import { cleanup, render, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore } from '../../../stores/agentStore';
import { useSessionStore } from '../../../stores/sessionStore';
import type { Session } from '../../../types/session';
import { useSettingsStore } from '../../../stores/settingsStore';
import { TooltipProvider } from '../../ui/tooltip';
import { CodeMuxAssistantRuntimeProvider } from './CodeMuxAssistantRuntime';
import { CodeMuxThread } from './CodeMuxThread';

const SESSION = 'session-streaming-segments';

const { sessionHandlers, sendMessageViaDaemonMock } = vi.hoisted(() => {
  const sessionHandlers = new Map<string, (raw: string) => void>();
  return {
    sessionHandlers,
    sendMessageViaDaemonMock: vi.fn<(sessionId: string, prompt: string, payload?: { text: string }, options?: { delivery?: 'steer'; requestId?: string }) => Promise<void>>(),
  };
});

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
    sendMessageViaDaemon: sendMessageViaDaemonMock,
    getTimeline: vi.fn(async () => ({ events: [], hasMore: false })),
    interruptViaDaemon: vi.fn(),
    respondToPermissionViaDaemon: vi.fn(),
    respondToInteractiveViaDaemon: vi.fn(),
    rewindSession: vi.fn(),
    resyncSessionFromNative: vi.fn(),
    updateWorkingPath: vi.fn(() => Promise.resolve()),
    touchSession: vi.fn(() => Promise.resolve()),
    updateSessionTitle: vi.fn(() => Promise.resolve()),
    listSessions: vi.fn(() => Promise.resolve([])),
    listArchivedSessions: vi.fn(() => Promise.resolve([])),
    listProjects: vi.fn(() => Promise.resolve([])),
    ensureClient: vi.fn(),
    enrichAttachments: vi.fn(),
    loadLatestTokenUsage: vi.fn(() => Promise.resolve(null)),
    loadSessionSubagents: vi.fn(() => Promise.resolve({ subagents: [], timelines: {} })),
    ensureAgentSession: vi.fn(() => Promise.resolve()),
    getAgentSessionInfo: vi.fn(() => Promise.resolve({ agentSessionId: null, messagePath: null })),
    isSessionTurnActive: vi.fn(() => Promise.resolve(false)),
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
      streamingThinking: {}, streamingText: {}, streamingVersion: {},
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

    send({ type: 'assistant_message', event_id: 'em1', content: [{ type: 'thinking', thinking: 'SEG1 thinking' }], provider_message_id: 'msg-1' });
    await flush();
    expectLiveReasoning(container, false);

    // Segment 2: fresh thinking stream — must stay visible even though segment
    // 1 already committed (OpenCode multi-segment turn).
    send({ type: 'content_started', event_id: 'e3', index: 1, content_kind: 'reasoning' });
    send({ type: 'reasoning_delta', event_id: 'e4', index: 1, text: 'SEG2 brand new thinking' });
    await flush();
    expectLiveReasoning(container, true);
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
    // Both committed reasoning bubbles exist as collapsed triggers.
    const triggers = container.querySelectorAll('[data-slot="reasoning-trigger"]');
    expect(triggers.length).toBe(2);
  }, 30000);
});
