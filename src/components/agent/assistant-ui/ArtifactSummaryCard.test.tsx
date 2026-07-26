// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const revertTurnArtifactMock = vi.fn<(sessionId: string, artifactId: string) => Promise<unknown>>();
const openFileMock = vi.fn();

vi.mock('../../../stores/agentStore', () => ({
  useAgentStore: {
    getState: () => ({
      revertTurnArtifact: revertTurnArtifactMock,
    }),
  },
}));

vi.mock('../../../stores/previewStore', () => ({
  usePreviewStore: {
    getState: () => ({
      openFile: openFileMock,
    }),
  },
}));

vi.mock('../../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  serializeError: (error: unknown) => error,
}));

import type { TurnArtifact } from '../../../lib/tauri';
import { ArtifactSummaryCard } from './ArtifactSummaryCard';

function makeArtifact(overrides: Partial<TurnArtifact> = {}): TurnArtifact {
  return {
    id: 'artifact-1',
    appSessionId: 'session-1',
    turnOrdinal: 1,
    projectPath: 'D:\\project',
    summary: {
      schemaVersion: 1,
      files: [],
      reverted: false,
      totalAdditions: 0,
      totalDeletions: 0,
    },
    createdAt: '2026-07-27T00:00:00Z',
    ...overrides,
  };
}

function withFiles(files: TurnArtifact['summary']['files'], reverted = false): TurnArtifact {
  return makeArtifact({
    summary: {
      schemaVersion: 1,
      files,
      reverted,
      totalAdditions: files.reduce((s, f) => s + f.additions, 0),
      totalDeletions: files.reduce((s, f) => s + f.deletions, 0),
    },
  });
}

describe('ArtifactSummaryCard', () => {
  beforeEach(() => {
    revertTurnArtifactMock.mockReset();
    openFileMock.mockReset();
    revertTurnArtifactMock.mockResolvedValue({ status: 'conflict', conflicts: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders collapsed card with file count and +/- stats (CARD1)', () => {
    const artifact = withFiles([
      { path: 'src/a.ts', status: 'modified', additions: 5, deletions: 2, original: 'old', current: 'new', contentAvailable: true },
      { path: 'src/b.ts', status: 'added', additions: 10, deletions: 0, original: null, current: 'new', contentAvailable: true },
    ]);
    render(<ArtifactSummaryCard artifact={artifact} sessionId="session-1" />);

    expect(screen.getByText('2 个文件')).toBeTruthy();
    expect(screen.getByText('+15')).toBeTruthy();
    expect(screen.getByText('-2')).toBeTruthy();
    // File rows hidden by default
    expect(screen.queryByText('src/a.ts')).toBeNull();
    // Header revert button visible while collapsed
    expect(screen.getByText('撤销')).toBeTruthy();
  });

  it('expands to list files with path, status, +/- on click (ROW1)', () => {
    const artifact = withFiles([
      { path: 'src/a.ts', status: 'modified', additions: 5, deletions: 2, original: 'old', current: 'new', contentAvailable: true },
      { path: 'src/b.ts', status: 'added', additions: 10, deletions: 0, original: null, current: 'new', contentAvailable: true },
    ]);
    render(<ArtifactSummaryCard artifact={artifact} sessionId="session-1" />);

    // Click the chevron toggle button (first button in the card).
    const toggleBtn = screen.getByLabelText('展开');
    fireEvent.click(toggleBtn);

    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.getByText('src/b.ts')).toBeTruthy();
    expect(screen.getByText('修改')).toBeTruthy();
    expect(screen.getByText('新增')).toBeTruthy();
  });

  it('opens preview with artifact source when clicking a file (DIFF1)', () => {
    const artifact = withFiles([
      { path: 'src/a.ts', status: 'modified', additions: 5, deletions: 2, original: 'old', current: 'new', contentAvailable: true },
    ]);
    render(<ArtifactSummaryCard artifact={artifact} sessionId="session-1" />);

    fireEvent.click(screen.getByLabelText('展开'));
    fireEvent.click(screen.getByText('src/a.ts'));

    expect(openFileMock).toHaveBeenCalledWith('src/a.ts', {
      source: 'artifact',
      originalContent: 'old',
      currentContent: 'new',
    });
  });

  it('does not open preview when contentAvailable is false (SIZ1)', () => {
    const artifact = withFiles([
      { path: 'bin/large.bin', status: 'modified', additions: 0, deletions: 0, original: null, current: null, contentAvailable: false },
    ]);
    render(<ArtifactSummaryCard artifact={artifact} sessionId="session-1" />);

    fireEvent.click(screen.getByLabelText('展开'));
    fireEvent.click(screen.getByText('bin/large.bin'));

    expect(openFileMock).not.toHaveBeenCalled();
  });

  it('disables revert and shows 已撤销 tag when reverted=true (V2/AFTER1)', () => {
    const artifact = withFiles(
      [{ path: 'src/a.ts', status: 'modified', additions: 5, deletions: 2, original: 'old', current: 'new', contentAvailable: true }],
      true,
    );
    render(<ArtifactSummaryCard artifact={artifact} sessionId="session-1" />);

    // Reverted state: "已撤销" tag rendered, no "撤销" button.
    expect(screen.getByText('已撤销')).toBeTruthy();
    expect(screen.queryByText('撤销')).toBeNull();
  });

  it('calls revertTurnArtifact on confirm and transitions to reverted state (UNDO1)', async () => {
    const revertedArtifact = withFiles(
      [{ path: 'src/a.ts', status: 'modified', additions: 5, deletions: 2, original: 'old', current: 'new', contentAvailable: true }],
      true,
    );
    revertTurnArtifactMock.mockResolvedValueOnce({ status: 'reverted', artifact: revertedArtifact });

    const artifact = withFiles([
      { path: 'src/a.ts', status: 'modified', additions: 5, deletions: 2, original: 'old', current: 'new', contentAvailable: true },
    ]);
    render(<ArtifactSummaryCard artifact={artifact} sessionId="session-1" />);

    fireEvent.click(screen.getByText('撤销'));
    fireEvent.click(screen.getByText('确认'));

    await waitFor(() => {
      expect(revertTurnArtifactMock).toHaveBeenCalledWith('session-1', 'artifact-1');
    });
    await waitFor(() => {
      expect(screen.getByText('已撤销')).toBeTruthy();
    });
  });

  it('shows conflict reasons when revert fails and keeps revert button enabled (RF2)', async () => {
    revertTurnArtifactMock.mockResolvedValueOnce({
      status: 'conflict',
      conflicts: [
        { path: 'src/a.ts', reason: '文件已被后续修改，无法安全撤销' },
      ],
    });

    const artifact = withFiles([
      { path: 'src/a.ts', status: 'modified', additions: 5, deletions: 2, original: 'old', current: 'new', contentAvailable: true },
    ]);
    render(<ArtifactSummaryCard artifact={artifact} sessionId="session-1" />);

    fireEvent.click(screen.getByText('撤销'));
    fireEvent.click(screen.getByText('确认'));

    await waitFor(() => {
      expect(screen.getByText(/文件已被后续修改/)).toBeTruthy();
    });
    // Revert button still present (not reverted)
    expect(screen.getByText('撤销')).toBeTruthy();
  });

  it('renders nothing when files list is empty (E1)', () => {
    const { container } = render(<ArtifactSummaryCard artifact={makeArtifact()} sessionId="session-1" />);
    expect(container.firstChild).toBeNull();
  });
});
