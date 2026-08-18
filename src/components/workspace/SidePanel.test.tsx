// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const terminalPanelMock = vi.hoisted(() => vi.fn(() => <div data-testid="terminal-panel" />));
const sidePanelState = vi.hoisted(() => ({
  isOpen: true,
  isExpanded: false,
  panelWidth: 520,
  isResizing: false,
  tabs: [{
    id: 'session-a:terminal:D:/project/app',
    kind: 'terminal' as const,
    title: '终端',
    projectPath: 'D:/project/app',
    terminalId: 'terminal-a',
  }],
  activeTabId: 'session-a:terminal:D:/project/app',
  setPanelWidth: vi.fn(),
  setResizing: vi.fn(),
  setActiveTab: vi.fn(),
  closeTab: vi.fn(),
  closePanel: vi.fn(),
  toggleExpanded: vi.fn(),
  openReviewTab: vi.fn(),
  openTerminalTab: vi.fn(),
  setScope: vi.fn(),
}));

vi.mock('../../lib/layoutPreferences', () => ({
  readLayoutPreferences: () => ({ sidePanelRatio: null }),
  updateLayoutPreferences: vi.fn(),
}));

vi.mock('../../stores/sidePanelStore', () => ({
  useSidePanelStore: (selector: (state: typeof sidePanelState) => unknown) => selector(sidePanelState),
}));

vi.mock('./terminal/TerminalPanel', () => ({
  TerminalPanel: (props: { terminalId?: string }) => terminalPanelMock(props),
}));

vi.mock('./review/ReviewPanel', () => ({
  ReviewPanel: () => null,
}));

vi.mock('./plan/PlanPreviewPanel', () => ({
  PlanPreviewPanel: () => null,
}));

vi.mock('../preview/DiffView', () => ({
  DiffView: () => null,
}));

vi.mock('../assistant-ui/file-type-icon', () => ({
  FileTypeIcon: () => null,
}));

vi.mock('../ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipHint: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { SidePanel } from './SidePanel';

describe('SidePanel', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('passes the persisted terminal id to the active terminal panel', () => {
    render(<SidePanel projectPath="D:/project/app" scopeId="session-a" />);

    expect(terminalPanelMock).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: 'terminal-a' }),
    );
    expect(screen.getByTestId('terminal-panel')).toBeTruthy();
  });
});
