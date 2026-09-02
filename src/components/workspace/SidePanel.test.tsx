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
  scopes: {
    'session-b': {
      isOpen: true,
      isExpanded: false,
      panelWidth: 520,
      tabs: [{
        id: 'session-b:terminal:D:/project/app',
        kind: 'terminal' as const,
        title: '终端',
        projectPath: 'D:/project/app',
        terminalId: 'terminal-b',
      }],
      activeTabId: 'session-b:terminal:D:/project/app',
    },
  },
  activeTabId: 'session-a:terminal:D:/project/app',
  setPanelWidth: vi.fn(),
  setResizing: vi.fn(),
  setActiveTab: vi.fn(),
  closeTab: vi.fn(),
  closeOtherTabs: vi.fn(),
  closeAllTabs: vi.fn(),
  closePanel: vi.fn(),
  toggleExpanded: vi.fn(),
  openReviewTab: vi.fn(),
  openTerminalTab: vi.fn(),
  openBrowserTab: vi.fn(),
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

vi.mock('../browser/BrowserPanel', () => ({
  BrowserPanel: () => null,
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
    expect(terminalPanelMock).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: 'terminal-b', isActive: false }),
    );
    expect(screen.getAllByTestId('terminal-panel')).toHaveLength(2);
  });

  it('keeps terminal panels mounted but inactive while the side panel is hidden', () => {
    render(<SidePanel projectPath="D:/project/app" scopeId="session-a" isVisible={false} />);

    expect(terminalPanelMock).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: 'terminal-a', isActive: false }),
    );
    expect(screen.getAllByTestId('terminal-panel')).toHaveLength(2);
  });

  it('allows opening the browser empty-state entry without a project', () => {
    const previousTabs = sidePanelState.tabs;
    const previousActiveTabId = sidePanelState.activeTabId;
    sidePanelState.tabs = [];
    sidePanelState.activeTabId = null;

    try {
      render(<SidePanel projectPath={null} scopeId="session-a" />);
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '浏览器' }).disabled).toBe(false);
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '审查' }).disabled).toBe(true);
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '终端' }).disabled).toBe(true);
    } finally {
      sidePanelState.tabs = previousTabs;
      sidePanelState.activeTabId = previousActiveTabId;
    }
  });
});
