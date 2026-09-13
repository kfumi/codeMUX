// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDaemonConnectionStore } from '../../stores/daemonConnectionStore';

const { setBrowserControl, clearData } = vi.hoisted(() => ({
  setBrowserControl: vi.fn(),
  clearData: vi.fn(),
}));

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: {
    config: { browser: { enabled: boolean; ignore_certificate_errors: boolean } };
    setBrowserControl: typeof setBrowserControl;
  }) => unknown) => selector({
    config: { browser: { enabled: false, ignore_certificate_errors: false } },
    setBrowserControl,
  }),
}));

vi.mock('../../lib/facades/shell-facade', () => ({
  shellFacade: {
    browser: { clearData },
  },
}));

import { BrowserControlSettings } from './BrowserControlSettings';

describe('BrowserControlSettings', () => {
  beforeEach(() => {
    // 壳内 WebView 的数据清理是壳独占能力,默认按桌面壳形态断言。
    useDaemonConnectionStore.setState({ hostForm: 'desktop' });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('persists the reserved agent-control toggle without clearing data', () => {
    render(<BrowserControlSettings />);
    fireEvent.click(screen.getByRole('switch', { name: '开启内置浏览器控制' }));
    expect(setBrowserControl).toHaveBeenCalledWith({
      enabled: true,
      ignore_certificate_errors: false,
    });
    expect(clearData).not.toHaveBeenCalled();
  });

  it('does not clear all browser data when the confirmation is cancelled', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<BrowserControlSettings />);
    fireEvent.click(screen.getByRole('button', { name: '清除全部' }));
    expect(clearData).not.toHaveBeenCalled();
  });

  it('浏览器形态隐藏壳内 WebView 的数据清理,只保留 daemon 侧开关', () => {
    useDaemonConnectionStore.setState({ hostForm: 'browser' });

    render(<BrowserControlSettings />);

    expect(screen.getByRole('switch', { name: '开启内置浏览器控制' })).toBeTruthy();
    expect(screen.queryByText('浏览器数据')).toBeNull();
    expect(screen.queryByRole('button', { name: '清除全部' })).toBeNull();
  });
});
