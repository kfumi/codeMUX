import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../types/session';

const {
  createMock,
  touchMock,
  archiveMock,
  unarchiveMock,
  updatePermissionsMock,
  deleteSessionMock,
  shutdownAgentMock,
  resetAgentSessionMock,
  forkClaudeMock,
  forkCodexMock,
  forkOpenCodeMock,
  clearEventsMock,
  patchSessionViaDaemonMock,
  listSessionsMock,
} = vi.hoisted(() => ({
  createMock: vi.fn<(...args: unknown[]) => Promise<Session>>(),
  touchMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
  archiveMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
  unarchiveMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
  updatePermissionsMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
  deleteSessionMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
  shutdownAgentMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
  resetAgentSessionMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
  forkClaudeMock: vi.fn<(...args: unknown[]) => Promise<Session>>(),
  forkCodexMock: vi.fn<(...args: unknown[]) => Promise<Session>>(),
  forkOpenCodeMock: vi.fn<(...args: unknown[]) => Promise<Session>>(),
  clearEventsMock: vi.fn(),
  patchSessionViaDaemonMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
  listSessionsMock: vi.fn<(...args: unknown[]) => Promise<Session[]>>(),
}));

vi.mock('./agentStore', () => ({
  useAgentStore: {
    getState: () => ({
      sessionWorkingPaths: {},
      clearEvents: clearEventsMock,
      setSessionWorkingPath: vi.fn(),
    }),
  },
}));

vi.mock('../lib/facades/daemon-facade', () => ({
  daemonFacade: {
    createSessionViaDaemon: createMock,
    listSessions: listSessionsMock,
    listArchivedSessions: vi.fn(() => Promise.resolve([])),
    forkClaude: forkClaudeMock,
    forkCodex: forkCodexMock,
    forkOpenCode: forkOpenCodeMock,
    forkPi: forkClaudeMock,
    shutdownAgent: shutdownAgentMock,
    resetAgentSession: resetAgentSessionMock,
    deleteSession: deleteSessionMock,
    archiveViaDaemon: archiveMock,
    unarchiveViaDaemon: unarchiveMock,
    patchSessionViaDaemon: patchSessionViaDaemonMock,
    updatePermissions: updatePermissionsMock,
    touchSession: touchMock,
  },
}));

describe('session store createSession', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    shutdownAgentMock.mockResolvedValue(undefined);
    resetAgentSessionMock.mockResolvedValue(undefined);
    deleteSessionMock.mockResolvedValue(undefined);
    touchMock.mockResolvedValue(undefined);
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
          },
          gemini_cli: {},
          opencode: {},
        },
        theme: 'System',
        compact_ai_output: false,
        default_open_target: 'file_explorer',
      },
      isLoading: false,
      error: null,
    });
  });

  it('creates and activates a Claude fork without sharing the parent events', async () => {
    const parent: Session = {
      id: 'parent',
      title: 'Parent',
      agent_kind: 'claude_code',
      provider_id: null,
      model: 'claude-sonnet',
      mode: 'agent',
      project_id: null,
      created_at: '',
      updated_at: '',
    };
    const child: Session = {
      ...parent,
      id: 'child',
      title: '分支 · Parent',
      parent_session_id: 'parent',
    };
    forkClaudeMock.mockResolvedValue(child);

    const { useSessionStore } = await import('./sessionStore');
    useSessionStore.setState({ sessions: [parent], activeSessionId: parent.id });

    const result = await useSessionStore.getState().forkSession('parent', 'assistant-1', 'provider-1');

    expect(result).toEqual(child);
    expect(forkClaudeMock).toHaveBeenCalledWith('parent', 'assistant-1', 'provider-1');
    expect(useSessionStore.getState().activeSessionId).toBe('child');
    expect(useSessionStore.getState().sessions[0]).toEqual(child);
  });

  it('routes a Codex fork through the Codex session command', async () => {
    const parent: Session = {
      id: 'codex-parent',
      title: 'Codex Parent',
      agent_kind: 'codex',
      provider_id: null,
      model: 'gpt-5',
      mode: 'agent',
      project_id: null,
      created_at: '',
      updated_at: '',
    };
    const child: Session = {
      ...parent,
      id: 'codex-child',
      title: '分支 · Codex Parent',
      parent_session_id: parent.id,
    };
    forkCodexMock.mockResolvedValue(child);

    const { useSessionStore } = await import('./sessionStore');
    useSessionStore.setState({ sessions: [parent], activeSessionId: parent.id });

    await useSessionStore.getState().forkSession(parent.id, 'assistant-2', 'item-2', 'turn-2', 1);

    expect(forkCodexMock).toHaveBeenCalledWith(parent.id, 'assistant-2', 'item-2', 'turn-2', 1);
  });

  it('routes an OpenCode fork through the OpenCode session command', async () => {
    const parent: Session = {
      id: 'opencode-parent',
      title: 'OpenCode Parent',
      agent_kind: 'opencode',
      provider_id: null,
      model: 'gpt-5',
      mode: 'agent',
      project_id: null,
      created_at: '',
      updated_at: '',
    };
    const child: Session = {
      ...parent,
      id: 'opencode-child',
      title: '分支 · OpenCode Parent',
      parent_session_id: parent.id,
    };
    forkOpenCodeMock.mockResolvedValue(child);

    const { useSessionStore } = await import('./sessionStore');
    useSessionStore.setState({ sessions: [parent], activeSessionId: parent.id });

    await useSessionStore.getState().forkSession(parent.id, 'assistant-3', 'message-3');

    expect(forkOpenCodeMock).toHaveBeenCalledWith(parent.id, 'assistant-3', 'message-3');
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
    expect(createMock).toHaveBeenCalledWith({
      title: 'Legacy',
      agentKind: 'claude_code',
      mode: 'agent',
      projectId: 'project-1',
      permissionConfig: null,
      planMode: null,
      model: null,
    });
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
    expect(createMock).toHaveBeenCalledWith({
      title: 'Legacy Codex',
      agentKind: 'codex',
      mode: 'agent',
      projectId: 'project-3',
      permissionConfig: null,
      planMode: null,
      model: null,
    });
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
    expect(createMock).toHaveBeenCalledWith({
      title: 'New',
      agentKind: 'codex',
      mode: 'agent',
      projectId: 'project-2',
      permissionConfig: null,
      planMode: null,
      model: null,
    });
  });

  it('persists the selected model when creating a session', async () => {
    const session: Session = {
      id: 'session-opencode',
      title: 'OpenCode',
      agent_kind: 'opencode',
      provider_id: null,
      model: 'opencode/north-mini-code-free',
      reasoning_effort: 'medium',
      mode: 'agent',
      project_id: null,
      permission_config: null,
      plan_mode: 'off',
      created_at: '',
      updated_at: '',
      is_archived: false,
      is_pinned: false,
    };
    createMock.mockResolvedValue(session);

    const { useSessionStore } = await import('./sessionStore');
    await useSessionStore.getState().createSession(
      'OpenCode',
      'opencode',
      'agent',
      undefined,
      undefined,
      'off',
      'opencode/north-mini-code-free',
    );

    expect(createMock).toHaveBeenCalledWith({
      title: 'OpenCode',
      agentKind: 'opencode',
      mode: 'agent',
      projectId: null,
      permissionConfig: null,
      planMode: 'off',
      model: 'opencode/north-mini-code-free',
    });
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

  it('deletes the app session through the daemon client, including OpenCode', async () => {
    const session: Session = {
      id: 'session-opencode-delete',
      title: 'OpenCode',
      agent_kind: 'opencode',
      provider_id: null,
      model: null,
      reasoning_effort: null,
      mode: 'agent',
      project_id: null,
      created_at: '2026-06-20T00:00:00.000Z',
      updated_at: '2026-06-20T00:00:00.000Z',
    };
    const { useSessionStore } = await import('./sessionStore');
    useSessionStore.setState({
      sessions: [session],
      archivedSessions: [],
      activeSessionId: session.id,
      isLoading: false,
      isArchivedLoading: false,
      error: null,
    });

    await useSessionStore.getState().deleteSession(session.id);

    expect(deleteSessionMock).toHaveBeenCalledWith(session.id);
    expect(clearEventsMock).toHaveBeenCalledWith(session.id);
    expect(shutdownAgentMock).not.toHaveBeenCalled();
    expect(resetAgentSessionMock).not.toHaveBeenCalled();
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

  it('updates plan mode without overwriting the permission snapshot', async () => {
    updatePermissionsMock.mockResolvedValue(undefined);
    const permissionConfig = '{"kind":"claude_code","permissionMode":"bypassPermissions"}';
    const session: Session = {
      id: 'session-permissions',
      title: 'Permissioned',
      agent_kind: 'claude_code',
      provider_id: null,
      model: null,
      reasoning_effort: null,
      mode: 'agent',
      permission_config: permissionConfig,
      plan_mode: 'on',
      project_id: null,
      created_at: '2026-06-20T00:00:00.000Z',
      updated_at: '2026-06-20T00:00:00.000Z',
    };

    const { useSessionStore } = await import('./sessionStore');
    useSessionStore.setState({
      sessions: [session],
      activeSessionId: session.id,
      isLoading: false,
      error: null,
    });

    await useSessionStore.getState().updateSessionPermissions(session.id, undefined, 'off');

    expect(updatePermissionsMock).toHaveBeenCalledWith(session.id, undefined, 'off');
    expect(useSessionStore.getState().sessions[0].permission_config).toBe(permissionConfig);
    expect(useSessionStore.getState().sessions[0].plan_mode).toBe('off');
  });

  it('does not mark the active session as unread', async () => {
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

    const { useSessionStore } = await import('./sessionStore');
    useSessionStore.setState({
      sessions: [activeSession],
      archivedSessions: [],
      activeSessionId: activeSession.id,
      unreadSessions: new Set<string>(),
      isLoading: false,
      isArchivedLoading: false,
      error: null,
    });

    useSessionStore.getState().markSessionUnread(activeSession.id);

    expect(useSessionStore.getState().unreadSessions.has(activeSession.id)).toBe(false);
  });

  it('still marks an inactive session as unread', async () => {
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
    const inactiveSession: Session = {
      id: 'session-inactive',
      title: 'Inactive',
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
      sessions: [activeSession, inactiveSession],
      archivedSessions: [],
      activeSessionId: activeSession.id,
      unreadSessions: new Set<string>(),
      isLoading: false,
      isArchivedLoading: false,
      error: null,
    });

    useSessionStore.getState().markSessionUnread(inactiveSession.id);

    expect(useSessionStore.getState().unreadSessions.has(inactiveSession.id)).toBe(true);
  });

  it('exposes maintenance updates to a second daemon client via listSessions', async () => {
    const session: Session = {
      id: 'session-shared',
      title: 'Shared Session',
      agent_kind: 'claude_code',
      provider_id: null,
      model: null,
      reasoning_effort: null,
      mode: 'agent',
      project_id: null,
      is_pinned: false,
      is_archived: false,
      created_at: '2026-06-20T00:00:00.000Z',
      updated_at: '2026-06-20T00:00:00.000Z',
    };

    let sharedSession = { ...session };
    patchSessionViaDaemonMock.mockImplementation(async (sessionId: string, patch: Record<string, unknown>) => {
      if (sessionId !== sharedSession.id) {
        throw new Error('Session not found');
      }
      if (typeof patch.pinned === 'boolean') {
        sharedSession = { ...sharedSession, is_pinned: patch.pinned };
      }
      if (typeof patch.title === 'string') {
        sharedSession = { ...sharedSession, title: patch.title };
      }
    });
    listSessionsMock.mockImplementation(async () => [sharedSession]);

    const { useSessionStore } = await import('./sessionStore');
    useSessionStore.setState({
      sessions: [sharedSession],
      archivedSessions: [],
      activeSessionId: sharedSession.id,
      unreadSessions: new Set<string>(),
      isLoading: false,
      isArchivedLoading: false,
      error: null,
    });

    await useSessionStore.getState().setSessionPinned(sharedSession.id, true);
    await useSessionStore.getState().updateSessionTitle(sharedSession.id, 'Renamed by desktop');

    const secondClientSessions = await listSessionsMock();
    expect(secondClientSessions).toEqual([
      {
        ...session,
        is_pinned: true,
        title: 'Renamed by desktop',
      },
    ]);
    expect(patchSessionViaDaemonMock).toHaveBeenCalledWith('session-shared', { pinned: true });
    expect(patchSessionViaDaemonMock).toHaveBeenCalledWith('session-shared', { title: 'Renamed by desktop' });
  });
});
