import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  Channel: class {
    onmessage?: (event: string) => void;
  },
}));

vi.mock('./logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
  }),
  serializeError: (error: unknown) => error,
}));

describe('appApi', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('passes the log file name using Tauri command argument casing', async () => {
    invokeMock.mockResolvedValue('log contents');
    const { appApi } = await import('./tauri');

    await appApi.readLogFile('codemux.log');

    expect(invokeMock).toHaveBeenCalledWith('read_log_file', {
      fileName: 'codemux.log',
    });
  });

  it('checks the development environment without arguments', async () => {
    invokeMock.mockResolvedValue({ checkedAt: '2026-06-27T00:00:00Z', tools: [] });
    const { appApi } = await import('./tauri');

    await appApi.checkDevelopmentEnvironment();

    expect(invokeMock).toHaveBeenCalledWith('check_development_environment', undefined);
  });
});

describe('gitApi', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('requests staged and unstaged status changes with command argument casing', async () => {
    invokeMock.mockResolvedValue([]);
    const { gitApi } = await import('./tauri');

    await gitApi.getStatusChanges('D:/project/app', 'staged');

    expect(invokeMock).toHaveBeenCalledWith('get_git_status_changes', {
      projectPath: 'D:/project/app',
      area: 'staged',
    });
  });

  it('requests status change detail with command argument casing', async () => {
    invokeMock.mockResolvedValue({
      path: 'D:/project/app/src/main.ts',
      status: 'modified',
      originalContent: 'old',
      currentContent: 'new',
      additions: 1,
      deletions: 1,
    });
    const { gitApi } = await import('./tauri');

    await gitApi.getStatusChangeDetail('D:/project/app', 'unstaged', 'D:/project/app/src/main.ts');

    expect(invokeMock).toHaveBeenCalledWith('get_git_status_change_detail', {
      projectPath: 'D:/project/app',
      area: 'unstaged',
      filePath: 'D:/project/app/src/main.ts',
    });
  });

  it('maps branch and commit git commands with command argument casing', async () => {
    invokeMock.mockResolvedValue(undefined);
    const { gitApi } = await import('./tauri');

    await gitApi.getRepositoryState('D:/project/app');
    await gitApi.createBranch('D:/project/app', 'feature/git-panel', true);
    await gitApi.checkoutBranch('D:/project/app', 'feature/git-panel');
    await gitApi.revertStatusChanges('D:/project/app', 'unstaged', 'D:/project/app/src/App.tsx');
    await gitApi.commitChanges('D:/project/app', 'feat: add git panel');
    await gitApi.generateCommitMessage('D:/project/app');

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'get_git_repository_state', {
      projectPath: 'D:/project/app',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'create_git_branch', {
      projectPath: 'D:/project/app',
      branchName: 'feature/git-panel',
      checkout: true,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'checkout_git_branch', {
      projectPath: 'D:/project/app',
      branchName: 'feature/git-panel',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'revert_git_status_changes', {
      projectPath: 'D:/project/app',
      area: 'unstaged',
      filePath: 'D:/project/app/src/App.tsx',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(5, 'commit_git_changes', {
      projectPath: 'D:/project/app',
      message: 'feat: add git panel',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(6, 'generate_git_commit_message', {
      projectPath: 'D:/project/app',
    });
  });
});

describe('terminalApi', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('starts a terminal session with a channel and dimensions', async () => {
    invokeMock.mockResolvedValue('terminal-1');
    const { terminalApi } = await import('./tauri');

    const id = await terminalApi.start('D:/project/app', 120, 30, () => {});

    expect(id).toBe('terminal-1');
    expect(invokeMock).toHaveBeenCalledWith('start_terminal_session', expect.objectContaining({
      projectPath: 'D:/project/app',
      cols: 120,
      rows: 30,
      channel: expect.any(Object),
    }));
  });
});
