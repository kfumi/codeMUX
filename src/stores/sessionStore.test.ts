import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../types/session';

const createMock = vi.fn<(...args: unknown[]) => Promise<Session>>();

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
    delete: vi.fn(),
    updateTitle: vi.fn(),
  },
}));

describe('session store createSession', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    const { useSessionStore } = await import('./sessionStore');
    const { useSettingsStore } = await import('./settingsStore');
    useSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
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
            default_provider_id: null,
          },
          gemini_cli: {},
          opencode: {},
        },
        theme: 'System',
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
});
