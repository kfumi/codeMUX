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
