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

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('UpdateEntry', () => {
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

  it('没有可用更新时不渲染入口按钮', async () => {
    const { UpdateEntry } = await import('./UpdateEntry');

    render(<UpdateEntry />);

    expect(screen.queryByRole('button', { name: /更新/ })).toBeNull();
  });

  it('发现新版本时展示左上角更新按钮，确认后才开始下载安装', async () => {
    mockUpdaterState.stage = 'available';
    mockUpdaterState.version = '1.2.3';
    const { UpdateEntry } = await import('./UpdateEntry');

    render(<UpdateEntry />);

    fireEvent.click(screen.getByRole('button', { name: '更新' }));

    expect(screen.getByText('安装更新 1.2.3？')).toBeTruthy();
    expect(mockUpdaterState.startUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '下载并安装' }));

    expect(mockUpdaterState.startUpdate).toHaveBeenCalledTimes(1);
  });

  it('下载、安装和重启阶段展示不可重复点击的进度入口', async () => {
    mockUpdaterState.stage = 'downloading';
    mockUpdaterState.progress = {
      totalBytes: 100,
      downloadedBytes: 42,
    };
    const { UpdateEntry } = await import('./UpdateEntry');

    const { rerender } = render(<UpdateEntry />);

    expect(screen.getByRole<HTMLButtonElement>('button', { name: '下载中 42%' }).disabled).toBe(true);

    mockUpdaterState.stage = 'installing';
    rerender(<UpdateEntry />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '安装中' }).disabled).toBe(true);

    mockUpdaterState.stage = 'restarting';
    rerender(<UpdateEntry />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重启中' }).disabled).toBe(true);
  });

  it('更新失败时展示重试入口，点击后重新检查更新', async () => {
    mockUpdaterState.stage = 'error';
    mockUpdaterState.error = 'network down';
    const { UpdateEntry } = await import('./UpdateEntry');

    render(<UpdateEntry />);

    fireEvent.click(screen.getByRole('button', { name: '更新失败' }));

    expect(mockUpdaterState.checkForUpdates).toHaveBeenCalledWith({
      interactive: true,
      announceNoUpdate: true,
    });
  });
});
