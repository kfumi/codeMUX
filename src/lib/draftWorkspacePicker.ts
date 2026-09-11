import { createNameId } from 'mnemonic-id';

import type { GitRepositoryState } from './gitTypes';

export type DraftWorkspaceSelection =
  | { kind: 'local' }
  | { kind: 'worktree'; baseRef: string | null }
  | { kind: 'existing'; worktreePath: string };

export function createDefaultDraftWorkspace(): DraftWorkspaceSelection {
  return { kind: 'local' };
}

export function getDraftWorktreePath(selection: DraftWorkspaceSelection): string | null {
  return selection.kind === 'existing' ? selection.worktreePath : null;
}

export function defaultBaseRef(state: GitRepositoryState): string | null {
  if (!state.detached && state.currentBranch) {
    return state.currentBranch;
  }
  if (state.upstreamBranch) {
    return state.upstreamBranch;
  }
  return null;
}

export function resolveWorktreeBaseRef(
  baseRef: string | null | undefined,
  state: GitRepositoryState,
): string | null {
  const trimmed = baseRef?.trim();
  if (trimmed) {
    return trimmed;
  }
  return defaultBaseRef(state);
}

export function deriveWorktreeBranchName(): string {
  return createNameId();
}

export function getWorktreeTriggerLabel(
  selection: DraftWorkspaceSelection,
  worktrees: Array<{ path: string; branch?: string | null }>,
): string {
  if (selection.kind === 'worktree') {
    return '新建工作树';
  }
  if (selection.kind === 'existing') {
    const match = worktrees.find((entry) => entry.path === selection.worktreePath);
    if (match?.branch) {
      return match.branch;
    }
    return selection.worktreePath.split(/[/\\]/).filter(Boolean).at(-1) ?? selection.worktreePath;
  }
  return '本地';
}

export function getBranchPickerLabel(
  baseRef: string | null,
  state: GitRepositoryState | null,
): string {
  if (baseRef) {
    return baseRef;
  }
  if (state) {
    const fallback = defaultBaseRef(state);
    if (fallback) {
      return fallback;
    }
  }
  return '选择基准分支';
}
