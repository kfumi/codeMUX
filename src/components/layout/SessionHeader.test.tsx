// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../types/project';
import type { Session } from '../../types/session';
import { useProjectStore } from '../../stores/projectStore';
import { useSessionStore } from '../../stores/sessionStore';
import { SessionHeader } from './SessionHeader';

const mocks = vi.hoisted(() => ({
  openInExplorer: vi.fn(),
  getSessionInfo: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: Record<string, unknown>) => {
    if (command === 'open_in_explorer') return mocks.openInExplorer(args);
    return Promise.resolve();
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../../lib/tauri', () => ({
  agentApi: {
    getSessionInfo: mocks.getSessionInfo,
  },
  sessionApi: {
    archive: vi.fn().mockResolvedValue(undefined),
    setPinned: vi.fn().mockResolvedValue(undefined),
    updateTitle: vi.fn().mockResolvedValue(undefined),
  },
}));

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 'session-1',
    title: 'Header Session',
    agent_kind: 'codex',
    provider_id: null,
    model: null,
    reasoning_effort: null,
    mode: 'agent',
    permission_config: null,
    plan_mode: null,
    project_id: 'project-1',
    is_archived: false,
    is_pinned: false,
    created_at: '2026-06-20T00:00:00.000Z',
    updated_at: '2026-06-20T00:00:00.000Z',
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project>): Project {
  return {
    id: 'project-1',
    name: 'codeMUX',
    path: 'D:\\project\\ai-code\\codeMUX',
    created_at: '2026-06-20T00:00:00.000Z',
    updated_at: '2026-06-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('SessionHeader', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
    useProjectStore.setState({
      projects: [makeProject({})],
      activeProjectId: 'project-1',
      isLoading: false,
      error: null,
      collapsedProjects: new Set<string>(),
    });
    useSessionStore.setState({
      sessions: [makeSession({})],
      archivedSessions: [],
      activeSessionId: 'session-1',
      isLoading: false,
      isArchivedLoading: false,
      error: null,
      unreadSessions: new Set<string>(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  function openMenu() {
    render(<SessionHeader sessionId="session-1" />);
    fireEvent.pointerDown(screen.getByLabelText('任务菜单'));
  }

  it('renders the expanded session menu actions', () => {
    openMenu();

    expect(screen.getByText('置顶任务')).toBeTruthy();
    expect(screen.getByText('重命名任务')).toBeTruthy();
    expect(screen.getByText('归档任务')).toBeTruthy();
    expect(screen.getByText('标记为未读')).toBeTruthy();
    expect(screen.getByText('在资源管理器中打开')).toBeTruthy();
    expect(screen.getByText('复制路径')).toBeTruthy();
    expect(screen.getByText('复制任务路径')).toBeTruthy();
    expect(screen.getByText('复制会话ID')).toBeTruthy();
  });

  it('handles pin, unread, project path, task path, agent id, and archive actions', async () => {
    mocks.getSessionInfo.mockResolvedValue({
      agentSessionId: 'codex-session-1',
      messagePath: 'C:\\Users\\me\\.codex\\sessions\\session.jsonl',
    });

    openMenu();

    fireEvent.click(screen.getByText('置顶任务'));
    await waitFor(() => expect(useSessionStore.getState().sessions[0].is_pinned).toBe(true));

    fireEvent.pointerDown(screen.getByLabelText('任务菜单'));
    fireEvent.click(screen.getByText('标记为未读'));
    expect(useSessionStore.getState().unreadSessions.has('session-1')).toBe(false);

    fireEvent.pointerDown(screen.getByLabelText('任务菜单'));
    fireEvent.click(screen.getByText('在资源管理器中打开'));
    expect(mocks.openInExplorer).toHaveBeenCalledWith({ path: 'D:\\project\\ai-code\\codeMUX' });

    fireEvent.pointerDown(screen.getByLabelText('任务菜单'));
    fireEvent.click(screen.getByText('复制路径'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('D:\\project\\ai-code\\codeMUX');

    fireEvent.pointerDown(screen.getByLabelText('任务菜单'));
    fireEvent.click(screen.getByText('复制任务路径'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('C:\\Users\\me\\.codex\\sessions\\session.jsonl'));

    fireEvent.pointerDown(screen.getByLabelText('任务菜单'));
    fireEvent.click(screen.getByText('复制会话ID'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('codex-session-1'));

    fireEvent.pointerDown(screen.getByLabelText('任务菜单'));
    fireEvent.click(screen.getByText('归档任务'));
    await waitFor(() => expect(useSessionStore.getState().archivedSessions[0].id).toBe('session-1'));
  });

  it('shows feedback instead of copying when the agent message path is missing', async () => {
    mocks.getSessionInfo.mockResolvedValue({
      agentSessionId: 'codex-session-1',
      messagePath: null,
    });

    openMenu();
    fireEvent.click(screen.getByText('复制任务路径'));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('未找到任务路径'));
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
});
