import { describe, expect, it } from 'vitest';

import type { GitRepositoryState } from './tauri';
import {
  createDefaultDraftWorkspace,
  defaultBaseRef,
  deriveWorktreeBranchName,
  getDraftWorktreePath,
  getWorktreeTriggerLabel,
  resolveWorktreeBaseRef,
} from './draftWorkspacePicker';

const baseState: GitRepositoryState = {
  currentBranch: 'master',
  branches: [{ name: 'master', current: true }],
  detached: false,
  hasUncommittedChanges: false,
  aheadCount: 0,
  hasUnpushedCommits: false,
  upstreamBranch: null,
  upstreamRef: null,
};

describe('defaultBaseRef', () => {
  it('prefers current branch over upstream', () => {
    expect(defaultBaseRef({
      ...baseState,
      upstreamBranch: 'gitee/master',
    })).toBe('master');
  });

  it('falls back to upstream when detached', () => {
    expect(defaultBaseRef({
      ...baseState,
      currentBranch: null,
      detached: true,
      upstreamBranch: 'gitee/master',
    })).toBe('gitee/master');
  });

  it('falls back to current branch when upstream is missing', () => {
    expect(defaultBaseRef(baseState)).toBe('master');
  });

  it('returns null for detached HEAD without upstream', () => {
    expect(defaultBaseRef({
      ...baseState,
      currentBranch: null,
      detached: true,
    })).toBeNull();
  });
});

describe('resolveWorktreeBaseRef', () => {
  it('uses explicit base ref when provided', () => {
    expect(resolveWorktreeBaseRef('feat/base', baseState)).toBe('feat/base');
  });

  it('falls back to default base ref when unset', () => {
    expect(resolveWorktreeBaseRef(null, {
      ...baseState,
      currentBranch: 'main',
      upstreamBranch: 'origin/main',
    })).toBe('main');
  });
});

describe('deriveWorktreeBranchName', () => {
  it('returns a mnemonic slug', () => {
    const branchName = deriveWorktreeBranchName();
    expect(branchName).toMatch(/^[a-z]+(-[a-z]+)+$/);
  });
});

describe('getDraftWorktreePath', () => {
  it('returns path only for existing worktrees', () => {
    expect(getDraftWorktreePath({ kind: 'local' })).toBeNull();
    expect(getDraftWorktreePath({ kind: 'worktree', baseRef: null })).toBeNull();
    expect(getDraftWorktreePath({
      kind: 'existing',
      worktreePath: 'D:/repo/.worktrees/feat',
    })).toBe('D:/repo/.worktrees/feat');
  });
});

describe('getWorktreeTriggerLabel', () => {
  it('labels each selection mode', () => {
    expect(getWorktreeTriggerLabel({ kind: 'local' }, [])).toBe('本地');
    expect(getWorktreeTriggerLabel({ kind: 'worktree', baseRef: null }, [])).toBe('新建工作树');
    expect(getWorktreeTriggerLabel({
      kind: 'existing',
      worktreePath: 'D:/repo/.worktrees/feat-new',
    }, [{
      path: 'D:/repo/.worktrees/feat-new',
      branch: 'feat/new',
    }])).toBe('feat/new');
  });
});

describe('createDefaultDraftWorkspace', () => {
  it('defaults to local', () => {
    expect(createDefaultDraftWorkspace()).toEqual({ kind: 'local' });
  });
});
