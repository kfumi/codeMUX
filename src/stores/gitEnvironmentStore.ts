/**
 * 摘要面板「环境信息」（变更统计 + 当前分支）的按项目缓存。
 *
 * 面板有两张面（标题栏浮层 / 钉在对话右侧的内联面），且浮层每次开关都会卸载重挂。
 * 若取数跟着组件挂载走，就会为一份没变的数据反复跑整套 git 命令（daemon 侧
 * `getRepositoryState` + `getStatusChanges` 各 spawn 若干 git 进程）。这里把快照
 * 提升为按 `projectPath` 键控的应用级缓存：
 *
 * - `ensure(path)`：**无缓存才取**。挂载 / 项目切换时调用；命中缓存立刻秒显。
 * - `refresh(path)`：**总是重取**，但在途期间保留上一份数据可见（不闪骨架）。
 *   分支检出/新建成功、回合结束等「这份信息会变」的操作后调用。
 *
 * 并发语义：同一路径的请求串行化——在途 `ensure` 被后续 `ensure` 共享；在途期间
 * 到来的 `refresh` 不被丢弃，而是排在当前请求之后补取一次（因此一个回合结束时的
 * 刷新不会被刚打开面板的首次取数吞掉），且连续的多个 `refresh` 合并为一次。
 * 每路径独立串行，所以响应不会乱序；`reset` 递增 epoch 作废所有在途响应。
 *
 * 刻意不含 TTL、不含手动刷新——见 docs/specs/2026-10-18-git-environment-snapshot-cache.md。
 */
import { create } from 'zustand';

import { daemonFacade } from '../lib/facades/daemon-facade';
import { formatErrorMessage } from '../lib/errorMessage';
import type { GitRepositoryState, GitStatusChange } from '../lib/gitTypes';

export type GitEnvironmentLoadState = 'loading' | 'ready' | 'unavailable';

export interface GitEnvironmentTotals {
  additions: number;
  deletions: number;
}

export interface GitEnvironmentEntry {
  status: GitEnvironmentLoadState;
  repositoryState: GitRepositoryState | null;
  totals: GitEnvironmentTotals;
  unavailableMessage: string | null;
  fetchedAt: number;
}

interface GitEnvironmentState {
  entries: Record<string, GitEnvironmentEntry>;
  hasEntry: (projectPath: string) => boolean;
  /** 无缓存才取数；命中缓存直接返回该条目，在途时返回在途请求的结果。 */
  ensure: (projectPath: string) => Promise<GitEnvironmentEntry | undefined>;
  /** 总是补一次新取数（排在当前在途请求之后）；在途期间保留旧数据可见。 */
  refresh: (projectPath: string) => Promise<GitEnvironmentEntry | undefined>;
  /** 清空所有缓存与在途状态（测试隔离用；也会作废在途响应）。 */
  reset: () => void;
}

type Snapshot =
  | { repositoryState: GitRepositoryState; totals: GitEnvironmentTotals }
  | { error: string };

type SetState = (
  partial: Partial<GitEnvironmentState> | ((state: GitEnvironmentState) => Partial<GitEnvironmentState>),
) => void;

/** 每个路径最近一次请求（在途或已排队）；用来串行化并共享在途请求。 */
const pending = new Map<string, Promise<GitEnvironmentEntry | undefined>>();
/** 已排队但尚未开始的 `refresh`；用来把连续多个 refresh 合并成一次。 */
const refreshQueued = new Set<string>();
/** `reset` 递增；在途响应与当前 epoch 不符即作废。 */
let epoch = 0;

function loadingEntry(): GitEnvironmentEntry {
  return {
    status: 'loading',
    repositoryState: null,
    totals: { additions: 0, deletions: 0 },
    unavailableMessage: null,
    fetchedAt: 0,
  };
}

function snapshotToEntry(snapshot: Snapshot): GitEnvironmentEntry {
  if ('error' in snapshot) {
    return {
      status: 'unavailable',
      repositoryState: null,
      totals: { additions: 0, deletions: 0 },
      unavailableMessage: snapshot.error,
      fetchedAt: Date.now(),
    };
  }
  return {
    status: 'ready',
    repositoryState: snapshot.repositoryState,
    totals: snapshot.totals,
    unavailableMessage: null,
    fetchedAt: Date.now(),
  };
}

function totalsOf(files: GitStatusChange[]): GitEnvironmentTotals {
  return files.reduce(
    (totals, file) => ({
      additions: totals.additions + file.additions,
      deletions: totals.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

async function fetchEnvironment(projectPath: string): Promise<Snapshot> {
  try {
    const [repositoryState, files] = await Promise.all([
      daemonFacade.git.getRepositoryState(projectPath),
      // 统计拿不到（如非 git 仓库的边界情况）不该拖垮分支显示：退化为 0。
      daemonFacade.git.getStatusChanges(projectPath, 'unstaged').catch(() => []),
    ]);
    return { repositoryState, totals: totalsOf(files) };
  } catch (err) {
    return { error: formatErrorMessage(err) };
  }
}

function runFetch(
  projectPath: string,
  mode: 'ensure' | 'refresh',
  set: SetState,
  get: () => GitEnvironmentState,
): Promise<GitEnvironmentEntry | undefined> {
  if (mode === 'refresh' && refreshQueued.has(projectPath)) {
    // 已有一个 refresh 在排队，合并：等它即可，不再叠加一次取数。
    return pending.get(projectPath) ?? Promise.resolve(undefined);
  }

  const previous = mode === 'refresh' ? pending.get(projectPath) ?? null : null;
  if (mode === 'refresh') refreshQueued.add(projectPath);

  // 首次出现（无任何条目）先落一个加载态，让面板显示骨架；已有条目（含在途刷新）
  // 保持原样，刷新期间旧数据继续可见。
  if (!get().entries[projectPath]) {
    set((state) => ({ entries: { ...state.entries, [projectPath]: loadingEntry() } }));
  }

  const capturedEpoch = epoch;
  // 无前序请求时同步发起（保证挂载即取数，不拖到下一个微任务）；有则串到它后面。
  const started = previous
    ? previous.catch(() => undefined).then(() => fetchEnvironment(projectPath))
    : fetchEnvironment(projectPath);
  const promise = started
    .then((snapshot) => {
      if (capturedEpoch !== epoch) return undefined;
      const entry = snapshotToEntry(snapshot);
      set((state) => ({ entries: { ...state.entries, [projectPath]: entry } }));
      return entry;
    })
    .finally(() => {
      if (pending.get(projectPath) === promise) {
        pending.delete(projectPath);
        refreshQueued.delete(projectPath);
      }
    });

  pending.set(projectPath, promise);
  return promise;
}

export const useGitEnvironmentStore = create<GitEnvironmentState>((set, get) => ({
  entries: {},

  hasEntry: (projectPath) => Boolean(projectPath && get().entries[projectPath]),

  ensure: (projectPath) => {
    if (!projectPath) return Promise.resolve(undefined);
    const existing = get().entries[projectPath];
    if (existing) return pending.get(projectPath) ?? Promise.resolve(existing);
    return runFetch(projectPath, 'ensure', set, get);
  },

  refresh: (projectPath) => {
    if (!projectPath) return Promise.resolve(undefined);
    return runFetch(projectPath, 'refresh', set, get);
  },

  reset: () => {
    epoch += 1;
    pending.clear();
    refreshQueued.clear();
    set({ entries: {} });
  },
}));
