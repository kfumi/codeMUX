// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../types/session';
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
    created_at: '2026-06-20T00:00:00.000Z',
    updated_at: '2026-06-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('SessionList', () => {
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
    });
    useProjectStore.setState({
      projects: [],
      activeProjectId: null,
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('does not render archived sessions in the left sidebar history', () => {
    render(<SessionList onNewSessionInProject={vi.fn()} onAddProject={vi.fn()} />);

    expect(screen.getByText('Active Session')).toBeTruthy();
    expect(screen.queryByText('Archived Session')).toBeNull();
    expect(screen.queryByText('已归档对话')).toBeNull();
  });
});
