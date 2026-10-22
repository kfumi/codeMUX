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
import { useProjectStore } from '../../stores/projectStore';
import type { Project } from '../../types/project';

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

describe('ProjectGroup', () => {
  const baseProps = {
    sessions: [],
    activeSessionId: null,
    isActiveProject: false,
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
    useProjectStore.setState({
      projects: [],
      collapsedProjects: new Set<string>(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  function renderProjectGroup(project: Project = makeProject()) {
    return render(
      <TooltipProvider>
        <ProjectGroup {...baseProps} project={project} />
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
    useProjectStore.setState({ collapsedProjects: new Set(['project-1']) });
    const { container } = renderProjectGroup(makeProject({
      roots: [
        { path: 'D:/work/demo', position: 0, isPrimary: true },
        { path: 'D:/work/other', position: 1, isPrimary: false },
      ],
    }));

    expect(container.querySelector('.lucide-folders')).toBeTruthy();
    expect(container.querySelector('[data-icon="folders-open"]')).toBeNull();
  });

  it('uses the open folder icon for an expanded single-root project', () => {
    const { container } = renderProjectGroup();

    expect(container.querySelector('.lucide-folder-open')).toBeTruthy();
    expect(container.querySelector('.lucide-folders')).toBeNull();
  });

  it('uses the closed folder icon for a collapsed single-root project', () => {
    useProjectStore.setState({ collapsedProjects: new Set(['project-1']) });
    const { container } = renderProjectGroup();

    expect(container.querySelector('.lucide-folder')).toBeTruthy();
    expect(container.querySelector('.lucide-folder-open')).toBeNull();
  });

  it('shows an empty placeholder under an expanded project with no sessions', () => {
    renderProjectGroup();

    expect(screen.getByText('暂无对话')).toBeTruthy();
  });

  it('hides the empty placeholder when the project is collapsed', () => {
    useProjectStore.setState({ collapsedProjects: new Set(['project-1']) });
    renderProjectGroup();

    expect(screen.queryByText('暂无对话')).toBeNull();
  });
});
