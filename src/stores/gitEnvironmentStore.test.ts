import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitRepositoryState } from '../lib/gitTypes';

const gitApiMock = vi.hoisted(() => ({
  getRepositoryState: vi.fn(),
  getStatusChanges: vi.fn(),
}));

vi.mock('../lib/facades/daemon-facade', () => ({
  daemonFacade: { git: gitApiMock },
}));

import { useGitEnvironmentStore } from './gitEnvironmentStore';

const store = () => useGitEnvironmentStore.getState();

function repoState(branch = 'main'): GitRepositoryState {
  return {
    currentBranch: branch,
    branches: [{ name: branch, current: true }],
    detached: false,
    hasUncommittedChanges: true,
    aheadCount: 0,
    hasUnpushedCommits: false,
    upstreamBranch: null,
    upstreamRef: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('gitEnvironmentStore', () => {
  beforeEach(() => {
    store().reset();
    vi.clearAllMocks();
    gitApiMock.getRepositoryState.mockResolvedValue(repoState());
    gitApiMock.getStatusChanges.mockResolvedValue([
      { additions: 3, deletions: 1 },
      { additions: 2, deletions: 4 },
    ]);
  });

  it('ensure 首次取数并缓存：同项目第二次不再请求', async () => {
    const entry = await store().ensure('D:/app');
    expect(gitApiMock.getRepositoryState).toHaveBeenCalledTimes(1);
    expect(entry?.status).toBe('ready');
    expect(entry?.repositoryState?.currentBranch).toBe('main');
    expect(entry?.totals).toEqual({ additions: 5, deletions: 5 });

    const cached = await store().ensure('D:/app');
    expect(gitApiMock.getRepositoryState).toHaveBeenCalledTimes(1);
    expect(cached).toEqual(entry);
  });

  it('切换项目时新项目只取一次，先前项目缓存保留', async () => {
    await store().ensure('D:/a');
    const b = await store().ensure('D:/b');
    expect(gitApiMock.getRepositoryState).toHaveBeenCalledTimes(2);
    expect(b?.status).toBe('ready');

    const aAgain = await store().ensure('D:/a');
    expect(gitApiMock.getRepositoryState).toHaveBeenCalledTimes(2);
    expect(store().hasEntry('D:/a')).toBe(true);
    expect(store().hasEntry('D:/b')).toBe(true);
    expect(aAgain?.status).toBe('ready');
  });

  it('refresh 总是重取并返回新数据', async () => {
    await store().ensure('D:/a');
    gitApiMock.getRepositoryState.mockResolvedValue(repoState('feature'));

    const entry = await store().refresh('D:/a');
    expect(gitApiMock.getRepositoryState).toHaveBeenCalledTimes(2);
    expect(entry?.repositoryState?.currentBranch).toBe('feature');
  });

  it('在途 ensure 被后续 ensure 共享为一次请求', async () => {
    const gate = deferred<GitRepositoryState>();
    gitApiMock.getRepositoryState.mockReturnValueOnce(gate.promise);

    const first = store().ensure('D:/a');
    const second = store().ensure('D:/a');
    expect(gitApiMock.getRepositoryState).toHaveBeenCalledTimes(1);

    gate.resolve(repoState());
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a?.status).toBe('ready');
  });

  it('在途 ensure 期间到来的 refresh 不被丢弃，排在之后补取', async () => {
    const gate = deferred<GitRepositoryState>();
    gitApiMock.getRepositoryState.mockReturnValueOnce(gate.promise);

    const ensuring = store().ensure('D:/a');
    expect(gitApiMock.getRepositoryState).toHaveBeenCalledTimes(1);

    gitApiMock.getRepositoryState.mockResolvedValue(repoState('after'));
    const refreshing = store().refresh('D:/a');
    expect(gitApiMock.getRepositoryState).toHaveBeenCalledTimes(1); // 串行，尚未发起

    gate.resolve(repoState('before'));
    const entry = await refreshing;
    await ensuring;

    expect(gitApiMock.getRepositoryState).toHaveBeenCalledTimes(2);
    expect(entry?.repositoryState?.currentBranch).toBe('after');
  });

  it('连续的多个 refresh 合并为一次请求', async () => {
    const gate = deferred<GitRepositoryState>();
    gitApiMock.getRepositoryState.mockReturnValueOnce(gate.promise);

    const first = store().refresh('D:/a');
    const second = store().refresh('D:/a');
    expect(gitApiMock.getRepositoryState).toHaveBeenCalledTimes(1);

    gate.resolve(repoState());
    await Promise.all([first, second]);
    expect(gitApiMock.getRepositoryState).toHaveBeenCalledTimes(1);
  });

  it('过期响应被丢弃：reset 作废在途请求', async () => {
    const gate = deferred<GitRepositoryState>();
    gitApiMock.getRepositoryState.mockReturnValueOnce(gate.promise);

    const request = store().ensure('D:/a');
    store().reset();
    gate.resolve(repoState());
    const entry = await request;

    expect(entry).toBeUndefined();
    expect(store().hasEntry('D:/a')).toBe(false);
  });

  it('非 git 仓库的兜底被缓存，重复打开不重查', async () => {
    gitApiMock.getRepositoryState.mockRejectedValue(
      new Error(JSON.stringify({ error: '当前项目不是 Git 仓库' })),
    );

    const entry = await store().ensure('D:/a');
    expect(entry?.status).toBe('unavailable');
    expect(entry?.unavailableMessage).toBe('当前项目不是 Git 仓库');

    await store().ensure('D:/a');
    expect(gitApiMock.getRepositoryState).toHaveBeenCalledTimes(1);
  });

  it('getStatusChanges 失败时统计归零，但仓库状态仍 ready', async () => {
    gitApiMock.getStatusChanges.mockRejectedValue(new Error('boom'));

    const entry = await store().ensure('D:/a');
    expect(entry?.status).toBe('ready');
    expect(entry?.totals).toEqual({ additions: 0, deletions: 0 });
  });
});
