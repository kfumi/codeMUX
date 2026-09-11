/**
 * Git / Review 域的前端契约类型(原 src/lib/tauri.ts 类型段,Tauri 壳退役后迁入)。
 * 数据面统一来自 daemon(workspace git 路由),形状与 daemon 响应对齐。
 */

export interface GitChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  originalContent: string | null;
  currentContent: string;
}

export type GitStatusArea = 'unstaged' | 'staged';

export interface GitStatusChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  originalContent: string | null;
  currentContent: string;
  additions: number;
  deletions: number;
}

export interface GitBranch {
  name: string;
  current: boolean;
}

export interface GitRepositoryState {
  currentBranch: string | null;
  branches: GitBranch[];
  detached: boolean;
  hasUncommittedChanges: boolean;
  aheadCount: number;
  hasUnpushedCommits: boolean;
  upstreamBranch: string | null;
  upstreamRef: string | null;
}

export interface GitWorktree {
  path: string;
  branch: string | null;
  isMain: boolean;
}

export interface GitCommitMessageSuggestion {
  message: string;
}

export interface GitPullRequestSuggestion {
  title: string;
  body: string;
  base: string;
}

export type ForgePlatform = 'github' | 'gitlab' | 'gitee';

export interface CreatePullRequestRequest {
  projectPath: string;
  title: string;
  body: string;
  base: string;
}

export interface CreatePullRequestResult {
  platform: ForgePlatform;
  url: string;
  number: number;
  head: string;
  base: string;
}
