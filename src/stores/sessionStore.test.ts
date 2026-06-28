import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../types/session';

const createMock = vi.fn<(...args: unknown[]) => Promise<Session>>();
const touchMock = vi.fn<(...args: unknown[]) => Promise<void>>();
const getArchivedMock = vi.fn<(...args: unknown[]) => Promise<Session[]>>();
const archiveMock = vi.fn<(...args: unknown[]) => Promise<void>>();
const unarchiveMock = vi.fn<(...args: unknown[]) => Promise<void>>();

vi.mock('../lib/tauri', () => ({
  agentApi: {
    shutdown: vi.fn(),
    deleteClaudeSessionFiles: vi.fn(),
    resetSession: vi.fn(),
  },
  configApi: {
    get: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    setActiveProvider: vi.fn(),
    setDefaultAgentKind: vi.fn(),
    updateAgentConfig: vi.fn(),
    setTheme: vi.fn(),
    fetchModels: vi.fn(),
    testProvider: vi.fn(),
  },
  sessionApi: {
    create: createMock,
    getAll: vi.fn(),
    getArchived: getArchivedMock,
    delete: vi.fn(),
    archive: archiveMock,
    unarchive: unarchiveMock,
    updateTitle: vi.fn(),
    touch: touchMock,
  },
}));

describe('session store createSession', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    const { useSessionStore } = await import('./sessionStore');
    const { useSettingsStore } = await import('./settingsStore');
    useSessionStore.setState({
      sessions: [],
      archivedSessions: [],
      activeSessionId: null,
      isLoading: false,
      isArchivedLoading: false,
      error: null,
    });
    useSettingsStore.setState({
      config: {
        providers: [],
        active_provider_id: null,
        agent_defaults: {
          default_agent_kind: 'claude_code',
        },
        agent_configs: {
          claude_code: {
            executable_mode: 'auto',
            resume_sessions: true,
          },
          codex: {
            sdk_mode: 'responses',
          },
          gemini_cli: {},
          opencode: {},
        },
        theme: 'System',
        compact_ai_output: false,
      },
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

  it('uses the persisted default agent for legacy createSession(title, mode, projectId)', async () => {
    const session: Session = {
      id: 'session-default-agent',
      title: 'Legacy Codex',
      agent_kind: 'codex',
      provider_id: null,
      model: null,
      mode: 'agent',
      project_id: 'project-3',
      created_at: '',
      updated_at: '',
    };
    createMock.mockResolvedValue(session);

    const { useSessionStore } = await import('./sessionStore');
    const { useSettingsStore } = await import('./settingsStore');
    useSettingsStore.setState((state) => ({
      config: state.config
        ? {
            ...state.config,
            agent_defaults: {
              default_agent_kind: 'codex',
            },
          }
        : null,
    }));

    const created = await useSessionStore.getState().createSession('Legacy Codex', 'agent', 'project-3');

    expect(created).toEqual(session);
    expect(createMock).toHaveBeenCalledWith('Legacy Codex', 'codex', 'agent', 'project-3');
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

  it('moves a touched historical session to the front of the local list', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T08:00:00.000Z'));
    touchMock.mockResolvedValue(undefined);

    const oldSession: Session = {
      id: 'session-old',
      title: 'Old',
      agent_kind: 'claude_code',
      provider_id: null,
      model: null,
      reasoning_effort: null,
      mode: 'agent',
      project_id: 'project-1',
      created_at: '2026-06-18T00:00:00.000Z',
      updated_at: '2026-06-18T00:00:00.000Z',
    };
    const recentSession: Session = {
      id: 'session-recent',
      title: 'Recent',
      agent_kind: 'claude_code',
      provider_id: null,
      model: null,
      reasoning_effort: null,
      mode: 'agent',
      project_id: 'project-1',
      created_at: '2026-06-19T00:00:00.000Z',
      updated_at: '2026-06-19T00:00:00.000Z',
    };

    const { useSessionStore } = await import('./sessionStore');
    useSessionStore.setState({
      sessions: [recentSession, oldSession],
      activeSessionId: oldSession.id,
      isLoading: false,
      error: null,
    });

    useSessionStore.getState().touchSession(oldSession.id);

    expect(useSessionStore.getState().sessions.map((session) => session.id)).toEqual([
      'session-old',
      'session-recent',
    ]);
    expect(useSessionStore.getState().sessions[0].updated_at).toBe('2026-06-20T08:00:00.000Z');
    expect(touchMock).toHaveBeenCalledWith('session-old');

    vi.useRealTimers();
  });

  it('archives a session and removes it from the active sidebar list', async () => {
    archiveMock.mockResolvedValue(undefined);
    const activeSession: Session = {
      id: 'session-active',
      title: 'Active',
      agent_kind: 'codex',
      provider_id: null,
      model: null,
      reasoning_effort: null,
      mode: 'agent',
      project_id: null,
      created_at: '2026-06-20T00:00:00.000Z',
      updated_at: '2026-06-20T00:00:00.000Z',
    };
    const nextSession: Session = {
      id: 'session-next',
      title: 'Next',
      agent_kind: 'claude_code',
      provider_id: null,
      model: null,
      reasoning_effort: null,
      mode: 'agent',
      project_id: null,
      created_at: '2026-06-19T00:00:00.000Z',
      updated_at: '2026-06-19T00:00:00.000Z',
    };

    const { useSessionStore } = await import('./sessionStore');
    useSessionStore.setState({
      sessions: [activeSession, nextSession],
      archivedSessions: [],
      activeSessionId: activeSession.id,
      isLoading: false,
      isArchivedLoading: false,
      error: null,
    });

    await useSessionStore.getState().archiveSession(activeSession.id);

    expect(archiveMock).toHaveBeenCalledWith(activeSession.id);
    expect(useSessionStore.getState().sessions.map((session) => session.id)).toEqual(['session-next']);
    expect(useSessionStore.getState().archivedSessions[0]).toMatchObject({
      id: 'session-active',
      is_archived: true,
    });
    expect(useSessionStore.getState().activeSessionId).toBe('session-next');
  });

  it('unarchives a session and returns it to the active sidebar list', async () => {
    unarchiveMock.mockResolvedValue(undefined);
    const archivedSession: Session = {
      id: 'session-archived',
      title: 'Archived',
      agent_kind: 'codex',
      provider_id: null,
      model: null,
      reasoning_effort: null,
      mode: 'agent',
      project_id: 'project-1',
      created_at: '2026-06-18T00:00:00.000Z',
      updated_at: '2026-06-19T00:00:00.000Z',
      is_archived: true,
    };

    const { useSessionStore } = await import('./sessionStore');
    useSessionStore.setState({
      sessions: [],
      archivedSessions: [archivedSession],
      activeSessionId: null,
      isLoading: false,
      isArchivedLoading: false,
      error: null,
    });

    await useSessionStore.getState().unarchiveSession(archivedSession.id);

    expect(unarchiveMock).toHaveBeenCalledWith(archivedSession.id);
    expect(useSessionStore.getState().archivedSessions).toEqual([]);
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: 'session-archived',
      is_archived: false,
    });
  });
});
