// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../types/project';
import { useProjectStore } from './projectStore';

const { listProjectsMock, createProjectMock, updateProjectMock } = vi.hoisted(() => ({
  listProjectsMock: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(),
  createProjectMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  updateProjectMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('../lib/facades/daemon-facade', () => ({
  daemonFacade: {
    listProjects: listProjectsMock,
    createProject: createProjectMock,
    deleteProject: vi.fn(),
    renameProject: vi.fn(),
    updateProject: updateProjectMock,
  },
}));

function projectFixture(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Fullstack',
    roots: [
      { path: 'D:/work/frontend', position: 0, isPrimary: true },
      { path: 'D:/work/backend', position: 1, isPrimary: false },
    ],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('project store first load', () => {
  // hasLoadedOnce 让侧边栏能区分「还没拉到项目」与「确实没有项目」:
  // 首屏据此渲染骨架,不用空态占位(那会在数据回来时闪一下)。
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectStore.setState({ projects: [], isLoading: false, hasLoadedOnce: false, error: null });
  });

  it('marks the first load as settled once projects arrive', async () => {
    listProjectsMock.mockResolvedValue([projectFixture()]);

    expect(useProjectStore.getState().hasLoadedOnce).toBe(false);

    await useProjectStore.getState().fetchProjects();

    expect(useProjectStore.getState().hasLoadedOnce).toBe(true);
    expect(useProjectStore.getState().projects).toHaveLength(1);
  });

  it('also marks it as settled when the first load fails, so the skeleton cannot stick', async () => {
    listProjectsMock.mockRejectedValue(new Error('daemon down'));

    await useProjectStore.getState().fetchProjects();

    expect(useProjectStore.getState().hasLoadedOnce).toBe(true);
    expect(useProjectStore.getState().error).toContain('daemon down');
  });
});

describe('project store multi-root mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectStore.setState({ projects: [], isLoading: false, hasLoadedOnce: true, error: null });
  });

  it('creates a project from the selected roots in order', async () => {
    createProjectMock.mockResolvedValue(projectFixture());

    const created = await useProjectStore
      .getState()
      .createProject('Fullstack', ['D:/work/frontend', 'D:/work/backend']);

    expect(createProjectMock).toHaveBeenCalledWith('Fullstack', [
      'D:/work/frontend',
      'D:/work/backend',
    ]);
    expect(created.id).toBe('p1');
    expect(useProjectStore.getState().projects[0]?.roots).toHaveLength(2);
  });

  it('replaces the cached project with the edited roots and primary', async () => {
    useProjectStore.setState({ projects: [projectFixture()] });
    const edited = projectFixture({
      roots: [
        { path: 'D:/work/backend', position: 0, isPrimary: true },
        { path: 'D:/work/shared', position: 1, isPrimary: false },
      ],
    });
    updateProjectMock.mockResolvedValue(edited);

    await useProjectStore.getState().updateProject('p1', {
      roots: ['D:/work/backend', 'D:/work/shared'],
      primaryRoot: 'D:/work/backend',
    });

    expect(updateProjectMock).toHaveBeenCalledWith('p1', {
      roots: ['D:/work/backend', 'D:/work/shared'],
      primaryRoot: 'D:/work/backend',
    });
    expect(useProjectStore.getState().projects[0]?.roots).toEqual(edited.roots);
  });
});
