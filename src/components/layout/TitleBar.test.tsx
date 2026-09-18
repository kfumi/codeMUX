// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsStore } from '../../stores/settingsStore';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import type { AppConfig } from '../../types/provider';
import { TitleBar } from './TitleBar';
import { TooltipProvider } from '../ui/tooltip';

// 平台固定成 win32：断言的 aria 键名才与运行机器无关。
vi.mock('../../lib/shortcuts/shortcutPlatform', () => ({
  getShortcutPlatform: () => 'win32',
}));

// 只测标题栏右侧的侧面板开关；窗口控件按钮由宿主能力决定，这里关掉。
vi.mock('../../hooks/useHostCapabilities', () => ({
  useHostCapabilities: () => ({ presentation: { windowControls: false } }),
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
