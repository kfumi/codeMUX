// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gitApiMock = vi.hoisted(() => ({
  getRepositoryState: vi.fn(),
  getStatusChanges: vi.fn(),
}));

vi.mock('../../../lib/facades/daemon-facade', () => ({
  daemonFacade: { git: gitApiMock },
}));

vi.mock('../../../stores/sessionStore', () => ({
  useSessionStore: (selector: (state: { activeSessionId: string | null }) => unknown) =>
    selector({ activeSessionId: null }),
}));

vi.mock('../../../stores/sidePanelStore', () => ({
  useSidePanelStore: (selector: (state: { openReviewTab: () => void }) => unknown) =>
    selector({ openReviewTab: () => {} }),
}));

vi.mock('./GitBranchDialog', () => ({
  GitBranchDialog: () => null,
}));

import { useSummaryPanelStore } from '../../../stores/summaryPanelStore';
import { SummaryPanelSurface } from './SummaryPanelSurface';

const WIDE = 1600;
const NARROW = 900;

describe('SummaryPanelSurface', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    useSummaryPanelStore.getState().reset();
    gitApiMock.getRepositoryState.mockResolvedValue({
      currentBranch: 'feat/codex-ui-alignment-surfaces',
      branches: [{ name: 'master', current: false }],
      detached: false,
      hasUncommittedChanges: true,
      aheadCount: 0,
      hasUnpushedCommits: false,
    });
    gitApiMock.getStatusChanges.mockResolvedValue([{ additions: 12, deletions: 3 }]);
  });

  it('宽档 + 钉住：浮岛落在对话列右侧，内容就是摘要正文', async () => {
    useSummaryPanelStore.getState().setMetrics({ availableWidth: WIDE, contentWidth: 768 });
    useSummaryPanelStore.getState().setPinned(true);

    render(<SummaryPanelSurface projectPath="D:/project/app" />);

    const surface = screen.getByTestId('summary-panel-surface');
    expect(surface.className).toContain('absolute');
    expect(surface.className).toContain('right-5');
    expect(surface.style.width).toBe('300px');
    expect(await screen.findByText('环境信息')).toBeTruthy();
    expect(screen.getByTestId('git-environment-changes')).toBeTruthy();
  });

  it('窄档（overlay）：不渲染内联面 —— 面板那时挂在标题栏按钮上', () => {
    useSummaryPanelStore.getState().setMetrics({ availableWidth: NARROW, contentWidth: 768 });
    useSummaryPanelStore.getState().setPinned(true);

    render(<SummaryPanelSurface projectPath="D:/project/app" />);

    expect(screen.queryByTestId('summary-panel-surface')).toBeNull();
  });

  it('没有钉住就不占位', () => {
    useSummaryPanelStore.getState().setMetrics({ availableWidth: WIDE, contentWidth: 768 });

    render(<SummaryPanelSurface projectPath="D:/project/app" />);

    expect(screen.queryByTestId('summary-panel-surface')).toBeNull();
  });

  it('没有项目路径就没有摘要可看', () => {
    useSummaryPanelStore.getState().setMetrics({ availableWidth: WIDE, contentWidth: 768 });
    useSummaryPanelStore.getState().setPinned(true);

    render(<SummaryPanelSurface projectPath={null} />);

    expect(screen.queryByTestId('summary-panel-surface')).toBeNull();
  });

  it('宽档里收起钉住后立刻消失', async () => {
    useSummaryPanelStore.getState().setMetrics({ availableWidth: WIDE, contentWidth: 768 });
    useSummaryPanelStore.getState().setPinned(true);

    render(<SummaryPanelSurface projectPath="D:/project/app" />);
    expect(screen.getByTestId('summary-panel-surface')).toBeTruthy();

    useSummaryPanelStore.getState().setPinned(false);
    await waitFor(() => expect(screen.queryByTestId('summary-panel-surface')).toBeNull());
  });
});
