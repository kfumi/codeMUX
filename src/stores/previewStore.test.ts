// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const readFileMock = vi.fn<(path: string, projectPath?: string) => Promise<string>>();
const listDirectoryMock = vi.fn();

vi.mock('../lib/tauri', () => ({
  fileApi: {
    readFile: readFileMock,
    listDirectory: listDirectoryMock,
  },
}));

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
  serializeError: (error: unknown) => error,
}));

describe('previewStore openFile with artifact source (DIFF1)', () => {
  beforeEach(() => {
    readFileMock.mockReset();
    listDirectoryMock.mockReset();
    localStorage.clear();
  });

  it('uses persisted snapshot when opening an artifact-sourced file (no disk read)', async () => {
    const { usePreviewStore } = await import('./previewStore');
    usePreviewStore.setState({ diffFiles: [], activeDiffPath: null });

    await usePreviewStore.getState().openFile('src/app.ts', {
      source: 'artifact',
      originalContent: 'old code',
      currentContent: 'new code',
    });

    expect(readFileMock).not.toHaveBeenCalled();
    const file = usePreviewStore.getState().diffFiles[0];
    expect(file?.source).toBe('artifact');
    expect(file?.originalContent).toBe('old code');
    expect(file?.currentContent).toBe('new code');
    expect(file?.isLoading).toBe(false);
  });

  it('falls back to disk read when source is not artifact', async () => {
    const { usePreviewStore } = await import('./previewStore');
    usePreviewStore.setState({ diffFiles: [], activeDiffPath: null });
    readFileMock.mockResolvedValue('disk content');

    await usePreviewStore.getState().openFile('src/app.ts', {
      originalContent: 'old code',
    });

    expect(readFileMock).toHaveBeenCalledTimes(1);
    const file = usePreviewStore.getState().diffFiles[0];
    expect(file?.source).toBe('disk');
    expect(file?.originalContent).toBe('old code');
    expect(file?.currentContent).toBe('disk content');
  });

  it('omits currentContent snapshot when only originalContent is provided (legacy diff path)', async () => {
    const { usePreviewStore } = await import('./previewStore');
    usePreviewStore.setState({ diffFiles: [], activeDiffPath: null });
    readFileMock.mockResolvedValue('disk content');

    await usePreviewStore.getState().openFile('src/app.ts', {
      originalContent: 'old code',
    });

    const file = usePreviewStore.getState().diffFiles[0];
    expect(file?.source).toBe('disk');
    expect(file?.currentContent).toBe('disk content');
  });
});
