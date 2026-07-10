// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore } from '../stores/agentStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { AppConfig } from '../types/provider';
import { useAgentNotifications } from './useAgentNotifications';

const {
  sendNotificationMock,
  requestPermissionMock,
  isPermissionGrantedMock,
  onActionMock,
  listenMock,
  showMainWindowMock,
  sendAgentNotificationMock,
  audioPlayMock,
} = vi.hoisted(() => ({
  sendNotificationMock: vi.fn(),
  requestPermissionMock: vi.fn(async () => 'granted'),
  isPermissionGrantedMock: vi.fn(async () => true),
  onActionMock: vi.fn(async () => ({ unregister: vi.fn(async () => {}) })),
  listenMock: vi.fn(async () => vi.fn()),
  showMainWindowMock: vi.fn(async () => {}),
  sendAgentNotificationMock: vi.fn(async () => {}),
  audioPlayMock: vi.fn(async () => {}),
}));

const notificationInstances: Array<{ title: string; options?: NotificationOptions; onclick: (() => void) | null }> = [];

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: () => isPermissionGrantedMock(),
  requestPermission: () => requestPermissionMock(),
  sendNotification: (payload: unknown) => sendNotificationMock(payload),
  onAction: (callback: unknown) => onActionMock(callback),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, callback: unknown) => listenMock(event, callback),
}));

vi.mock('../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../lib/tauri')>('../lib/tauri');
  return {
    ...actual,
    appApi: {
      ...actual.appApi,
      showMainWindow: showMainWindowMock,
      sendAgentNotification: sendAgentNotificationMock,
    },
  };
});

const baseConfig: AppConfig = {
  providers: [],
  active_provider_id: null,
  agent_defaults: { default_agent_kind: 'claude_code' },
  agent_configs: {
    claude_code: { executable_mode: 'auto', resume_sessions: true },
    codex: { sdk_mode: 'responses' },
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

  it('does not use the JS notification plugin path for desktop agent notifications', async () => {
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
    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(onActionMock).not.toHaveBeenCalled();
  });

  it('opens the app and switches to the session when the backend notification click event arrives', async () => {
    const setActiveSession = vi.fn();
    useSessionStore.setState({ setActiveSession } as Partial<ReturnType<typeof useSessionStore.getState>>);
    render(<Harness />);

    await waitFor(() => {
      expect(listenMock).toHaveBeenCalledWith('agent-notification-clicked', expect.any(Function));
    });

    const clickCallback = listenMock.mock.calls[0]?.[1] as ((event: { payload: unknown }) => void) | undefined;
    clickCallback?.({ payload: { sessionId: 'session-1' } });

    await waitFor(() => {
      expect(showMainWindowMock).toHaveBeenCalled();
      expect(setActiveSession).toHaveBeenCalledWith('session-1');
    });
  });
});
