// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProxyRailStatus } from './ProxyRailStatus';
import { TooltipProvider } from '../ui/tooltip';

const settingsState = vi.hoisted(() => ({
  proxyRunning: false,
  proxyUrl: null as string | null,
}));

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
}));

function renderStatus() {
  return render(
    <TooltipProvider>
      <ProxyRailStatus />
    </TooltipProvider>,
  );
}

describe('ProxyRailStatus', () => {
  afterEach(() => {
    cleanup();
    settingsState.proxyRunning = false;
    settingsState.proxyUrl = null;
  });

  it('未运行时读作「Proxy 未运行」，图标是次级文字色', () => {
    renderStatus();

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-label')).toBe('Proxy 未运行');
    // 与图标轨其余格子同一套尺寸，图标颜色承担状态。
    expect(status.className).toContain('h-10');
    expect(status.className).toContain('w-10');
    expect(status.className).toContain('text-muted-foreground');
  });

  it('运行时把端口写进标签，图标转成功色', () => {
    settingsState.proxyRunning = true;
    settingsState.proxyUrl = 'http://127.0.0.1:4312';
    renderStatus();

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-label')).toBe('Proxy 运行中 · :4312');
    expect(status.className).toContain('text-[hsl(var(--success-vivid))]');
  });

  it('状态是只读的：可聚焦、可读，但不是按钮', () => {
    renderStatus();

    const status = screen.getByRole('status');
    // 键盘用户要能聚焦它才读得到 tooltip。
    expect(status.getAttribute('tabindex')).toBe('0');
    expect(status.tagName).toBe('SPAN');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
