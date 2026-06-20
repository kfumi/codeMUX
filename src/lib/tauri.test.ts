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
