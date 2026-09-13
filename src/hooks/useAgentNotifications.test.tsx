// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore } from '../stores/agentStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSubagentStore } from '../stores/subagentStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useDaemonConnectionStore } from '../stores/daemonConnectionStore';
import type { AppConfig } from '../types/provider';
import { useAgentNotifications } from './useAgentNotifications';

const bridgeState = vi.hoisted(() => ({ present: true }));

const {
  sendAgentNotificationMock,
  showMainWindowMock,
  audioPlayMock,
  onAgentNotificationClickedBridgeMock,
} = vi.hoisted(() => ({
  sendAgentNotificationMock: vi.fn(async () => {}),
  showMainWindowMock: vi.fn(async () => {}),
  audioPlayMock: vi.fn(async () => {}),
  onAgentNotificationClickedBridgeMock: vi.fn(),
}));

vi.mock('../lib/desktop-bridge', async () => {
  const actual = await vi.importActual<typeof import('../lib/desktop-bridge')>('../lib/desktop-bridge');
  return {
    ...actual,
    get desktopBridge() {
      return bridgeState.present ? { onAgentNotificationClicked: onAgentNotificationClickedBridgeMock } : undefined;
    },
  };
});

vi.mock('../lib/facades/shell-facade', () => ({
  shellFacade: {
    sendAgentNotification: sendAgentNotificationMock,
    showMainWindow: showMainWindowMock,
  },
}));

const notificationInstances: Array<{ title: string; options?: NotificationOptions; onclick: (() => void) | null }> = [];

const baseConfig: AppConfig = {
  providers: [],
  active_provider_id: null,
  agent_defaults: { default_agent_kind: 'claude_code' },
  agent_configs: {
    claude_code: { executable_mode: 'auto', resume_sessions: true },
    gemini_cli: {},
    opencode: {},
  },
  compact_ai_output: false,
  default_open_target: 'file_explorer',
  notifications: {
    system_enabled: true,
    sound_enabled: false,
    sound: 'ding',
  },
  theme: 'System',
};

function Harness() {
  useAgentNotifications();
  return null;
}

describe('useAgentNotifications', () => {
  afterEach(() => {
    cleanup();
    useDaemonConnectionStore.setState({ hostForm: 'desktop' });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => false,
    });
    notificationInstances.length = 0;
    vi.stubGlobal('Notification', class {
      static permission = 'granted';
      static requestPermission = vi.fn(async () => 'granted');
      onclick: (() => void) | null = null;

      constructor(public title: string, public options?: NotificationOptions) {
        notificationInstances.push(this);
      }
    });
    vi.stubGlobal('Audio', class {
      volume = 0;
      play = audioPlayMock;
    });
    useSettingsStore.setState({ config: structuredClone(baseConfig), isLoading: false, error: null });
    useSessionStore.setState({
      sessions: [{
        id: 'session-1',
        title: '重构设置页',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        mode: 'agent',
        project_id: null,
        provider_id: null,
        model: null,
        reasoning_effort: null,
        is_archived: false,
        is_pinned: false,
        agent_kind: 'claude_code',
        permission_config: null,
        plan_mode: null,
      }],
      activeSessionId: null,
      unreadSessions: new Set<string>(),
    });
    useAgentStore.setState({
      events: {},
      eventTimestamps: {},
    });
    useSubagentStore.setState({ sessions: {} });
  });

  it('background subagents running: holds the terminal notification until the summary turn completes', async () => {
    render(<Harness />);

    useSubagentStore.setState({
      sessions: {
        'session-1': {
          order: ['toolu_1'],
          descriptors: {
            toolu_1: {
              subagentId: 'toolu_1',
              provider: 'claude',
              title: 'Explore',
              description: null,
              status: 'running',
              toolCallId: 'toolu_1',
              subtitle: null,
              updatedAt: 0,
            },
          },
          events: {},
          seenEventIds: {},
        },
      },
    });
    useAgentStore.setState({
      events: {
        'session-1': [{
          kind: 'result',
          data: {
            type: 'result',
            subtype: 'success',
            is_error: false,
            uuid: 'result-1',
            session_id: 'session-1',
            duration_ms: 1000,
            duration_api_ms: 800,
            num_turns: 1,
            result: '',
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }],
      },
      eventTimestamps: { 'session-1': [Date.now()] },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    // The continuation turn completed, but children are still running — no
    // "task completed" ping yet.
    expect(sendAgentNotificationMock).not.toHaveBeenCalled();

    // All children reach terminal state. The parent is about to be woken to
    // summarize, so the pre-completion result stays held.
    const session = useSubagentStore.getState().sessions['session-1'];
    useSubagentStore.setState({
      sessions: {
        'session-1': {
          ...session!,
          descriptors: {
            toolu_1: { ...session!.descriptors['toolu_1']!, status: 'completed' },
          },
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sendAgentNotificationMock).not.toHaveBeenCalled();

    // The summary turn's own terminal event arrives after the subagents
    // finished — that is the real end of the flow.
    useAgentStore.setState({
      events: {
        'session-1': [
          {
            kind: 'result',
            data: {
              type: 'result',
              subtype: 'success',
              is_error: false,
              uuid: 'result-1',
              session_id: 'session-1',
              duration_ms: 1000,
              duration_api_ms: 800,
              num_turns: 1,
              result: '',
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
          {
            kind: 'result',
            data: {
              type: 'result',
              subtype: 'success',
              is_error: false,
              uuid: 'result-2',
              session_id: 'session-1',
              duration_ms: 4000,
              duration_api_ms: 3200,
              num_turns: 2,
              result: '汇总完成',
              usage: { input_tokens: 2, output_tokens: 2 },
            },
          },
        ],
      },
      eventTimestamps: { 'session-1': [Date.now() - 60_000, Date.now()] },
    });

    await waitFor(() => {
      expect(sendAgentNotificationMock).toHaveBeenCalledTimes(1);
    });
    expect(sendAgentNotificationMock).toHaveBeenCalledWith({
      title: '任务已完成',
      body: '重构设置页',
      sessionId: 'session-1',
    });
  });

  it('sends a native agent notification for a new waiting-input event while inactive', async () => {
    render(<Harness />);

    useAgentStore.setState({
      events: {
        'session-1': [{
          kind: 'ask_user_question',
          data: {
            tool_use_id: 'question-1',
            questions: [{
              question: '是否继续？',
              options: [{ label: '继续' }, { label: '停止' }],
            }],
          },
        }],
      },
      eventTimestamps: { 'session-1': [1] },
    });

    await waitFor(() => {
      expect(sendAgentNotificationMock).toHaveBeenCalledWith({
        title: '需要你的回复',
        body: '重构设置页：是否继续？',
        sessionId: 'session-1',
      });
    });
  });

  it('sends a native agent notification for a permission approval while inactive', async () => {
    render(<Harness />);

    useAgentStore.setState({
      events: {
        'session-1': [{
          kind: 'permission',
          data: {
            request_id: 'permission-1',
            permission_type: 'read',
            description: '读取文件',
            metadata: { patterns: ['D:\\workspace\\secret.txt'] },
          },
        }],
      },
      eventTimestamps: { 'session-1': [Date.now()] },
    });

    await waitFor(() => {
      expect(sendAgentNotificationMock).toHaveBeenCalledWith({
        title: '需要你的确认',
        body: '重构设置页：读取文件 · D:\\workspace\\secret.txt',
        sessionId: 'session-1',
      });
    });
  });

  it('does not play a sound for waiting-input notifications', async () => {
    useSettingsStore.setState({
      config: {
        ...structuredClone(baseConfig),
        notifications: {
          system_enabled: true,
          sound_enabled: true,
          sound: 'ding',
        },
      },
      isLoading: false,
      error: null,
    });
    render(<Harness />);

    useAgentStore.setState({
      events: {
        'session-1': [{
          kind: 'ask_user_question',
          data: {
            tool_use_id: 'question-1',
            questions: [{
              question: '是否继续？',
              options: [{ label: '继续' }, { label: '停止' }],
            }],
          },
        }],
      },
      eventTimestamps: { 'session-1': [Date.now()] },
    });

    await waitFor(() => {
      expect(sendAgentNotificationMock).toHaveBeenCalledTimes(1);
    });
    expect(audioPlayMock).not.toHaveBeenCalled();
  });

  it('does not send duplicate notifications for the same event', async () => {
    render(<Harness />);

    useAgentStore.setState({
      events: { 'session-1': [{ kind: 'done' }] },
      eventTimestamps: { 'session-1': [1] },
    });

    await waitFor(() => {
      expect(sendAgentNotificationMock).toHaveBeenCalledTimes(1);
    });

    const countAfterFirst = sendAgentNotificationMock.mock.calls.length;

    // Trigger the same event key again by adding a new event to the same session
    useAgentStore.setState({
      events: { 'session-1': [{ kind: 'done' }, { kind: 'user', data: { content: 'bump' } }] },
      eventTimestamps: { 'session-1': [1, 2] },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    // No new notification for the already-dispatched done event
    expect(sendAgentNotificationMock).toHaveBeenCalledTimes(countAfterFirst);
  });

  it('does not notify for historical events loaded while the app is focused after losing focus later', async () => {
    let focused = true;
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => focused,
    });
    useSettingsStore.setState({
      config: {
        ...structuredClone(baseConfig),
        notifications: {
          system_enabled: true,
          sound_enabled: true,
          sound: 'ding',
        },
      },
      isLoading: false,
      error: null,
    });
    render(<Harness />);

    useAgentStore.setState({
      events: { 'session-1': [{ kind: 'done' }] },
      eventTimestamps: { 'session-1': [1] },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sendAgentNotificationMock).not.toHaveBeenCalled();
    expect(audioPlayMock).not.toHaveBeenCalled();

    focused = false;
    window.dispatchEvent(new Event('blur'));

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sendAgentNotificationMock).not.toHaveBeenCalled();
    expect(audioPlayMock).not.toHaveBeenCalled();
  });

  it('plays the completion sound for a live task completion while focused', async () => {
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => true,
    });
    useSettingsStore.setState({
      config: {
        ...structuredClone(baseConfig),
        notifications: {
          system_enabled: false,
          sound_enabled: true,
          sound: 'ding',
        },
      },
      isLoading: false,
      error: null,
    });
    render(<Harness />);

    useAgentStore.setState({
      events: {
        'session-1': [
          { kind: 'user', data: { content: '开始任务' } },
          { kind: 'done' },
        ],
      },
      eventTimestamps: { 'session-1': [Date.now(), Date.now()] },
    });

    await waitFor(() => {
      expect(audioPlayMock).toHaveBeenCalledTimes(1);
    });
    expect(sendAgentNotificationMock).not.toHaveBeenCalled();
  });

  it('does not replay the completion sound when the session history is rehydrated with different timestamps', async () => {
    // 复现"切走再切回会话后提示音重播"：实时路径由渲染层 Date.now() 打戳，
    // 水合路径改用持久化 timestamp。同一回合（同序数同内容）不得二次播报。
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => true,
    });
    useSettingsStore.setState({
      config: {
        ...structuredClone(baseConfig),
        notifications: {
          system_enabled: false,
          sound_enabled: true,
          sound: 'ding',
        },
      },
      isLoading: false,
      error: null,
    });
    render(<Harness />);

    useAgentStore.setState({
      events: {
        'session-1': [
          { kind: 'user', data: { content: '开始任务' } },
          { kind: 'done' },
        ],
      },
      eventTimestamps: { 'session-1': [Date.now(), Date.now()] },
    });

    await waitFor(() => {
      expect(audioPlayMock).toHaveBeenCalledTimes(1);
    });

    // 切回会话触发 loadSessionMessages：同一条时间线，时间戳换成持久化值。
    useAgentStore.setState({
      events: {
        'session-1': [
          { kind: 'user', data: { content: '开始任务' } },
          { kind: 'done' },
        ],
      },
      eventTimestamps: { 'session-1': [1757663037000, 1757663037500] },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(audioPlayMock).toHaveBeenCalledTimes(1);
  });

  it('allows a later task completion in the same session to notify again', async () => {
    render(<Harness />);

    useAgentStore.setState({
      events: { 'session-1': [{ kind: 'done' }] },
      eventTimestamps: { 'session-1': [1] },
    });

    await waitFor(() => {
      expect(sendAgentNotificationMock).toHaveBeenCalledTimes(1);
    });

    useAgentStore.setState({
      events: {
        'session-1': [
          { kind: 'done' },
          { kind: 'user', data: { content: '下一轮' } },
          { kind: 'done' },
        ],
      },
      eventTimestamps: { 'session-1': [1, 2, 3] },
    });

    await waitFor(() => {
      expect(sendAgentNotificationMock).toHaveBeenCalledTimes(2);
    });
  });

  it('coalesces multiple terminal events from the same turn into one notification', async () => {
    render(<Harness />);

    useAgentStore.setState({
      events: {
        'session-1': [
          { kind: 'user', data: { content: '你是什么模型' } },
          { kind: 'done' },
        ],
      },
      eventTimestamps: { 'session-1': [1, 2] },
    });

    await waitFor(() => {
      expect(sendAgentNotificationMock).toHaveBeenCalledTimes(1);
    });

    useAgentStore.setState({
      events: {
        'session-1': [
          { kind: 'user', data: { content: '你是什么模型' } },
          { kind: 'done' },
          {
            kind: 'result',
            data: {
              type: 'result',
              subtype: 'success',
              is_error: false,
              uuid: 'result-1',
              session_id: 'session-1',
              duration_ms: 1000,
              duration_api_ms: 800,
              num_turns: 1,
              result: '',
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
          { kind: 'done' },
        ],
      },
      eventTimestamps: { 'session-1': [1, 2, 3, 4] },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sendAgentNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('notifies again when a rewound turn completes at the same event index', async () => {
    render(<Harness />);

    useAgentStore.setState({
      events: {
        'session-1': [
          { kind: 'user', data: { content: 'old prompt' } },
          { kind: 'done' },
        ],
      },
      eventTimestamps: { 'session-1': [1000, 2000] },
    });

    await waitFor(() => {
      expect(sendAgentNotificationMock).toHaveBeenCalledTimes(1);
    });

    useAgentStore.setState({
      events: {
        'session-1': [
          { kind: 'user', data: { content: 'edited prompt' } },
          { kind: 'done' },
        ],
      },
      eventTimestamps: { 'session-1': [3000, 4000] },
    });

    await waitFor(() => {
      expect(sendAgentNotificationMock).toHaveBeenCalledTimes(2);
    });
  });

  it('desktop agent notifications dispatch only through the shell bridge, never the renderer Notification API', async () => {
    render(<Harness />);

    useAgentStore.setState({
      events: { 'session-1': [{ kind: 'done' }] },
      eventTimestamps: { 'session-1': [1] },
    });

    await waitFor(() => {
      expect(sendAgentNotificationMock).toHaveBeenCalledWith({
        title: '任务已完成',
        body: '重构设置页',
        sessionId: 'session-1',
      });
    });
    // 渲染层 Notification 构造器不得被使用(原生通知归属 main 进程,工单 09)。
    expect(notificationInstances).toHaveLength(0);
  });

  it('browser hosts fall back to the Web Notification API instead of the shell bridge', async () => {
    // 浏览器形态:没有壳也就没有原生通知,改走 Web Notification(工单 03)。
    useDaemonConnectionStore.setState({ hostForm: 'browser' });
    render(<Harness />);

    useAgentStore.setState({
      events: { 'session-1': [{ kind: 'done' }] },
      eventTimestamps: { 'session-1': [1] },
    });

    await waitFor(() => {
      expect(notificationInstances).toHaveLength(1);
    });
    expect(notificationInstances[0].title).toBe('任务已完成');
    expect(notificationInstances[0].options?.tag).toBe('codemux:session-1');
    expect(sendAgentNotificationMock).not.toHaveBeenCalled();
  });

  it('browser hosts stay silent while the notification permission is unset', async () => {
    useDaemonConnectionStore.setState({ hostForm: 'browser' });
    vi.stubGlobal('Notification', class {
      static permission = 'default';
      static requestPermission = vi.fn(async () => 'default');
      onclick: (() => void) | null = null;
      constructor() {
        notificationInstances.push({ title: 'unexpected', onclick: null });
      }
    });
    render(<Harness />);

    useAgentStore.setState({
      events: { 'session-1': [{ kind: 'done' }] },
      eventTimestamps: { 'session-1': [1] },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(notificationInstances).toHaveLength(0);
    expect(sendAgentNotificationMock).not.toHaveBeenCalled();
  });

  it('subscribes notification clicks via the Electron preload bridge (工单 09 终态)', async () => {
    const setActiveSession = vi.fn();
    useSessionStore.setState({ setActiveSession } as Partial<ReturnType<typeof useSessionStore.getState>>);
    let clickCallback: ((payload: unknown) => void) | null = null;
    const unsubscribe = vi.fn(() => {
      clickCallback = null;
    });
    onAgentNotificationClickedBridgeMock.mockImplementation((callback: (payload: unknown) => void) => {
      clickCallback = callback;
      return unsubscribe;
    });

    render(<Harness />);

    await waitFor(() => {
      expect(onAgentNotificationClickedBridgeMock).toHaveBeenCalledWith(expect.any(Function));
    });

    clickCallback?.({ sessionId: 'session-1' });

    await waitFor(() => {
      expect(showMainWindowMock).toHaveBeenCalled();
      expect(setActiveSession).toHaveBeenCalledWith('session-1');
    });

    cleanup();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('desktop bridge 缺失时跳过点击订阅,不抛错也不唤起主窗口', async () => {
    const setActiveSession = vi.fn();
    useSessionStore.setState({ setActiveSession } as Partial<ReturnType<typeof useSessionStore.getState>>);
    onAgentNotificationClickedBridgeMock.mockClear();
    bridgeState.present = false;

    try {
      // 桥缺失:订阅跳过(无原生通知可点),其余通知逻辑照常运行。
      render(<Harness />);
      expect(onAgentNotificationClickedBridgeMock).not.toHaveBeenCalled();
    } finally {
      bridgeState.present = true;
    }
  });
});
