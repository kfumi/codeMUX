// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDaemonConnectionStore } from '../../stores/daemonConnectionStore';
import { NarrowNavFooter } from './NarrowNavFooter';

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

// 页脚测试关心的是入口本身，配对弹层由 CompanionDialog 自己的用例覆盖。
vi.mock('../companion/CompanionDialog', () => ({
  CompanionDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="companion-dialog" /> : null,
}));

const settingsState = vi.hoisted(() => ({
  proxyRunning: false,
  proxyUrl: null as string | null,
}));

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
}));

const select = vi.fn();

function renderFooter(activeTarget: Parameters<typeof NarrowNavFooter>[0]['activeTarget'] = 'app') {
  return render(<NarrowNavFooter activeTarget={activeTarget} onSelect={select} />);
}

describe('NarrowNavFooter', () => {
  beforeEach(() => {
    useDaemonConnectionStore.setState({ hostForm: 'desktop' });
  });

  afterEach(() => {
    cleanup();
    companionState.status = null;
    settingsState.proxyRunning = false;
    settingsState.proxyUrl = null;
    select.mockClear();
  });

  it('hosts the rail bottom trio with settings pinned at the bottom', () => {
    renderFooter();

    const rows = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(rows).toEqual(['移动伴侣', '设置']);
    // Proxy 是只读状态，不是按钮；它排在页脚最上一行，设置钉在最下面
    // —— 与图标轨底部三格的顺序一致。
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-label')).toBe('Proxy 未运行');
    expect(status.compareDocumentPosition(screen.getByRole('button', { name: '设置' }))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('renders the accessory row at the top of the footer cluster', () => {
    render(
      <NarrowNavFooter
        activeTarget="app"
        onSelect={select}
        accessory={<button aria-label="更新">更新</button>}
      />,
    );

    const update = screen.getByRole('button', { name: '更新' });
    expect(update.compareDocumentPosition(screen.getByRole('status'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(update.compareDocumentPosition(screen.getByRole('button', { name: '设置' }))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('opens the companion dialog from the footer row', () => {
    renderFooter();

    expect(screen.queryByTestId('companion-dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '移动伴侣' }));
    expect(screen.queryByTestId('companion-dialog')).toBeTruthy();
  });

  it('routes the settings row back through the same nav-rail callback', () => {
    renderFooter();

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(select).toHaveBeenCalledWith('settings');
  });

  it('drops the companion row outside the desktop shell, keeping settings', () => {
    useDaemonConnectionStore.setState({ hostForm: 'browser' });
    renderFooter();

    expect(screen.queryByRole('button', { name: '移动伴侣' })).toBeNull();
    expect(screen.getByRole('button', { name: '设置' })).toBeTruthy();
  });

  it('marks the settings row as current while the settings view is active', () => {
    renderFooter('settings');

    expect(screen.getByRole('button', { name: '设置' }).className).toContain(
      'bg-[hsl(var(--sidebar-muted))]',
    );
  });

  it('brings back the port text the 56px rail had to drop', () => {
    settingsState.proxyRunning = true;
    settingsState.proxyUrl = 'http://127.0.0.1:4312';
    renderFooter();

    // 抽屉里放得下文字，端口号不再只活在 tooltip 里。
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-label')).toBe('Proxy 运行中 · :4312');
    expect(status.textContent).toBe('Proxy 运行中 · :4312');
    expect(status.querySelector('svg')?.getAttribute('class')).toContain('text-[hsl(var(--success))]');
  });

  it('sits on the sidebar surface: hover uses the sidebar tier, not the chrome tier', () => {
    renderFooter();

    // 这三行压在**侧栏面**上，悬停档取侧栏那一档；图标轨的 `--chrome-bg-hover`
    // 是窗口面的悬停色，用在这里只差几级，等于没按。
    expect(screen.getByRole('button', { name: '设置' }).className).toContain(
      'hover:bg-[hsl(var(--sidebar-muted))]/82',
    );
    expect(screen.getByRole('button', { name: '设置' }).className).not.toContain('--chrome-bg-hover');
  });
});
