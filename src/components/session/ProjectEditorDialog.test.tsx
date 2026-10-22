// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { Project } from '../../types/project';
import { useProjectStore } from '../../stores/projectStore';
import { useSessionStore } from '../../stores/sessionStore';
import { ProjectEditorDialog } from './ProjectEditorDialog';

const { updateProjectMock, deleteProjectMock, openDialogMock } = vi.hoisted(() => ({
  updateProjectMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  deleteProjectMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  openDialogMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('../../lib/facades/daemon-facade', () => ({
  daemonFacade: {
    updateProject: updateProjectMock,
    deleteProject: deleteProjectMock,
  },
}));

vi.mock('../../lib/desktopDialogs', () => ({
  openDialog: openDialogMock,
}));

function projectFixture(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Fullstack',
    roots: [
      { path: 'D:/work/frontend', position: 0, isPrimary: true },
      { path: 'D:/work/backend', position: 1, isPrimary: false },
      { path: 'D:/work/shared', position: 2, isPrimary: false },
    ],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function seedSessions(projectId: string, workingPaths: string[]): void {
  useSessionStore.setState({
    sessions: workingPaths.map((workingPath, index) => ({
      id: `session-${index}`,
      title: `Session ${index}`,
      agent_kind: 'claude_code',
      provider_id: null,
      model: null,
      reasoning_effort: null,
      mode: 'chat',
      permission_config: null,
      plan_mode: null,
      project_id: projectId,
      working_path: workingPath,
      is_archived: false,
      is_pinned: false,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })) as never,
    archivedSessions: [],
  });
}

describe('ProjectEditorDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectStore.setState({ projects: [] });
    useSessionStore.setState({ sessions: [], archivedSessions: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('moves the primary badge to the smallest remaining root when the primary is removed', () => {
    const project = projectFixture();
    seedSessions(project.id, ['D:/work/frontend']);
    render(<ProjectEditorDialog project={project} open onOpenChange={() => {}} />);

    expect(screen.getAllByText('主要')).toHaveLength(1);
    fireEvent.click(screen.getByLabelText('移除 frontend'));

    // backend 继任主根：徽标跟着走，且提示会话工作目录不变。
    expect(screen.getAllByText('主要')).toHaveLength(1);
    expect(screen.getByLabelText('移除 backend').closest('div')?.textContent).toContain('主要');
    expect(screen.getByText(/会话的工作目录不变/)).toBeTruthy();
  });

  it('switches the primary root without reordering the list', () => {
    render(<ProjectEditorDialog project={projectFixture()} open onOpenChange={() => {}} />);

    fireEvent.click(screen.getAllByText('设为主要')[0]);

    const rows = screen.getAllByLabelText(/^移除 /);
    expect(rows[0]?.closest('div')?.textContent).toContain('设为主要');
    expect(rows[1]?.closest('div')?.textContent).toContain('主要');
    expect(rows[2]?.closest('div')?.textContent).toContain('设为主要');
  });

  it('sends the edited roots and primary root on save', async () => {
    updateProjectMock.mockResolvedValue(projectFixture());
    render(<ProjectEditorDialog project={projectFixture()} open onOpenChange={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('项目名称'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getAllByText('设为主要')[0]);
    fireEvent.click(screen.getByText('保存'));

    expect(updateProjectMock).toHaveBeenCalledWith('p1', {
      name: 'Renamed',
      roots: ['D:/work/frontend', 'D:/work/backend', 'D:/work/shared'],
      primaryRoot: 'D:/work/backend',
    });
  });

  it('appends picked folders without duplicating existing roots', async () => {
    openDialogMock.mockResolvedValue(['D:/work/backend', 'D:/work/extra']);
    updateProjectMock.mockResolvedValue(projectFixture());
    render(<ProjectEditorDialog project={projectFixture()} open onOpenChange={() => {}} />);

    fireEvent.click(screen.getByText('添加文件夹'));
    await screen.findByText('extra');
    fireEvent.click(screen.getByText('保存'));

    expect(updateProjectMock).toHaveBeenCalledWith('p1', expect.objectContaining({
      roots: ['D:/work/frontend', 'D:/work/backend', 'D:/work/shared', 'D:/work/extra'],
    }));
  });

  it('routes removing the last root to the delete-project flow with the session count', async () => {
    const project = projectFixture({
      roots: [{ path: 'D:/work/only', position: 0, isPrimary: true }],
    });
    seedSessions(project.id, ['D:/work/only', 'D:/work/elsewhere']);
    deleteProjectMock.mockResolvedValue(undefined);
    render(<ProjectEditorDialog project={project} open onOpenChange={() => {}} />);

    fireEvent.click(screen.getByLabelText('移除 only'));

    expect(await screen.findByText(/会同时删除其名下 2 条会话/)).toBeTruthy();
    fireEvent.click(screen.getByText('删除'));

    expect(deleteProjectMock).toHaveBeenCalledWith('p1');
  });
});
