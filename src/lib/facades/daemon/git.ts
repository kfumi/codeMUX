import type {
  CreatePullRequestRequest,
  CreatePullRequestResult,
  GitChangedFile,
  GitCommitGraphResult,
  GitCommitMessageSuggestion,
  GitPullRequestSuggestion,
  GitRepositoryState,
  GitStatusArea,
  GitStatusChange,
  GitWorktree,
} from '../../gitTypes';
import { ensureDaemonClient } from './lifecycle';

/** 工作区 git 与 forge 操作。 */
export const git = {
  getChangedFiles: async (projectPath: string, baselineTree: string) =>
    (await ensureDaemonClient()).gitChangedFiles(projectPath, baselineTree) as Promise<GitChangedFile[]>,
  getChangedFilesSinceHead: async (projectPath: string) =>
    (await ensureDaemonClient()).gitChangedFilesSinceHead(projectPath) as Promise<GitChangedFile[]>,
  getRepositoryState: async (projectPath: string) =>
    (await ensureDaemonClient()).gitRepositoryState(projectPath) as Promise<GitRepositoryState>,
  getCommitGraph: async (projectPath: string, maxCount?: number, skip?: number) =>
    (await ensureDaemonClient()).gitCommitGraph(projectPath, maxCount, skip) as Promise<GitCommitGraphResult>,
  getStatusChanges: async (
    projectPath: string,
    area: GitStatusArea,
  ) => (await ensureDaemonClient()).gitStatusChanges(projectPath, area) as Promise<GitStatusChange[]>,
  getStatusChangeDetail: async (
    projectPath: string,
    area: GitStatusArea,
    filePath: string,
  ) =>
    (await ensureDaemonClient()).gitStatusChangeDetail(projectPath, area, filePath) as Promise<GitStatusChange>,
  stageStatusChanges: async (projectPath: string, filePath?: string) => {
    await (await ensureDaemonClient()).gitStage(projectPath, filePath);
  },
  unstageStatusChanges: async (projectPath: string, filePath?: string) => {
    await (await ensureDaemonClient()).gitUnstage(projectPath, filePath);
  },
  revertStatusChanges: async (
    projectPath: string,
    area: GitStatusArea,
    filePath?: string,
  ) => {
    await (await ensureDaemonClient()).gitRevert(projectPath, area, filePath);
  },
  createBranch: async (projectPath: string, branchName: string, checkout: boolean) => {
    await (await ensureDaemonClient()).gitCreateBranch(projectPath, branchName, checkout);
  },
  checkoutBranch: async (projectPath: string, branchName: string) => {
    await (await ensureDaemonClient()).gitCheckoutBranch(projectPath, branchName);
  },
  listWorktrees: async (projectPath: string) =>
    (await ensureDaemonClient()).gitListWorktrees(projectPath) as Promise<GitWorktree[]>,
  createWorktree: async (
    projectPath: string,
    branchName: string,
    baseBranch?: string | null,
  ) => (await ensureDaemonClient()).gitCreateWorktree(projectPath, branchName, baseBranch) as Promise<GitWorktree>,
  commitChanges: async (projectPath: string, message: string) => {
    const result = await (await ensureDaemonClient()).gitCommit(projectPath, message);
    return result.commit;
  },
  pushBranch: async (projectPath: string) => {
    await (await ensureDaemonClient()).gitPush(projectPath);
  },
  generateCommitMessage: async (projectPath: string) =>
    (await ensureDaemonClient()).gitGenerateCommitMessage(projectPath) as Promise<GitCommitMessageSuggestion>,
  generatePullRequestDescription: async (projectPath: string) =>
    (await ensureDaemonClient()).gitGeneratePullRequestDescription(projectPath) as Promise<GitPullRequestSuggestion>,
  createPullRequest: async (request: CreatePullRequestRequest) =>
    (await ensureDaemonClient()).gitCreatePullRequest(request) as Promise<CreatePullRequestResult>,
  getGiteeCredentialStatus: async () => {
    const result = await (await ensureDaemonClient()).gitGiteeCredentialStatus();
    return result.configured;
  },
  setGiteeToken: async (token: string) => {
    await (await ensureDaemonClient()).gitSetGiteeToken(token);
  },
  clearGiteeToken: async () => {
    await (await ensureDaemonClient()).gitClearGiteeToken();
  },
};

export type GitDomain = typeof git;
