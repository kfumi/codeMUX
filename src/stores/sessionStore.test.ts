import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../types/session';

const createMock = vi.fn<(...args: unknown[]) => Promise<Session>>();

vi.mock('../lib/tauri', () => ({
  agentApi: {
    shutdown: vi.fn(),
    deleteClaudeSessionFiles: vi.fn(),
    resetSession: vi.fn(),
  },
  sessionApi: {
    create: createMock,
    getAll: vi.fn(),
    delete: vi.fn(),
    updateTitle: vi.fn(),
  },
}));

describe('session store createSession', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    const { useSessionStore } = await import('./sessionStore');
    useSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      error: null,
    });
  });

  it('keeps the legacy createSession(title, mode, projectId) call shape', async () => {
    const session: Session = {
      id: 'session-legacy',
      title: 'Legacy',
      agent_kind: 'claude_code',
      provider_id: null,
      model: null,
      mode: 'agent',
      project_id: 'project-1',
      created_at: '',
      updated_at: '',
    };
    createMock.mockResolvedValue(session);

    const { useSessionStore } = await import('./sessionStore');
    const created = await useSessionStore.getState().createSession('Legacy', 'agent', 'project-1');

    expect(created).toEqual(session);
    expect(createMock).toHaveBeenCalledWith('Legacy', 'claude_code', 'agent', 'project-1');
  });

  it('supports createSession(title, agentKind, mode, projectId)', async () => {
    const session: Session = {
      id: 'session-new',
      title: 'New',
      agent_kind: 'codex',
      provider_id: null,
      model: null,
      mode: 'agent',
      project_id: 'project-2',
      created_at: '',
      updated_at: '',
    };
    createMock.mockResolvedValue(session);

    const { useSessionStore } = await import('./sessionStore');
    const created = await useSessionStore.getState().createSession('New', 'codex', 'agent', 'project-2');

    expect(created).toEqual(session);
    expect(createMock).toHaveBeenCalledWith('New', 'codex', 'agent', 'project-2');
  });
});
