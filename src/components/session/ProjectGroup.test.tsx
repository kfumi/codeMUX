// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const narrowState = vi.hoisted(() => ({ value: false }));
const hostCaps = vi.hoisted(() => ({ hasExplorer: true }));

vi.mock('../../hooks/useIsNarrowViewport', () => ({
  useIsNarrowViewport: () => narrowState.value,
}));

vi.mock('../../hooks/useHostCapabilities', () => ({
  useHostCapabilities: () => ({
    has: (id: string) => (id === 'shell.explorer' ? hostCaps.hasExplorer : true),
  }),
}));

import { TooltipProvider } from '../ui/tooltip';
import { ProjectGroup } from './ProjectGroup';
import { buildSidebarProjection, type ProjectSidebarSection } from '../../lib/sidebarProjection';
import { useSessionStore } from '../../stores/sessionStore';
import type { Project } from '../../types/project';
import type { Session } from '../../types/session';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Demo Project',
    roots: [{ path: 'D:/work/demo', position: 0, isPrimary: true }],
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    title: 'Session 1',
    agent_kind: 'codex',
    provider_id: null,
    model: null,
    reasoning_effort: null,
    mode: null,
    permission_config: null,
    plan_mode: null,
    project_id: 'project-1',
    created_at: '',
    updated_at: '',
    is_archived: false,
    is_pinned: false,
    ...overrides,
  };
}

describe('ProjectGroup', () => {
  const baseProps = {
    activeSessionId: null,
    isActiveProject: false,
    onToggleExpanded: vi.fn(),
    onShowMoreSessions: vi.fn(),
    onCollapseSessions: vi.fn(),
    onSelectSession: vi.fn(),
    onArchiveSession: vi.fn(),
    onToggleSessionPinned: vi.fn(),
    onDeleteSession: vi.fn(),
    onRenameSession: vi.fn(),
    onNewSessionInProject: vi.fn(),
    onOpenProjectFiles: vi.fn(),
    onOpenImportSessions: vi.fn(),
    onDeleteProject: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    narrowState.value = false;
    hostCaps.hasExplorer = true;
    useSessionStore.setState({ unreadSessions: new Set<string>(), autoMarkedUnreadSessions: new Set<string>() });
  });

  afterEach(() => {
    cleanup();
  });

  function makeSection(
    project: Project,
    sessions: Session[] = [],
    options: { collapsed?: boolean; visibleLimit?: number } = {},
  ): ProjectSidebarSection {
    return buildSidebarProjection(sessions, [], [project], {
      pinnedExpanded: true,
      projectsExpanded: true,
      conversationsExpanded: true,
      collapsedProjects: new Set(options.collapsed ? [project.id] : []),
      visibleSessionLimits: options.visibleLimit != null
        ? { [project.id]: options.visibleLimit }
        : {},
    }).projects[0];
  }

  function renderProjectGroup(
    project: Project = makeProject(),
    sessions: Session[] = [],
    options: { collapsed?: boolean; visibleLimit?: number } = {},
  ) {
    return render(
      <TooltipProvider>
        <ProjectGroup
          {...baseProps}
          project={project}
          section={makeSection(project, sessions, options)}
        />
      </TooltipProvider>,
    );
  }

  function actionCluster(): HTMLElement {
    const trigger = screen.getByRole('button', { name: '项目 Demo Project 的更多操作' });
    return trigger.parentElement as HTMLElement;
  }

  it('keeps the action cluster hover-only on wide viewports', () => {
    renderProjectGroup();

    const cluster = actionCluster();
    expect(cluster.className).toContain('opacity-0');
    expect(cluster.className).toContain('group-hover:opacity-100');
    expect(cluster.className).not.toContain('opacity-100 group-hover');
  });

  it('exposes the whole project row as the drag surface when sorting is enabled', () => {
    const onMoveProject = vi.fn();
    const { container } = render(
      <TooltipProvider>
        <ProjectGroup
          {...baseProps}
          project={makeProject()}
          section={makeSection(makeProject())}
          dragEnabled
          onMoveProject={onMoveProject}
        />
      </TooltipProvider>,
    );

    const row = container.querySelector<HTMLElement>('[data-project-row="project-1"]');
    expect(row).toBeTruthy();
    expect(row?.tabIndex).toBe(0);
    expect(row?.getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowUp Alt+ArrowDown');
    expect(row?.className).toContain('touch-none');
    // 行尾不再有需要按住的拖拽按钮或图标。
    expect(container.querySelector('.lucide-grip-vertical')).toBeNull();
    expect(screen.queryByRole('button', { name: /拖动调整项目/ })).toBeNull();

    fireEvent.keyDown(row!, { key: 'ArrowDown', altKey: true });
    expect(onMoveProject).toHaveBeenCalledWith('project-1', 1);
  });

  it('does not expose sorting affordances without dragEnabled', () => {
    const { container } = renderProjectGroup();

    const row = container.querySelector<HTMLElement>('[data-project-row="project-1"]');
    expect(row?.getAttribute('tabindex')).toBeNull();
    expect(row?.getAttribute('aria-keyshortcuts')).toBeNull();
    expect(row?.className).not.toContain('touch-none');
  });

  it('always shows the action cluster on narrow viewports (no hover on touch)', () => {
    narrowState.value = true;
    renderProjectGroup();

    const cluster = actionCluster();
    expect(cluster.className).toContain('opacity-100');
    expect(cluster.className).not.toContain('opacity-0');
  });

  function openClusterMenu() {
    // Radix 下拉菜单监听 pointerdown 打开,jsdom 的 click 不会派生该事件。
    fireEvent.pointerDown(
      screen.getByRole('button', { name: '项目 Demo Project 的更多操作' }),
      { button: 0, ctrlKey: false },
    );
  }

  it('opens the cluster menu on narrow viewports and hides the explorer entry outside the shell', async () => {
    narrowState.value = true;
    hostCaps.hasExplorer = false;
    renderProjectGroup();

    openClusterMenu();
    await waitFor(() => expect(screen.getByText('导入外部会话')).toBeTruthy());
    expect(screen.queryByText('在资源管理器中打开')).toBeNull();
  });

  it('keeps the explorer entry inside the desktop shell', async () => {
    renderProjectGroup();

    openClusterMenu();
    await waitFor(() => expect(screen.getByText('在资源管理器中打开')).toBeTruthy());
  });

  it('renames through the project editor instead of a separate menu action', async () => {
    renderProjectGroup();

    openClusterMenu();
    await waitFor(() => expect(screen.getByText('编辑项目')).toBeTruthy());
    expect(screen.queryByText('重命名项目')).toBeNull();
    const editItem = screen.getByText('编辑项目').closest('[role="menuitem"]');
    expect(editItem?.querySelector('.lucide-pencil')).toBeTruthy();
  });

  it('uses the open multi-folder icon for an expanded multi-root project without a count badge', () => {
    const { container } = renderProjectGroup(makeProject({
      roots: [
        { path: 'D:/work/demo', position: 0, isPrimary: true },
        { path: 'D:/work/other', position: 1, isPrimary: false },
      ],
    }));

    expect(container.querySelector('[data-icon="folders-open"]')).toBeTruthy();
    expect(container.querySelector('.lucide-layers')).toBeNull();
    expect(screen.getByText('2 个源文件夹')).toBeTruthy();
  });

  it('uses the closed multi-folder icon for a collapsed multi-root project', () => {
    const { container } = renderProjectGroup(makeProject({
      roots: [
        { path: 'D:/work/demo', position: 0, isPrimary: true },
        { path: 'D:/work/other', position: 1, isPrimary: false },
      ],
    }), [], { collapsed: true });

    expect(container.querySelector('.lucide-folders')).toBeTruthy();
    expect(container.querySelector('[data-icon="folders-open"]')).toBeNull();
  });

  it('uses the open folder icon for an expanded single-root project', () => {
    const { container } = renderProjectGroup();

    expect(container.querySelector('.lucide-folder-open')).toBeTruthy();
    expect(container.querySelector('.lucide-folders')).toBeNull();
  });

  it('uses the closed folder icon for a collapsed single-root project', () => {
    const { container } = renderProjectGroup(makeProject(), [], { collapsed: true });

    expect(container.querySelector('.lucide-folder')).toBeTruthy();
    expect(container.querySelector('.lucide-folder-open')).toBeNull();
  });

  it('shows an empty placeholder under an expanded project with no sessions', () => {
    renderProjectGroup();

    expect(screen.getByText('暂无对话')).toBeTruthy();
  });

  it('renders a visible hierarchy line for an expanded project with sessions', () => {
    const { container } = renderProjectGroup(makeProject(), [makeSession()]);

    const sessionsContainer = container.querySelector<HTMLElement>(
      '[data-project-sessions="project-1"]',
    );
    expect(sessionsContainer?.className).toContain('border-[hsl(var(--sidebar-fg))]/12');
  });

  it('hides the empty placeholder when the project is collapsed', () => {
    renderProjectGroup(makeProject(), [], { collapsed: true });

    expect(screen.queryByText('暂无对话')).toBeNull();
  });

  it('shows an unread dot beside a collapsed project name', () => {
    useSessionStore.setState({ unreadSessions: new Set(['session-1']) });
    const { container } = renderProjectGroup(makeProject(), [makeSession()], { collapsed: true });

    const row = container.querySelector('[data-project-row="project-1"]');
    expect(row?.querySelector('[data-project-unread-dot]')).toBeTruthy();
    expect(screen.getByText('有未读对话')).toBeTruthy();
  });

  it('keeps the unread dot on the session row instead when the project is expanded', () => {
    useSessionStore.setState({ unreadSessions: new Set(['session-1']) });
    const { container } = renderProjectGroup(makeProject(), [makeSession()]);

    const row = container.querySelector('[data-project-row="project-1"]');
    expect(row?.querySelector('[data-project-unread-dot]')).toBeNull();
    expect(screen.queryByText('有未读对话')).toBeNull();
  });

  it('shows no project-level dot without unread sessions', () => {
    const { container } = renderProjectGroup(makeProject(), [makeSession()], { collapsed: true });

    const row = container.querySelector('[data-project-row="project-1"]');
    expect(row?.querySelector('[data-project-unread-dot]')).toBeNull();
  });
});
