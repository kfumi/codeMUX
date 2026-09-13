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

vi.mock('../../lib/browserVisibility', () => ({
  applyBrowserVisibility: vi.fn(),
  hideAllBrowserHosts: vi.fn(),
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

vi.mock('../ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipHint: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { SidePanel } from './SidePanel';
import { useDaemonConnectionStore } from '../../stores/daemonConnectionStore';

/** jsdom 默认没有 matchMedia,窄屏判定会退化为按 innerWidth 比较(与实现一致)。 */
function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: undefined });
}

function panelElement(): HTMLElement {
  return document.querySelector('aside') as HTMLElement;
}

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
    // 内置浏览器宿主是壳独占能力:壳内才提供入口。
    useDaemonConnectionStore.setState({ hostForm: 'desktop' });
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

  it('hides the built-in browser entry outside the desktop shell', () => {
    useDaemonConnectionStore.setState({ hostForm: 'browser' });
    const previousTabs = sidePanelState.tabs;
    const previousActiveTabId = sidePanelState.activeTabId;
    sidePanelState.tabs = [];
    sidePanelState.activeTabId = null;

    try {
      render(<SidePanel projectPath={null} scopeId="session-a" />);
      expect(screen.queryByRole('button', { name: '浏览器' })).toBeNull();
      expect(screen.getByRole('button', { name: '审查' })).toBeTruthy();
    } finally {
      sidePanelState.tabs = previousTabs;
      sidePanelState.activeTabId = previousActiveTabId;
      useDaemonConnectionStore.setState({ hostForm: 'desktop' });
    }
  });
});

describe('SidePanel 占位', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    sidePanelState.isOpen = true;
    sidePanelState.isExpanded = false;
    setViewportWidth(1024);
  });

  it('窄屏且面板已关闭时不占内容区', () => {
    setViewportWidth(390);
    sidePanelState.isOpen = false;

    render(<SidePanel projectPath="D:/project/app" scopeId="session-a" />);

    expect(panelElement().style.width).toBe('0px');
    expect(panelElement().className).not.toContain('w-full');
  });

  it('窄屏且面板已打开时占满内容区', () => {
    setViewportWidth(390);
    sidePanelState.isOpen = true;

    render(<SidePanel projectPath="D:/project/app" scopeId="session-a" />);

    expect(panelElement().style.width).toBe('100%');
    expect(panelElement().className).toContain('absolute');
    expect(panelElement().className).toContain('w-full');
  });

  it('宽屏保持分栏宽度', () => {
    setViewportWidth(1280);
    sidePanelState.isOpen = true;
    sidePanelState.isExpanded = false;

    render(<SidePanel projectPath="D:/project/app" scopeId="session-a" />);

    expect(panelElement().style.width).toBe('520px');
    expect(panelElement().className).toContain('shrink-0');
    expect(panelElement().className).not.toContain('w-full');
  });

  it('宽屏展开预览时占满内容区', () => {
    setViewportWidth(1280);
    sidePanelState.isOpen = true;
    sidePanelState.isExpanded = true;

    render(<SidePanel projectPath="D:/project/app" scopeId="session-a" />);

    expect(panelElement().style.width).toBe('100%');
    expect(panelElement().className).toContain('absolute');
  });

  it('关闭的面板即便残留展开标记也不占内容区', () => {
    setViewportWidth(1280);
    sidePanelState.isOpen = false;
    sidePanelState.isExpanded = true;

    render(<SidePanel projectPath="D:/project/app" scopeId="session-a" />);

    expect(panelElement().style.width).toBe('0px');
    expect(panelElement().className).not.toContain('w-full');
  });
});
