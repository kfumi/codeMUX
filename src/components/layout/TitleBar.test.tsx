// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { CSSProperties } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsStore } from '../../stores/settingsStore';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { useTerminalDockStore } from '../../stores/terminalDockStore';
import type { AppConfig } from '../../types/provider';
import { TitleBar } from './TitleBar';
import { TooltipProvider } from '../ui/tooltip';

// 平台固定成 win32：断言的 aria 键名才与运行机器无关。
vi.mock('../../lib/shortcuts/shortcutPlatform', () => ({
  getShortcutPlatform: () => 'win32',
}));

// 只测标题栏右侧的侧面板开关；窗口控件按钮由宿主能力决定，这里关掉。
vi.mock('../../hooks/useHostCapabilities', () => ({
  useHostCapabilities: () => ({ presentation: { windowControls: false }, has: () => false }),
}));

function setKeybindings(keybindings: Record<string, string | null>) {
  useSettingsStore.setState({
    config: { keybindings } as unknown as AppConfig,
  } as Partial<ReturnType<typeof useSettingsStore.getState>>);
}

function panelToggle() {
  return document.querySelector('button[aria-label="展开右侧面板"]');
}

function renderTitleBar() {
  render(
    <TooltipProvider>
      <TitleBar />
    </TooltipProvider>,
  );
}
describe('TitleBar 的侧面板开关', () => {
  beforeEach(() => {
    useSidePanelStore.setState({ isOpen: false });
    setKeybindings({});
  });

  afterEach(() => {
    cleanup();
  });

  it('把当前键位写进 aria-keyshortcuts', () => {
    renderTitleBar();

    expect(panelToggle()).toBeTruthy();
    expect(panelToggle()?.getAttribute('aria-keyshortcuts')).toBe('Control+J');
  });

  it('命令被解绑后不再写 aria-keyshortcuts', () => {
    setKeybindings({ toggleSidePanel: null });
    renderTitleBar();

    expect(panelToggle()?.hasAttribute('aria-keyshortcuts')).toBe(false);
  });
});

describe('TitleBar 的顶栏分段', () => {
  beforeEach(() => {
    useSidePanelStore.setState({ isOpen: false });
    setKeybindings({});
  });

  afterEach(() => {
    cleanup();
  });

  function renderSplit(options: { splitAtSidebar?: boolean; sidebarResizing?: boolean } = {}) {
    return render(
      <div style={{ '--titlebar-split': '356px' } as CSSProperties}>
        <TooltipProvider>
          <TitleBar
            leftContent={<span>nav</span>}
            rightContent={<span>header</span>}
            {...options}
          />
        </TooltipProvider>
      </div>,
    );
  }

  it('在侧栏边界画一条上下留白的短分割线，并让标题内容从线右侧开始', () => {
    const { container } = renderSplit({ splitAtSidebar: true });

    const divider = container.querySelector<HTMLElement>('[data-titlebar-split-divider]');
    expect(divider).toBeTruthy();
    expect(divider?.style.left).toBe('var(--titlebar-split)');
    // 不顶满高度：48px 标题栏里上下各留 10px；2px 宽、半透明 ink，比侧栏
    // 那条发丝线更醒目。
    expect(divider?.className).toContain('top-2.5');
    expect(divider?.className).toContain('bottom-2.5');
    expect(divider?.className).toContain('w-0.5');
    expect(divider?.className).toContain('bg-[hsl(var(--foreground)/0.2)]');
    expect(divider?.className).toContain('pointer-events-none');

    const leftRegion = container.querySelector<HTMLElement>('[data-titlebar-left-region]');
    expect(leftRegion?.style.width).toBe('var(--titlebar-split)');
  });

  it('拖拽侧栏时关掉分段宽度过渡，避免分割线落后', () => {
    const { container } = renderSplit({ splitAtSidebar: true, sidebarResizing: true });

    const leftRegion = container.querySelector<HTMLElement>('[data-titlebar-left-region]');
    expect(leftRegion?.className).toContain('transition-none');
  });

  it('不分段时不画短分割线', () => {
    const { container } = renderSplit();

    expect(container.querySelector('[data-titlebar-split-divider]')).toBeNull();
    const leftRegion = container.querySelector<HTMLElement>('[data-titlebar-left-region]');
    expect(leftRegion?.style.width).toBe('');
  });
});

describe('TitleBar 的底部终端开关', () => {
  const PROJECT = 'D:/project/app';

  beforeEach(() => {
    useTerminalDockStore.getState().reset();
    setKeybindings({});
  });

  afterEach(() => {
    cleanup();
    useTerminalDockStore.getState().reset();
  });

  it('把当前键位写进 aria-keyshortcuts', () => {
    render(
      <TooltipProvider>
        <TitleBar projectOpenPath={PROJECT} />
      </TooltipProvider>,
    );

    const button = document.querySelector('button[aria-label="展开底部终端"]');
    expect(button).toBeTruthy();
    expect(button?.getAttribute('aria-keyshortcuts')).toBe('Control+`');
  });

  it('排在右侧面板开关之前（对齐 ZCode 的头部顺序）', () => {
    render(
      <TooltipProvider>
        <TitleBar projectOpenPath={PROJECT} />
      </TooltipProvider>,
    );

    const buttons = Array.from(document.querySelectorAll('button[aria-label]'));
    const terminalIndex = buttons.findIndex((button) => button.getAttribute('aria-label') === '展开底部终端');
    const panelIndex = buttons.findIndex((button) => button.getAttribute('aria-label') === '展开右侧面板');

    expect(terminalIndex).toBeGreaterThanOrEqual(0);
    expect(panelIndex).toBeGreaterThanOrEqual(0);
    expect(terminalIndex).toBeLessThan(panelIndex);
  });

  it('底部终端展开时按钮呈选中态', () => {
    render(
      <TooltipProvider>
        <TitleBar projectOpenPath={PROJECT} />
      </TooltipProvider>,
    );

    const closed = document.querySelector('button[aria-label="展开底部终端"]');
    expect(closed?.getAttribute('aria-pressed')).toBe('false');
    expect(closed?.className).not.toContain('chrome-bg-hover');

    act(() => {
      useTerminalDockStore.setState({ isOpen: true });
    });

    const open = document.querySelector('button[aria-label="收起底部终端"]');
    expect(open?.getAttribute('aria-pressed')).toBe('true');
    expect(open?.className).toContain('chrome-bg-hover');
  });

  it('点击后打开底部终端并为该项目建一条会话', () => {
    render(
      <TooltipProvider>
        <TitleBar projectOpenPath={PROJECT} />
      </TooltipProvider>,
    );

    fireEvent.click(document.querySelector('button[aria-label="展开底部终端"]')!);

    expect(useTerminalDockStore.getState().isOpen).toBe(true);
    expect(useTerminalDockStore.getState().workspaces[PROJECT].sessionIds).toHaveLength(1);
  });
});
