// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectStore } from './projectStore';

const { listProjectsMock } = vi.hoisted(() => ({
  listProjectsMock: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(),
}));

vi.mock('../lib/facades/daemon-facade', () => ({
  daemonFacade: {
    listProjects: listProjectsMock,
    createProject: vi.fn(),
    deleteProject: vi.fn(),
    renameProject: vi.fn(),
  },
}));

describe('project store first load', () => {
  // hasLoadedOnce 让侧边栏能区分「还没拉到项目」与「确实没有项目」:
  // 首屏据此渲染骨架,不用空态占位(那会在数据回来时闪一下)。
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectStore.setState({ projects: [], isLoading: false, hasLoadedOnce: false, error: null });
  });

  it('marks the first load as settled once projects arrive', async () => {
    listProjectsMock.mockResolvedValue([{ id: 'p1', name: 'codeMUX', path: '/tmp/codeMUX' }]);

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
