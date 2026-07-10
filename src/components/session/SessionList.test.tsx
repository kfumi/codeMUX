// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../types/project';
import type { Session } from '../../types/session';
import { TooltipProvider } from '../ui/tooltip';
import { useProjectStore } from '../../stores/projectStore';
import { useSessionStore } from '../../stores/sessionStore';
import { SessionList } from './SessionList';

vi.mock('../../lib/tauri', () => ({
  agentApi: {
    deleteClaudeSessionFiles: vi.fn(),
    deleteCodexSessionFiles: vi.fn(),
    resetSession: vi.fn(),
    shutdown: vi.fn(),
  },
  projectApi: {
    create: vi.fn(),
    delete: vi.fn(),
    getAll: vi.fn().mockResolvedValue([]),
    rename: vi.fn(),
  },
  sessionApi: {
    archive: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    getAll: vi.fn().mockResolvedValue([]),
    getArchived: vi.fn().mockResolvedValue([]),
    setPinned: vi.fn(),
    touch: vi.fn(),
    unarchive: vi.fn(),
    updateTitle: vi.fn(),
  },
}));

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 'session-active',
    title: 'Active Session',
    agent_kind: 'codex',
    provider_id: null,
    model: null,
    reasoning_effort: null,
    mode: 'agent',
    project_id: null,
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

describe('SessionList', () => {
  const defaultProps = {
    onNewSessionInProject: vi.fn(),
    onAddProject: vi.fn(),
    onNavigateHome: vi.fn(),
  };

  beforeEach(() => {
    useSessionStore.setState({
      sessions: [makeSession({ id: 'session-active', title: 'Active Session' })],
      archivedSessions: [
        makeSession({
          id: 'session-archived',
          title: 'Archived Session',
          is_archived: true,
        }),
      ],
      activeSessionId: null,
      isLoading: false,
      isArchivedLoading: false,
      error: null,
      unreadSessions: new Set<string>(),
    });
    useProjectStore.setState({
      projects: [],
      activeProjectId: null,
      isLoading: false,
      error: null,
      collapsedProjects: new Set<string>(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  function renderSessionList() {
    return render(
      <TooltipProvider>
        <SessionList {...defaultProps} />
      </TooltipProvider>,
    );
  }

  it('does not render archived sessions in the left sidebar history', () => {
    renderSessionList();

    expect(screen.getByText('Active Session')).toBeTruthy();
    expect(screen.queryByText('Archived Session')).toBeNull();
  });

  it('moves pinned sessions into the pinned section without duplicating them', () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'project-1', name: 'codeMUX' })],
      activeProjectId: null,
      isLoading: false,
      error: null,
      collapsedProjects: new Set<string>(),
    });
    useSessionStore.setState({
      sessions: [
        makeSession({ id: 'pinned-project', title: 'Pinned Project Session', project_id: 'project-1', is_pinned: true }),
        makeSession({ id: 'regular-project', title: 'Regular Project Session', project_id: 'project-1' }),
        makeSession({ id: 'pinned-chat', title: 'Pinned Chat', is_pinned: true }),
        makeSession({ id: 'regular-chat', title: 'Regular Chat' }),
      ],
      archivedSessions: [],
      activeSessionId: null,
      isLoading: false,
      isArchivedLoading: false,
      error: null,
      unreadSessions: new Set<string>(),
    });

    renderSessionList();

    expect(screen.getByText('置顶')).toBeTruthy();
    expect(screen.getAllByText('Pinned Project Session')).toHaveLength(1);
    expect(screen.getAllByText('Pinned Chat')).toHaveLength(1);
    expect(screen.getByText('Regular Project Session')).toBeTruthy();
    expect(screen.getByText('Regular Chat')).toBeTruthy();
  });

  it('collapses and expands the pinned section from its header', () => {
    useSessionStore.setState({
      sessions: [
        makeSession({ id: 'pinned-project', title: 'Pinned Project Session', is_pinned: true }),
        makeSession({ id: 'pinned-chat', title: 'Pinned Chat', is_pinned: true }),
      ],
      archivedSessions: [],
      activeSessionId: null,
      isLoading: false,
      isArchivedLoading: false,
      error: null,
      unreadSessions: new Set<string>(),
    });

    renderSessionList();

    expect(screen.getByText('Pinned Project Session')).toBeTruthy();
    expect(screen.getByText('Pinned Chat')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'toggle-pinned-section' }));

    expect(screen.queryByText('Pinned Project Session')).toBeNull();
    expect(screen.queryByText('Pinned Chat')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'toggle-pinned-section' }));

    expect(screen.getByText('Pinned Project Session')).toBeTruthy();
    expect(screen.getByText('Pinned Chat')).toBeTruthy();
  });

  it('collapses and expands the entire projects section from its header', () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'project-1', name: 'codeMUX' })],
      activeProjectId: null,
      isLoading: false,
      error: null,
      collapsedProjects: new Set<string>(),
    });
    useSessionStore.setState({
      sessions: [makeSession({ id: 'session-in-project', title: 'Project Session', project_id: 'project-1' })],
      archivedSessions: [],
      activeSessionId: null,
      isLoading: false,
      isArchivedLoading: false,
      error: null,
      unreadSessions: new Set<string>(),
    });

    renderSessionList();

    expect(screen.getByText('codeMUX')).toBeTruthy();
    expect(screen.getByText('Project Session')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'toggle-projects-section' }));

    expect(screen.queryByText('codeMUX')).toBeNull();
    expect(screen.queryByText('Project Session')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'toggle-projects-section' }));

    expect(screen.getByText('codeMUX')).toBeTruthy();
    expect(screen.getByText('Project Session')).toBeTruthy();
  });

  it('lazily expands project session history in fixed increments', () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'project-1', name: 'codeMUX' })],
      activeProjectId: null,
      isLoading: false,
      error: null,
      collapsedProjects: new Set<string>(),
    });
    useSessionStore.setState({
      sessions: Array.from({ length: 16 }, (_, index) => makeSession({
        id: `project-session-${index + 1}`,
        title: `Project Session ${String(index + 1).padStart(2, '0')}`,
        project_id: 'project-1',
      })),
      archivedSessions: [],
      activeSessionId: null,
      isLoading: false,
      isArchivedLoading: false,
      error: null,
      unreadSessions: new Set<string>(),
    });

    renderSessionList();

    expect(screen.getByText('Project Session 01')).toBeTruthy();
    expect(screen.getByText('Project Session 05')).toBeTruthy();
    expect(screen.queryByText('Project Session 06')).toBeNull();
    expect(screen.getByRole('button', { name: '展开显示项目 codeMUX 的更多对话' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '折叠显示项目 codeMUX 的对话' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '展开显示项目 codeMUX 的更多对话' }));

    expect(screen.getByText('Project Session 15')).toBeTruthy();
    expect(screen.queryByText('Project Session 16')).toBeNull();
    expect(screen.getByRole('button', { name: '展开显示项目 codeMUX 的更多对话' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '折叠显示项目 codeMUX 的对话' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '展开显示项目 codeMUX 的更多对话' }));

    expect(screen.getByText('Project Session 16')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '展开显示项目 codeMUX 的更多对话' })).toBeNull();
    expect(screen.getByRole('button', { name: '折叠显示项目 codeMUX 的对话' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '折叠显示项目 codeMUX 的对话' }));

    expect(screen.getByText('Project Session 05')).toBeTruthy();
    expect(screen.queryByText('Project Session 06')).toBeNull();
  });

  it('collapses and expands the entire conversations section from its header', () => {
    useSessionStore.setState({
      sessions: [makeSession({ id: 'session-active', title: 'Active Session' })],
      archivedSessions: [],
      activeSessionId: null,
      isLoading: false,
      isArchivedLoading: false,
      error: null,
      unreadSessions: new Set<string>(),
    });

    renderSessionList();

    expect(screen.getByText('Active Session')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'toggle-conversations-section' }));

    expect(screen.queryByText('Active Session')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'toggle-conversations-section' }));

    expect(screen.getByText('Active Session')).toBeTruthy();
  });
});
