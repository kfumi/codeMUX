// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockUpdaterState = {
  stage: 'idle' | 'checking' | 'available' | 'latest' | 'downloading' | 'installing' | 'restarting' | 'error';
  version?: string;
  progress?: {
    totalBytes: number | null;
    downloadedBytes: number;
  };
  error?: string;
  checkForUpdates: ReturnType<typeof vi.fn>;
  startUpdate: ReturnType<typeof vi.fn>;
  relaunch: ReturnType<typeof vi.fn>;
  resetToIdle: ReturnType<typeof vi.fn>;
};

let mockUpdaterState: MockUpdaterState;

vi.mock('../UpdaterProvider', () => ({
  useUpdaterContext: () => mockUpdaterState,
}));

describe('UpdateToast', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockUpdaterState = {
      stage: 'idle',
      version: undefined,
      progress: undefined,
      error: undefined,
      checkForUpdates: vi.fn(),
      startUpdate: vi.fn(),
      relaunch: vi.fn(),
      resetToIdle: vi.fn(),
    };
  });

  it('容器组件使用 updater 上下文并以固定浮层方式展示', async () => {
    mockUpdaterState.stage = 'available';
    mockUpdaterState.version = '1.2.3';

    const { UpdateToast } = await import('./UpdateToast');

    render(<UpdateToast />);

    expect(screen.getByText('发现新版本')).toBeTruthy();
    expect(screen.getByText('1.2.3')).toBeTruthy();
    expect(screen.getByText('发现新版本').closest('section')?.className).toContain('fixed');
    expect(screen.getByText('发现新版本').closest('section')?.className).toContain('top-4');
    expect(screen.getByText('发现新版本').closest('section')?.className).toContain('left-1/2');
  });

  it('展示组件在发现可用更新时展示版本与操作按钮', async () => {
    const { UpdateToastContent } = await import('./UpdateToast');

    render(
      <UpdateToastContent
        stage="available"
        version="1.2.3"
        progress={undefined}
        error={undefined}
        onDismiss={mockUpdaterState.resetToIdle}
        onStartUpdate={mockUpdaterState.startUpdate}
        onRetry={mockUpdaterState.checkForUpdates}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '稍后' }));
    fireEvent.click(screen.getByRole('button', { name: '立即更新' }));

    expect(mockUpdaterState.resetToIdle).toHaveBeenCalledTimes(1);
    expect(mockUpdaterState.startUpdate).toHaveBeenCalledTimes(1);
  });

  it('展示组件在错误状态提供关闭与重试动作', async () => {
    const { UpdateToastContent } = await import('./UpdateToast');

    render(
      <UpdateToastContent
        stage="error"
        version={undefined}
        progress={undefined}
        error="network down"
        onDismiss={mockUpdaterState.resetToIdle}
        onStartUpdate={mockUpdaterState.startUpdate}
        onRetry={mockUpdaterState.checkForUpdates}
      />,
    );

    expect(screen.getByText('更新失败')).toBeTruthy();
    expect(screen.getByText('network down')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));

    expect(mockUpdaterState.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(mockUpdaterState.resetToIdle).toHaveBeenCalledTimes(1);
  });

  it('展示组件在最新版本提示中允许关闭', async () => {
    const { UpdateToastContent } = await import('./UpdateToast');

    render(
      <UpdateToastContent
        stage="latest"
        version={undefined}
        progress={undefined}
        error={undefined}
        onDismiss={mockUpdaterState.resetToIdle}
        onStartUpdate={mockUpdaterState.startUpdate}
        onRetry={mockUpdaterState.checkForUpdates}
      />,
    );

    expect(screen.getByText('已经是最新版本')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));

    expect(mockUpdaterState.resetToIdle).toHaveBeenCalledTimes(1);
  });

  it('展示组件在下载阶段展示进度与大小格式且不显示关闭动作', async () => {
    const { UpdateToastContent } = await import('./UpdateToast');

    render(
      <UpdateToastContent
        stage="downloading"
        version="1.2.3"
        progress={{
          totalBytes: 2048,
          downloadedBytes: 1024,
        }}
        error={undefined}
        onDismiss={mockUpdaterState.resetToIdle}
        onStartUpdate={mockUpdaterState.startUpdate}
        onRetry={mockUpdaterState.checkForUpdates}
      />,
    );

    expect(screen.getByText('正在下载更新')).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByText('1 KB / 2 KB')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '关闭' })).toBeNull();
    expect(screen.queryByRole('button', { name: '稍后' })).toBeNull();
  });

  it('展示组件在检查更新时展示检查中状态', async () => {
    const { UpdateToastContent } = await import('./UpdateToast');

    render(
      <UpdateToastContent
        stage="checking"
        version={undefined}
        progress={undefined}
        error={undefined}
        onDismiss={mockUpdaterState.resetToIdle}
        onStartUpdate={mockUpdaterState.startUpdate}
        onRetry={mockUpdaterState.checkForUpdates}
      />,
    );

    expect(screen.getByText('正在检查更新')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('展示组件在安装与重启阶段展示状态且不显示关闭动作', async () => {
    const { UpdateToastContent } = await import('./UpdateToast');

    const { rerender } = render(
      <UpdateToastContent
        stage="installing"
        version={undefined}
        progress={undefined}
        error={undefined}
        onDismiss={mockUpdaterState.resetToIdle}
        onStartUpdate={mockUpdaterState.startUpdate}
        onRetry={mockUpdaterState.checkForUpdates}
      />,
    );

    expect(screen.getByText('正在安装更新')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '关闭' })).toBeNull();

    rerender(
      <UpdateToastContent
        stage="restarting"
        version={undefined}
        progress={undefined}
        error={undefined}
        onDismiss={mockUpdaterState.resetToIdle}
        onStartUpdate={mockUpdaterState.startUpdate}
        onRetry={mockUpdaterState.checkForUpdates}
      />,
    );

    expect(screen.getByText('正在重启应用')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '关闭' })).toBeNull();
  });
});
