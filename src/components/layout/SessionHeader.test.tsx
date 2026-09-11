// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../types/project';
import type { Session } from '../../types/session';
import { useProjectStore } from '../../stores/projectStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useAgentStore } from '../../stores/agentStore';
import { SessionHeader } from './SessionHeader';

const mocks = vi.hoisted(() => ({
  openInExplorer: vi.fn(),
  getSessionInfo: vi.fn(),
  resyncSessionFromNative: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastLoading: vi.fn(() => 'toast-id'),
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
    loading: mocks.toastLoading,
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../../lib/facades/daemon-facade', () => ({
  daemonFacade: {
    patchSessionViaDaemon: vi.fn().mockResolvedValue(undefined),
    archiveViaDaemon: vi.fn().mockResolvedValue(undefined),
    unarchiveViaDaemon: vi.fn().mockResolvedValue(undefined),
    updateWorkingPath: vi.fn().mockResolvedValue(undefined),
    touchSession: vi.fn().mockResolvedValue(undefined),
    getSessionInfo: mocks.getSessionInfo,
  },
}));

vi.mock('../../lib/tauri', () => ({
  agentApi: {},
  openInExplorer: mocks.openInExplorer,
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
    mocks.resyncSessionFromNative.mockResolvedValue(3);
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
    useAgentStore.setState({
      sessionWorkingPaths: {},
      events: {},
      isRunning: {},
      resyncSessionFromNative: mocks.resyncSessionFromNative,
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
    expect(screen.getByText('从 CLI 同步历史')).toBeTruthy();
    expect(screen.getByText('在资源管理器中打开')).toBeTruthy();
    expect(screen.getByText('复制路径')).toBeTruthy();
    expect(screen.getByText('复制任务路径')).toBeTruthy();
    expect(screen.getByText('复制原生会话ID')).toBeTruthy();
  });

  it('syncs history from CLI through the session menu', async () => {
    openMenu();
    fireEvent.click(screen.getByText('从 CLI 同步历史'));

    await waitFor(() => expect(mocks.resyncSessionFromNative).toHaveBeenCalledWith('session-1'));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('已从 CLI 同步 3 条历史消息', { id: 'toast-id' });
  });

  it('hides CLI sync for read-only imported sessions', () => {
    useSessionStore.setState({
      sessions: [makeSession({ origin: 'imported', is_read_only: true })],
    });

    openMenu();

    expect(screen.queryByText('从 CLI 同步历史')).toBeNull();
  });

  it('shows the worktree path chip when the session cwd differs from the project root', () => {
    useAgentStore.setState({
      sessionWorkingPaths: {
        'session-1': 'C:\\Users\\me\\.codemux\\worktrees\\abc123\\shaggy-baboon',
      },
    });

    render(<SessionHeader sessionId="session-1" />);

    expect(screen.getByText('shaggy-baboon')).toBeTruthy();
  });

  it('opens the remembered worktree path from the session menu', async () => {
    useAgentStore.setState({
      sessionWorkingPaths: {
        'session-1': 'C:\\Users\\me\\.codemux\\worktrees\\abc123\\shaggy-baboon',
      },
    });

    openMenu();
    fireEvent.click(screen.getByText('在资源管理器中打开'));

    expect(mocks.openInExplorer).toHaveBeenCalledWith(
      'C:\\Users\\me\\.codemux\\worktrees\\abc123\\shaggy-baboon',
    );
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
    expect(mocks.openInExplorer).toHaveBeenCalledWith('D:\\project\\ai-code\\codeMUX');

    fireEvent.pointerDown(screen.getByLabelText('任务菜单'));
    fireEvent.click(screen.getByText('复制路径'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('D:\\project\\ai-code\\codeMUX');

    fireEvent.pointerDown(screen.getByLabelText('任务菜单'));
    fireEvent.click(screen.getByText('复制任务路径'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('C:\\Users\\me\\.codex\\sessions\\session.jsonl'));

    fireEvent.pointerDown(screen.getByLabelText('任务菜单'));
    fireEvent.click(screen.getByText('复制原生会话ID'));
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

  it('hides the task path action for OpenCode sessions', () => {
    useSessionStore.setState({ sessions: [makeSession({ agent_kind: 'opencode' })] });

    openMenu();

    expect(screen.queryByText('复制任务路径')).toBeNull();
    expect(screen.getByText('复制原生会话ID')).toBeTruthy();
  });

  it('shows an error toast instead of failing silently when agent info lookup rejects', async () => {
    mocks.getSessionInfo.mockRejectedValue(new Error('Daemon request failed: 400'));

    openMenu();
    fireEvent.click(screen.getByText('复制原生会话ID'));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('复制失败：Daemon request failed: 400'));
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('closes the rename dialog without leaving a blocking overlay', async () => {
    openMenu();
    fireEvent.click(screen.getByText('重命名任务'));

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

    fireEvent.click(screen.getByText('取消'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const openLayers = Array.from(document.body.querySelectorAll('[data-state="open"]'));
    expect(openLayers).toHaveLength(0);
    expect(document.body.style.pointerEvents).not.toBe('none');
  });
});
