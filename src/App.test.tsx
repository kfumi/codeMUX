// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 静态导入:如果在 it() 内 await import,首次模块图加载会计入测试超时(15s)。
import App from './App';
import { useNavigationStore } from './stores/navigationStore';

vi.mock('sonner', () => ({
  Toaster: () => <div>toaster</div>,
}));

vi.mock('./features/update/UpdaterProvider', () => ({
  UpdaterProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="updater-provider">{children}</div>
  ),
}));

vi.mock('./features/update/components/UpdateEntry', () => ({
  UpdateEntry: () => <button>更新入口</button>,
}));

vi.mock('./components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./components/layout/MainLayout', () => ({
  MainLayout: ({
    children,
    sidebar,
    sidebarAccessory,
  }: {
    children: React.ReactNode;
    sidebar?: React.ReactNode;
    sidebarAccessory?: React.ReactNode;
  }) => (
    <div>
      <div>{sidebar}</div>
      <div>{sidebarAccessory}</div>
      <div>{children}</div>
    </div>
  ),
}));

vi.mock('./components/layout/Sidebar', () => ({
  Sidebar: () => <div>sidebar</div>,
}));

// App 用例关心的是路由接线:没有活动会话时 app 视图落到哪一页。新建会话页自身
// 的模型/草稿行为由 NewSessionPanel.test.tsx 覆盖,这里只占位。
vi.mock('./components/agent/NewSessionPanel', () => ({
  NewSessionPanel: () => <div>new session panel</div>,
}));

vi.mock('./components/settings/SettingsDialog', () => ({
  SettingsSidebar: () => <div>settings sidebar</div>,
  SettingsContent: () => <div>settings content</div>,
}));

vi.mock('./components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./hooks/useTheme', () => ({
  useTheme: () => {},
}));

vi.mock('./lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
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

vi.mock('./stores/agentStore', () => ({
  useAgentStore: (selector: (state: {
    startQuery: ReturnType<typeof vi.fn>;
    todos: Record<string, never[]>;
    events: Record<string, never[]>;
    eventTimestamps: Record<string, never[]>;
    // 全局 Esc 的武装窗口读它(工单 10):没有回合在跑 = 不该武装。
    isRunning: Record<string, boolean>;
  }) => unknown) => selector({
    startQuery: vi.fn(),
    todos: {},
    events: {},
    eventTimestamps: {},
    isRunning: {},
  }),
}));

vi.mock('./stores/newSessionStore', () => ({
  useNewSessionStore: Object.assign(
    (selector: (state: {
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
    {
      getState: () => ({
        isDraftOpen: false,
        draftProjectId: null,
        openDraft: vi.fn(),
        closeDraft: vi.fn(),
      }),
    },
  ),
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

// 部分替身:保留真实的选择器导出(未读角标计数),只替掉 store 本身。
vi.mock('./stores/sessionStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stores/sessionStore')>();
  return {
    ...actual,
    useSessionStore: Object.assign(
      (selector: (state: {
        createSession: ReturnType<typeof vi.fn>;
        activeSessionId: string | null;
        sessions: never[];
        setActiveSession: ReturnType<typeof vi.fn>;
        unreadSessions: Set<string>;
      }) => unknown) => selector({
        createSession: vi.fn(),
        activeSessionId: null,
        sessions: [],
        setActiveSession: vi.fn(),
        unreadSessions: new Set<string>(),
      }),
      {
        setState: vi.fn(),
        getState: vi.fn(() => ({
          activeSessionId: null,
          autoMarkedUnreadSessions: new Set<string>(),
          clearAutoMarkedUnread: vi.fn(),
        })),
      },
    ),
  };
});

vi.mock('./stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: {
    config: null;
    fetchConfig: () => Promise<void>;
  }) => unknown) => selector({
    config: null,
    fetchConfig: vi.fn(async () => {}),
  }),
}));

vi.mock('./stores/appearanceStore', () => ({
  useAppearanceStore: (selector: (state: {
    prefs: { accent: string; uiFontFamily: string; uiFontSize: number; codeFontSize: number; radius: string; contentWidth: string };
    setAccent: ReturnType<typeof vi.fn>;
    setUiFont: ReturnType<typeof vi.fn>;
    setUiFontSize: ReturnType<typeof vi.fn>;
    setCodeFontSize: ReturnType<typeof vi.fn>;
    setRadius: ReturnType<typeof vi.fn>;
    setContentWidth: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
  }) => unknown) => selector({
    prefs: { accent: 'azure', uiFontFamily: '', uiFontSize: 14, codeFontSize: 13, radius: 'soft', contentWidth: 'fixed' },
    setAccent: vi.fn(),
    setUiFont: vi.fn(),
    setUiFontSize: vi.fn(),
    setCodeFontSize: vi.fn(),
    setRadius: vi.fn(),
    setContentWidth: vi.fn(),
    reset: vi.fn(),
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
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    useNavigationStore.getState().reset();
    window.history.replaceState(null, '', '/');
  });

  it('渲染时在 UpdaterProvider 内将更新入口传给主布局', async () => {

    render(<App />);

    const updaterProvider = screen.getByTestId('updater-provider');
    const updateEntry = screen.getByText('更新入口');

    expect(updateEntry).toBeTruthy();
    expect(updaterProvider.contains(updateEntry)).toBe(true);
  });

  it('设置视图也照常把更新入口交给主布局(与 app 视图行为一致)', async () => {
    useNavigationStore.getState().navigate({ view: 'settings' });

    render(<App />);

    expect(useNavigationStore.getState().current.view).toBe('settings');
    expect(screen.getByText('更新入口')).toBeTruthy();
  });

  it('没有活动会话时 app 视图落在新建会话页（参考 Codex 首页）', () => {
    render(<App />);

    // 冷启动 / 任何回到 app 视图且没有会话的路径,看到的都是同一页 ——
    // 不再是「开始新对话」空白占位。
    expect(screen.getByText('new session panel')).toBeTruthy();
  });

  it('浏览器返回手势会回退应用内页面并留在当前页面', async () => {
    const store = useNavigationStore.getState();
    const initialLocation = store.current;
    store.navigate({ ...initialLocation, view: 'settings' });

    const pushState = vi.spyOn(window.history, 'pushState');
    render(<App />);
    const guardEntriesBeforePop = pushState.mock.calls.length;
    expect(guardEntriesBeforePop).toBeGreaterThan(0);

    window.history.back();

    await waitFor(() => {
      expect(useNavigationStore.getState().current).toEqual(initialLocation);
    });
    expect(window.location.pathname).toBe('/');
    expect(pushState).toHaveBeenCalledTimes(guardEntriesBeforePop + 1);
  });
});
