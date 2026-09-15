// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gitApiMock = vi.hoisted(() => ({
  getRepositoryState: vi.fn(),
}));

vi.mock('../lib/facades/daemon-facade', () => ({
  daemonFacade: {
    git: gitApiMock,
  },
}));

import { resetRepoBranchCache, useRepoBranch } from './useRepoBranch';

describe('useRepoBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRepoBranchCache();
  });

  afterEach(() => {
    cleanup();
    resetRepoBranchCache();
  });

  it('resolves the current branch for a working path', async () => {
    gitApiMock.getRepositoryState.mockResolvedValue({ currentBranch: 'feature/hover-card' });

    const { result } = renderHook(() => useRepoBranch('D:/project/codeMUX'));

    await waitFor(() => expect(result.current.branch).toBe('feature/hover-card'));
    expect(gitApiMock.getRepositoryState).toHaveBeenCalledWith('D:/project/codeMUX');
  });

  it('degrades to no branch when the path is not a repository', async () => {
    gitApiMock.getRepositoryState.mockRejectedValue('当前项目不是 Git 仓库');

    const { result } = renderHook(() => useRepoBranch('D:/not-a-repo'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.branch).toBeNull();
  });

  it('reuses the cached branch instead of spawning git again', async () => {
    gitApiMock.getRepositoryState.mockResolvedValue({ currentBranch: 'master' });

    const first = renderHook(() => useRepoBranch('D:/project/codeMUX'));
    await waitFor(() => expect(first.result.current.branch).toBe('master'));
    first.unmount();

    const second = renderHook(() => useRepoBranch('D:/project/codeMUX'));
    await waitFor(() => expect(second.result.current.branch).toBe('master'));

    expect(gitApiMock.getRepositoryState).toHaveBeenCalledTimes(1);
  });

  it('does not fetch without a working path', () => {
    const { result } = renderHook(() => useRepoBranch(null));

    expect(result.current.branch).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(gitApiMock.getRepositoryState).not.toHaveBeenCalled();
  });
});
