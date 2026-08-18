// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gitApiMock = vi.hoisted(() => ({
  getRepositoryState: vi.fn(),
  getStatusChanges: vi.fn(),
}));
const openReviewTabMock = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/tauri')>('../../../lib/tauri');
  return {
    ...actual,
    gitApi: gitApiMock,
  };
});

vi.mock('../../../stores/sidePanelStore', () => ({
  useSidePanelStore: (selector: (state: { openReviewTab: typeof openReviewTabMock }) => unknown) =>
    selector({ openReviewTab: openReviewTabMock }),
}));

vi.mock('./GitBranchDialog', () => ({
  GitBranchDialog: () => null,
}));

import { GitEnvironmentPopover } from './GitEnvironmentPopover';

describe('GitEnvironmentPopover', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    gitApiMock.getRepositoryState.mockResolvedValue({
      currentBranch: 'feat/mobile-companion',
      branches: [
        { name: 'master', current: false },
        { name: 'feat/mobile-companion', current: true },
      ],
      detached: false,
      hasUncommittedChanges: true,
      aheadCount: 0,
      hasUnpushedCommits: false,
    });
    gitApiMock.getStatusChanges.mockResolvedValue([
      { additions: 34376, deletions: 2509 },
      { additions: 4, deletions: 2 },
    ]);
  });

  it('shows environment totals and opens the review panel from the changes row', async () => {
    render(<GitEnvironmentPopover projectPath="D:/project/app" />);

    fireEvent.click(screen.getByTestId('git-environment-trigger'));

    await screen.findByText('环境信息');
    expect(screen.getByText('+34,380')).toBeTruthy();
    expect(screen.getByText('-2,511')).toBeTruthy();

    fireEvent.click(screen.getByTestId('git-environment-changes'));

    expect(openReviewTabMock).toHaveBeenCalledWith('D:/project/app');
  });

  it('opens the branch selector from the environment panel', async () => {
    render(<GitEnvironmentPopover projectPath="D:/project/app" />);

    fireEvent.click(screen.getByTestId('git-environment-trigger'));
    await screen.findByText('feat/mobile-companion');
    fireEvent.click(screen.getByTestId('git-environment-branch'));

    await waitFor(() => expect(screen.getByPlaceholderText('搜索分支')).toBeTruthy());
    expect(screen.getByText('master')).toBeTruthy();
  });
});
