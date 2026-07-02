// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore } from '../stores/agentStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { AppConfig } from '../types/provider';
import { useAgentNotifications } from './useAgentNotifications';

const { sendNotificationMock, requestPermissionMock, isPermissionGrantedMock, showMainWindowMock } = vi.hoisted(() => ({
  sendNotificationMock: vi.fn(),
  requestPermissionMock: vi.fn(async () => 'granted'),
  isPermissionGrantedMock: vi.fn(async () => true),
  showMainWindowMock: vi.fn(async () => {}),
}));

const notificationInstances: Array<{ title: string; options?: NotificationOptions; onclick: (() => void) | null }> = [];

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: () => isPermissionGrantedMock(),
  requestPermission: () => requestPermissionMock(),
  sendNotification: (payload: unknown) => sendNotificationMock(payload),
}));

vi.mock('../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../lib/tauri')>('../lib/tauri');
  return {
    ...actual,
    appApi: {
      ...actual.appApi,
      showMainWindow: showMainWindowMock,
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
  notifications: {
    system_enabled: true,
    sound_enabled: false,
    sound: 'soft',
  },
  theme: 'System',
};

function Harness() {
  useAgentNotifications();
  return null;
}

describe('useAgentNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => false,
    });
    notificationInstances.length = 0;
    vi.stubGlobal('Notification', class {
      static permission = 'granted';
      onclick: (() => void) | null = null;

      constructor(public title: string, public options?: NotificationOptions) {
        notificationInstances.push(this);
      }
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

  it('sends a notification for a new waiting-input event while inactive', async () => {
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
      expect(notificationInstances[0]).toMatchObject({
        title: '需要你的回复',
        options: { body: '重构设置页：是否继续？' },
      });
    });
  });

  it('does not send duplicate notifications for the same event', async () => {
    render(<Harness />);

    useAgentStore.setState({
      events: { 'session-1': [{ kind: 'done' }] },
      eventTimestamps: { 'session-1': [1] },
    });

    await waitFor(() => {
      expect(notificationInstances.length).toBeGreaterThanOrEqual(1);
    });

    const countAfterFirst = notificationInstances.length;

    // Trigger the same event key again by adding a new event to the same session
    useAgentStore.setState({
      events: { 'session-1': [{ kind: 'done' }, { kind: 'user', data: { content: 'bump' } }] },
      eventTimestamps: { 'session-1': [1, 2] },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    // No new notification for the already-dispatched done event
    expect(notificationInstances).toHaveLength(countAfterFirst);
  });

  it('opens the app and switches to the session when the notification is clicked', async () => {
    const setActiveSession = vi.fn();
    useSessionStore.setState({ setActiveSession } as Partial<ReturnType<typeof useSessionStore.getState>>);
    render(<Harness />);

    useAgentStore.setState({
      events: { 'session-1': [{ kind: 'done' }] },
      eventTimestamps: { 'session-1': [1] },
    });

    await waitFor(() => {
      expect(notificationInstances).toHaveLength(1);
    });

    notificationInstances[0].onclick?.();

    await waitFor(() => {
      expect(showMainWindowMock).toHaveBeenCalled();
      expect(setActiveSession).toHaveBeenCalledWith('session-1');
    });
  });
});
