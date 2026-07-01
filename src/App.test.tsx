// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({
  Toaster: () => <div>toaster</div>,
}));

vi.mock('./features/update/UpdaterProvider', () => ({
  UpdaterProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="updater-provider">{children}</div>
  ),
}));

vi.mock('./features/update/components/UpdateToast', () => ({
  UpdateToast: () => <div>更新提示</div>,
}));

vi.mock('./components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./components/layout/MainLayout', () => ({
  MainLayout: ({ children, sidebar }: { children: React.ReactNode; sidebar?: React.ReactNode }) => (
    <div>
      <div>{sidebar}</div>
      <div>{children}</div>
    </div>
  ),
}));

vi.mock('./components/layout/Sidebar', () => ({
  Sidebar: () => <div>sidebar</div>,
}));

vi.mock('./components/agent/TodoList', () => ({
  TodoList: () => <div>todo-list</div>,
}));

vi.mock('./components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./hooks/useTheme', () => ({
  useTheme: () => {},
}));

vi.mock('./lib/agentProvider', () => ({
  resolveAgentProviderConfig: () => ({
    provider: null,
    apiKey: null,
    baseUrl: null,
    model: null,
    runtimeModel: null,
    codexNeedsProxy: false,
  }),
}));

vi.mock('./lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
  }),
  serializeError: (error: unknown) => error,
}));

vi.mock('./lib/sessionCwd', () => ({
  getStoredAgentCwd: () => null,
  resolveSessionCwd: () => null,
}));

vi.mock('./lib/slashCommands', () => ({
  registerSkillCommands: vi.fn(),
}));

vi.mock('./lib/tauri', () => ({
  sessionApi: {
    updateProvider: vi.fn(),
  },
}));

vi.mock('./stores/agentStore', () => ({
  useAgentStore: (selector: (state: {
    startQuery: ReturnType<typeof vi.fn>;
    todos: Record<string, never[]>;
  }) => unknown) => selector({
    startQuery: vi.fn(),
    todos: {},
  }),
}));

vi.mock('./stores/newSessionStore', () => ({
  useNewSessionStore: (selector: (state: {
    isDraftOpen: boolean;
    draftProjectId: string | null;
    openDraft: ReturnType<typeof vi.fn>;
    closeDraft: ReturnType<typeof vi.fn>;
  }) => unknown) => selector({
    isDraftOpen: false,
    draftProjectId: null,
    openDraft: vi.fn(),
    closeDraft: vi.fn(),
  }),
}));

vi.mock('./stores/projectStore', () => ({
  useProjectStore: (selector: (state: {
    projects: never[];
    setActiveProject: ReturnType<typeof vi.fn>;
  }) => unknown) => selector({
    projects: [],
    setActiveProject: vi.fn(),
  }),
}));

vi.mock('./stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (state: {
      createSession: ReturnType<typeof vi.fn>;
      activeSessionId: string | null;
      sessions: never[];
      setActiveSession: ReturnType<typeof vi.fn>;
    }) => unknown) => selector({
      createSession: vi.fn(),
      activeSessionId: null,
      sessions: [],
      setActiveSession: vi.fn(),
    }),
    {
      setState: vi.fn(),
    },
  ),
}));

vi.mock('./stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: {
    config: null;
    fetchConfig: () => Promise<void>;
  }) => unknown) => selector({
    config: null,
    fetchConfig: vi.fn(async () => {}),
  }),
}));

vi.mock('./stores/skillStore', () => ({
  useSkillStore: {
    getState: () => ({
      syncBuiltins: vi.fn(async () => {}),
      fetchInstalled: vi.fn(async () => {}),
      installedSkills: [],
    }),
  },
}));

describe('App', () => {
  it('渲染时在 UpdaterProvider 内挂载全局更新提示', async () => {
    const { default: App } = await import('./App');

    render(<App />);

    const updaterProvider = screen.getByTestId('updater-provider');
    const updateToast = screen.getByText('更新提示');

    expect(updateToast).toBeTruthy();
    expect(updaterProvider.contains(updateToast)).toBe(true);
  });
});
