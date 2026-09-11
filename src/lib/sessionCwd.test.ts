import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../types/project';
import { getStoredAgentCwd, isDefaultWorkingDirectoryRequest, isValidWorkingPath, ensureDraftSessionWorkingPath, normalizeSessionWorkingDirectory, resolveDefaultWorkingDirectory, resolveDraftSessionCwd, resolveSessionCwd, resolveSessionWorkingPath, DEFAULT_AGENT_CWD } from './sessionCwd';

const projects: Project[] = [
  {
    id: 'project-1',
    name: 'codeMUX',
    path: 'D:/project/ai-code/codeMUX',
    created_at: '',
    updated_at: '',
  },
];

describe('resolveSessionCwd', () => {
  it('prefers the bound project path for a new session draft', () => {
    expect(resolveSessionCwd(projects, 'project-1', '.')).toBe('D:/project/ai-code/codeMUX');
  });

  it('falls back to the remembered cwd when no draft project is bound', () => {
    expect(resolveSessionCwd(projects, null, 'D:/workspace')).toBe('D:/workspace');
  });

  it('falls back to the remembered cwd when the draft project is missing', () => {
    expect(resolveSessionCwd(projects, 'missing-project', 'D:/workspace')).toBe('D:/workspace');
  });
});

describe('getStoredAgentCwd', () => {
  it('returns the remembered cwd when available', () => {
    expect(getStoredAgentCwd({ getItem: () => 'D:/workspace' })).toBe('D:/workspace');
  });

  it('falls back to the default cwd when storage is unavailable', () => {
    expect(getStoredAgentCwd(undefined)).toBe(DEFAULT_AGENT_CWD);
  });
});

describe('default working directory helpers', () => {
  it('treats empty and dot cwd as the default non-project request', () => {
    expect(isDefaultWorkingDirectoryRequest('')).toBe(true);
    expect(isDefaultWorkingDirectoryRequest('.')).toBe(true);
    expect(isDefaultWorkingDirectoryRequest('   ')).toBe(true);
    expect(isDefaultWorkingDirectoryRequest('D:/project/codeMUX')).toBe(false);
  });

  it('resolves the default folder under the user home directory', () => {
    expect(resolveDefaultWorkingDirectory('C:/Users/me')).toBe('C:/Users/me/CodemuxProject');
    expect(resolveDefaultWorkingDirectory('C:\\Users\\me')).toBe('C:\\Users\\me\\CodemuxProject');
    expect(normalizeSessionWorkingDirectory('.', 'C:/Users/me')).toBe('C:/Users/me/CodemuxProject');
    expect(normalizeSessionWorkingDirectory('D:/workspace', 'C:/Users/me')).toBe('D:/workspace');
  });
});

const appApiMock = vi.hoisted(() => ({
  getUserHomeDirectory: vi.fn(),
}));

describe('ensureDraftSessionWorkingPath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appApiMock.getUserHomeDirectory.mockResolvedValue('C:/Users/me');
  });

  it('resolves the default cwd to CodemuxProject under home', async () => {
    await expect(ensureDraftSessionWorkingPath('.')).resolves.toBe('C:/Users/me/CodemuxProject');
    expect(appApiMock.getUserHomeDirectory).toHaveBeenCalled();
  });

  it('keeps absolute cwd unchanged', async () => {
    await expect(ensureDraftSessionWorkingPath('D:/workspace')).resolves.toBe('D:/workspace');
    expect(appApiMock.getUserHomeDirectory).not.toHaveBeenCalled();
  });
});

describe('resolveSessionWorkingPath', () => {
  it('prefers the persisted session working path', () => {
    expect(resolveSessionWorkingPath(
      {
        id: 'session-1',
        project_id: 'project-1',
        working_path: 'C:/Users/me/.codemux/worktrees/abc/shaggy-baboon',
      },
      projects,
      { rememberedPath: 'D:/remembered/worktree' },
    )).toBe('C:/Users/me/.codemux/worktrees/abc/shaggy-baboon');
  });

  it('prefers remembered path over init event cwd', () => {
    expect(resolveSessionWorkingPath(
      { id: 'session-1', project_id: 'project-1' },
      projects,
      {
        rememberedPath: 'D:/remembered/worktree',
        events: [{
          kind: 'system',
          data: {
            type: 'system',
            subtype: 'init',
            uuid: 'init-1',
            session_id: 'session-1',
            tools: [],
            model: '',
            cwd: 'D:/project/ai-code/codeMUX',
            permissionMode: 'default',
          },
        }],
      },
    )).toBe('D:/remembered/worktree');
  });

  it('prefers init event cwd over project path', () => {
    const path = resolveSessionWorkingPath(
      { id: 'session-1', project_id: 'project-1' },
      projects,
      {
        events: [{
          kind: 'system',
          data: {
            type: 'system',
            subtype: 'init',
            uuid: 'init-1',
            session_id: 'session-1',
            tools: [],
            model: '',
            cwd: 'D:/project/codeMUX/.worktrees/brave-otter',
            permissionMode: 'default',
          },
        }],
      },
    );

    expect(path).toBe('D:/project/codeMUX/.worktrees/brave-otter');
  });

  it('falls back to remembered cwd and then project path', () => {
    expect(resolveSessionWorkingPath(
      { id: 'session-1', project_id: 'project-1' },
      projects,
      { rememberedPath: 'D:/remembered/worktree' },
    )).toBe('D:/remembered/worktree');

    expect(resolveSessionWorkingPath(
      { id: 'session-1', project_id: 'project-1' },
      projects,
    )).toBe('D:/project/ai-code/codeMUX');
  });

  it('rejects relative cwd fallbacks for project-bound sessions', () => {
    expect(resolveSessionWorkingPath(
      { id: 'session-1', project_id: 'project-1' },
      [],
    )).toBeNull();
  });
});

describe('isValidWorkingPath', () => {
  it('rejects empty and relative paths', () => {
    expect(isValidWorkingPath('')).toBe(false);
    expect(isValidWorkingPath('.')).toBe(false);
    expect(isValidWorkingPath('docs')).toBe(false);
  });

  it('accepts absolute paths', () => {
    expect(isValidWorkingPath('D:/project/codeMUX')).toBe(true);
    expect(isValidWorkingPath('C:\\Users\\me\\.codemux\\worktrees\\abc\\branch')).toBe(true);
  });
});

const gitApiMock = vi.hoisted(() => ({
  getRepositoryState: vi.fn(),
  createWorktree: vi.fn(),
}));

vi.mock('./facades/daemon-facade', () => ({
  daemonFacade: {
    git: gitApiMock,
  },
}));

vi.mock('./desktop-bridge', () => ({
  requireDesktopBridge: () => ({
    getUserHomeDirectory: appApiMock.getUserHomeDirectory,
  }),
}));

const worktreeProjects: Project[] = [
  {
    id: 'project-1',
    name: 'codeMUX',
    path: 'D:/project/codeMUX',
    created_at: '',
    updated_at: '',
  },
];

describe('resolveDraftSessionCwd', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitApiMock.getRepositoryState.mockResolvedValue({
      currentBranch: 'master',
      branches: [{ name: 'master', current: true }],
      detached: false,
      hasUncommittedChanges: false,
      aheadCount: 0,
      hasUnpushedCommits: false,
      upstreamBranch: 'origin/master',
      upstreamRef: 'refs/remotes/origin/master',
    });
    gitApiMock.createWorktree.mockResolvedValue({
      path: 'D:/project/codeMUX/.worktrees/brave-otter',
      branch: 'brave-otter',
      isMain: false,
    });
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
  });

  it('creates a worktree on submit when draft is in worktree mode', async () => {
    const cwd = await resolveDraftSessionCwd(
      worktreeProjects,
      'project-1',
      '.',
      { kind: 'worktree', baseRef: 'feat/worktree' },
    );

    expect(gitApiMock.createWorktree).toHaveBeenCalledWith(
      'D:/project/codeMUX',
      expect.stringMatching(/^[a-z]+(-[a-z]+)+$/),
      'feat/worktree',
    );
    expect(cwd).toBe('D:/project/codeMUX/.worktrees/brave-otter');
  });

  it('uses current branch as the default base ref when none is selected', async () => {
    await resolveDraftSessionCwd(
      worktreeProjects,
      'project-1',
      '.',
      { kind: 'worktree', baseRef: null },
    );

    expect(gitApiMock.createWorktree).toHaveBeenCalledWith(
      'D:/project/codeMUX',
      expect.stringMatching(/^[a-z]+(-[a-z]+)+$/),
      'master',
    );
  });

  it('reuses an existing worktree path without creating a new one', async () => {
    const cwd = await resolveDraftSessionCwd(
      worktreeProjects,
      'project-1',
      '.',
      { kind: 'existing', worktreePath: 'D:/project/codeMUX/.worktrees/feat-new' },
    );

    expect(gitApiMock.createWorktree).not.toHaveBeenCalled();
    expect(cwd).toBe('D:/project/codeMUX/.worktrees/feat-new');
  });
});
