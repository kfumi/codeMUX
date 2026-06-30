// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReviewPanel } from './ReviewPanel';

const gitApiMock = vi.hoisted(() => ({
  getStatusChanges: vi.fn(),
  getStatusChangeDetail: vi.fn(),
  stageStatusChanges: vi.fn(),
  unstageStatusChanges: vi.fn(),
}));

vi.mock('../../../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/tauri')>('../../../lib/tauri');
  return {
    ...actual,
    gitApi: gitApiMock,
  };
});

vi.mock('../../preview/DiffView', () => ({
  DiffView: () => <div data-testid="diff-view" />,
}));

describe('ReviewPanel staging actions', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    gitApiMock.getStatusChanges.mockResolvedValue([
      {
        path: 'D:/project/app/src/App.tsx',
        status: 'modified',
        originalContent: null,
        currentContent: '',
        additions: 2,
        deletions: 1,
      },
    ]);
    gitApiMock.stageStatusChanges.mockResolvedValue(undefined);
    gitApiMock.unstageStatusChanges.mockResolvedValue(undefined);
  });

  it('stages all unstaged files and refreshes the review list', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('App.tsx');
    fireEvent.click(screen.getByRole('button', { name: '全部暂存' }));

    await waitFor(() => expect(gitApiMock.stageStatusChanges).toHaveBeenCalledWith('D:/project/app', undefined));
    await waitFor(() => expect(gitApiMock.getStatusChanges).toHaveBeenCalledTimes(2));
  });

  it('stages a single unstaged file', async () => {
    render(<ReviewPanel projectPath="D:/project/app" />);

    await screen.findByText('App.tsx');
    fireEvent.click(screen.getByRole('button', { name: '暂存 App.tsx' }));

    await waitFor(() => expect(gitApiMock.stageStatusChanges).toHaveBeenCalledWith('D:/project/app', 'D:/project/app/src/App.tsx'));
  });
});
