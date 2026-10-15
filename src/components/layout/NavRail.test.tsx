// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NAV_RAIL_WIDTH, NavRail, navTargetForView } from './NavRail';
import { TooltipProvider } from '../ui/tooltip';

vi.mock('../../lib/shortcuts/shortcutPlatform', () => ({
  getShortcutPlatform: () => 'win32',
}));

const workTaskState = vi.hoisted(() => ({
  tasks: [] as Array<{ status: string; needsAttention?: boolean }>,
  selectAttentionCount: () => workTaskState.tasks.filter((t) => t.needsAttention).length,
}));

vi.mock('../../stores/workTaskStore', () => ({
  useWorkTaskStore: (selector: (state: unknown) => unknown) => selector({ tasks: workTaskState.tasks }),
  selectAttentionCount: workTaskState.selectAttentionCount,
}));

// 移动伴侣那一格会去轮询 daemon；图标轨的测试只关心排布，状态由 ProxyRailStatus /
// CompanionRailButton 各自的测试覆盖（口径与 SessionList.test 一致）。
vi.mock('../../hooks/useCompanionStatus', () => ({
  useCompanionStatus: () => ({
    status: null,
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

const select = vi.fn();

function renderRail(activeTarget: Parameters<typeof NavRail>[0]['activeTarget'] = 'app') {
  return render(
    <TooltipProvider>
      <NavRail activeTarget={activeTarget} onSelect={select} />
    </TooltipProvider>,
  );
}

describe('NavRail', () => {
  beforeEach(() => {
    select.mockClear();
    workTaskState.tasks = [];
  });

  afterEach(() => cleanup());

  it('carries the three top-level views, then the status row, and pins settings at the bottom', () => {
    renderRail();

    const nav = screen.getByRole('navigation', { name: '主导航' });
    expect(nav).toBeTruthy();
    // 宽度对齐 Codex 实测的约 56px。
    expect((nav as HTMLElement).style.width).toBe(`${NAV_RAIL_WIDTH}px`);

    for (const label of ['会话', '自动化', '工单', '移动伴侣', '设置']) {
      expect(screen.getByRole('button', { name: label }), label).toBeTruthy();
    }

    // 底部三格从下往上：设置（最后）、移动伴侣、Proxy 状态灯；前面一段弹性空隙把整组压到底部。
    const buttons = Array.from(nav.querySelectorAll('button'));
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      '会话',
      '自动化',
      '工单',
      '移动伴侣',
      '设置',
    ]);
    expect(buttons[3].previousElementSibling?.getAttribute('role')).toBe('status');
    expect(buttons[3].previousElementSibling?.previousElementSibling?.className).toContain('flex-1');
  });

  it('reports the clicked target', () => {
    renderRail();

    fireEvent.click(screen.getByRole('button', { name: '自动化' }));
    expect(select).toHaveBeenCalledWith('automation');
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(select).toHaveBeenCalledWith('settings');
  });

  it('marks exactly the active view with aria-current', () => {
    renderRail('todo');

    expect(screen.getByRole('button', { name: '工单' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: '会话' }).getAttribute('aria-current')).toBeNull();
  });

  it('badges the work-item rail only when something needs attention', () => {
    renderRail();
    expect(screen.getByRole('button', { name: '工单' }).textContent).toBe('');

    workTaskState.tasks = [{ status: 'running', needsAttention: true }, { status: 'done' }];
    renderRail();

    expect(screen.getAllByRole('button', { name: '工单' })[1].textContent).toBe('1');
  });

  it('maps the navigation store view straight onto a rail target', () => {
    expect(navTargetForView('app')).toBe('app');
    expect(navTargetForView('automation')).toBe('automation');
    expect(navTargetForView('todo')).toBe('todo');
    expect(navTargetForView('settings')).toBe('settings');
  });
});
