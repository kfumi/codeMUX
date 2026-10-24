// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const terminalPanelMock = vi.hoisted(() => vi.fn(() => <div data-testid="terminal-panel" />));
const browserPanelMock = vi.hoisted(() => vi.fn(() => null));
const sidePanelState = vi.hoisted(() => ({
  isOpen: true,
  isExpanded: false,
  conversationActive: false,
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
      conversationActive: false,
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
  activateConversationTab: vi.fn(),
  openReviewTab: vi.fn(),
  openTerminalTab: vi.fn(),
  openBrowserTab: vi.fn(),
  setScope: vi.fn(),
}));

const sessionStoreState = vi.hoisted(() => ({
  sessions: [{ id: 'session-a', title: '重构侧面板' }],
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

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: (selector: (state: typeof sessionStoreState) => unknown) => selector(sessionStoreState),
}));

vi.mock('./terminal/TerminalPanel', () => ({
  TerminalPanel: (props: { terminalId?: string }) => terminalPanelMock(props),
}));

vi.mock('../browser/BrowserPanel', () => ({
  BrowserPanel: (props: { isActive?: boolean }) => browserPanelMock(props),
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
import { applyBrowserVisibility } from '../../lib/browserVisibility';
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
    sidePanelState.isResizing = false;
    sidePanelState.isExpanded = false;
    sidePanelState.conversationActive = false;
    setViewportWidth(1024);
  });

  it('完整视图下渲染固定「对话」标签:第一位、不可关闭、点击激活对话 surface', () => {
    sidePanelState.isExpanded = true;
    render(<SidePanel projectPath="D:/project/app" scopeId="session-a" />);

    const conversationTab = screen.getByTestId('side-panel-conversation-tab');
    expect(conversationTab.textContent).toContain('重构侧面板');
    // 固定第一位:它是 tab 滚动容器的第一个子元素,排在终端标签之前。
    expect((conversationTab.parentElement as HTMLElement).firstElementChild).toBe(conversationTab);
    expect(screen.getByRole('button', { name: '关闭标签页 终端' })).toBeTruthy();
    // 面板标签的关闭 X 是 role=button 的嵌套控件;对话标签内没有,自身即可点击。
    expect(conversationTab.querySelector('[role="button"]')).toBeNull();

    fireEvent.click(conversationTab);
    expect(sidePanelState.activateConversationTab).toHaveBeenCalledTimes(1);
    expect(sidePanelState.setActiveTab).not.toHaveBeenCalled();
  });

  it('非完整视图不渲染对话标签', () => {
    render(<SidePanel projectPath="D:/project/app" scopeId="session-a" />);

    expect(screen.queryByTestId('side-panel-conversation-tab')).toBeNull();
  });

  it('scope 没有对应会话时不渲染对话标签(草稿态/首页)', () => {
    sidePanelState.isExpanded = true;
    render(<SidePanel projectPath="D:/project/app" scopeId="home" />);

    expect(screen.queryByTestId('side-panel-conversation-tab')).toBeNull();
  });

  it('对话 surface 激活时终端/浏览器标签视为未激活,原生浏览器视图隐藏', () => {
    const previousTabs = sidePanelState.tabs;
    const previousActiveTabId = sidePanelState.activeTabId;
    sidePanelState.tabs = [
      ...sidePanelState.tabs,
      { id: 'session-a:browser:1', kind: 'browser' as const, title: '新标签页' },
    ];
    sidePanelState.activeTabId = 'session-a:browser:1';
    sidePanelState.isExpanded = true;
    sidePanelState.conversationActive = true;

    try {
      render(<SidePanel projectPath="D:/project/app" scopeId="session-a" />);

      expect(screen.getByTestId('side-panel-conversation-tab').dataset.active).toBe('true');
      // 对话 surface 激活时,activeTabId 指向的后台面板标签按未激活渲染,不与对话标签双重高亮。
      const browserTabButton = screen.getByText('新标签页').closest('button');
      expect(browserTabButton?.className).toContain('border-transparent');
      expect(terminalPanelMock).toHaveBeenCalledWith(
        expect.objectContaining({ terminalId: 'terminal-a', isActive: false }),
      );
      expect(browserPanelMock).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: false }),
      );
      expect(applyBrowserVisibility).toHaveBeenCalledWith(null);
    } finally {
      sidePanelState.tabs = previousTabs;
      sidePanelState.activeTabId = previousActiveTabId;
      sidePanelState.conversationActive = false;
    }
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

  it('always shows the tab close button on narrow viewports (no hover on touch)', () => {
    setViewportWidth(390);
    render(<SidePanel projectPath="D:/project/app" scopeId="session-a" />);

    const close = screen.getByRole('button', { name: '关闭标签页 终端' });
    expect(close.className).toContain('opacity-100');
    expect(close.className).not.toContain('opacity-0');
  });

  it('keeps the tab close button hover-only on wide viewports', () => {
    setViewportWidth(1024);
    render(<SidePanel projectPath="D:/project/app" scopeId="session-a" />);

    const close = screen.getByRole('button', { name: '关闭标签页 终端' });
    expect(close.className).toContain('opacity-0');
    expect(close.className).toContain('group-hover:opacity-100');
  });

  it('渲染拖拽遮罩,接管 webview 上方的指针事件', () => {
    sidePanelState.isResizing = true;
    render(<SidePanel projectPath="D:/project/app" scopeId="session-a" />);

    expect(screen.getByTestId('panel-resize-overlay')).toBeTruthy();
  });

  it('把内容区元素经 contentSlotRef 交给布局层(完整视图宿主按它定位)', () => {
    const contentSlotRef = vi.fn();
    render(<SidePanel projectPath="D:/project/app" scopeId="session-a" contentSlotRef={contentSlotRef} />);

    // 挂载即上报:内容区是 tab 栏下方那块区域(带 data 标识),不是面板头。
    const slot = contentSlotRef.mock.calls[0]?.[0] as HTMLElement | undefined;
    expect(slot).toBeInstanceOf(HTMLDivElement);
    expect(slot.hasAttribute('data-side-panel-content-slot')).toBe(true);
    expect(slot.querySelector('[data-testid="terminal-panel"]')).toBeTruthy();
  });

  it('鼠标抬起或窗口失焦都会结束拖拽,避免拖拽卡住', () => {
    render(<SidePanel projectPath="D:/project/app" scopeId="session-a" />);

    fireEvent.mouseDown(screen.getByTestId('side-panel-resize-handle'), { clientX: 600 });
    expect(sidePanelState.setResizing).toHaveBeenCalledWith(true);
    expect(document.documentElement.classList.contains('cmx-panel-resizing')).toBe(true);

    fireEvent.mouseUp(document);
    expect(sidePanelState.setResizing).toHaveBeenLastCalledWith(false);
    expect(document.documentElement.classList.contains('cmx-panel-resizing')).toBe(false);

    sidePanelState.setResizing.mockClear();
    fireEvent.mouseDown(screen.getByTestId('side-panel-resize-handle'), { clientX: 600 });
    fireEvent(window, new Event('blur'));
    expect(sidePanelState.setResizing).toHaveBeenLastCalledWith(false);
    expect(document.documentElement.classList.contains('cmx-panel-resizing')).toBe(false);
  });
});

describe('SidePanel 占位', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    sidePanelState.isOpen = true;
    sidePanelState.isExpanded = false;
    sidePanelState.conversationActive = false;
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
