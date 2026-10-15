// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CompanionRailButton } from './CompanionRailButton';
import { TooltipProvider } from '../ui/tooltip';

const companionState = vi.hoisted(() => ({
  status: null as null | { enabled: boolean; paired: boolean },
}));

vi.mock('../../hooks/useCompanionStatus', () => ({
  useCompanionStatus: () => ({
    status: companionState.status,
    loading: false,
    busy: false,
    error: null,
    loadStatus: vi.fn(),
    setEnabled: vi.fn(),
    refreshPairingCode: vi.fn(),
    setRelayEnabled: vi.fn(),
    setRelayConfig: vi.fn(),
  }),
}));

function renderButton() {
  return render(
    <TooltipProvider>
      <CompanionRailButton />
    </TooltipProvider>,
  );
}

describe('CompanionRailButton', () => {
  afterEach(() => {
    cleanup();
    companionState.status = null;
  });

  it('占图标轨一格，悬停档取窗口面那一档而不是侧栏的', () => {
    renderButton();

    const button = screen.getByRole('button', { name: '移动伴侣' });
    // 与图标轨其余按钮同一套尺寸 / 圆角 / 平面 token。
    expect(button.className).toContain('h-10');
    expect(button.className).toContain('w-10');
    expect(button.className).toContain('hover:bg-[hsl(var(--chrome-bg-hover))]');
    expect(button.className).not.toContain('--sidebar-muted');
    // 焦点环的外偏移底色也是窗口面。
    expect(button.className).toContain('ring-offset-[hsl(var(--chrome-bg))]');
  });

  it('图标颜色承担状态：未启用是次级色', () => {
    renderButton();

    expect(screen.getByRole('button', { name: '移动伴侣' }).className).toContain(
      'text-muted-foreground',
    );
  });
});
