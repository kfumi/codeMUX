// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDaemonConnectionStore } from '@/stores/daemonConnectionStore';

// 静态导入:如果在 it() 内 await import,首次模块图加载会计入测试超时(15s)。
import { UpdateEntry } from './UpdateEntry';

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
    // 自动更新是壳独占能力:这些用例覆盖壳内入口行为。
    useDaemonConnectionStore.setState({ hostForm: 'desktop' });
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

    render(<UpdateEntry />);

    expect(screen.queryByRole('button', { name: /更新/ })).toBeNull();
  });

  it('发现新版本时展示左上角更新按钮，确认后才开始下载安装', async () => {
    mockUpdaterState.stage = 'available';
    mockUpdaterState.version = '1.2.3';

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

    const { rerender } = render(<UpdateEntry />);

    expect(screen.getByRole<HTMLButtonElement>('button', { name: '下载中 42%' }).disabled).toBe(true);

    mockUpdaterState.stage = 'installing';
    rerender(<UpdateEntry />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '安装中' }).disabled).toBe(true);

    mockUpdaterState.stage = 'restarting';
    rerender(<UpdateEntry />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重启中' }).disabled).toBe(true);
  });

  it('更新失败时**保留**入口并展示原因与重试(回归:此前 error 返回 null,按钮凭空消失)', async () => {
    mockUpdaterState.stage = 'error';
    mockUpdaterState.error = 'Cannot download CodeMUX-Setup-0.4.6.exe, status 404';

    render(<UpdateEntry />);

    const button = screen.getByRole('button', { name: '更新失败' });
    expect(button).toBeTruthy();
    // tooltip 走 mock 渲染,原因对用户可见。
    expect(screen.getByText(/status 404/)).toBeTruthy();
    // 静默检查失败走的是 idle,error 态一定来自用户交互,可安全重试。
    expect(mockUpdaterState.checkForUpdates).not.toHaveBeenCalled();
  });

  it('点击「更新失败」重新检查,拿到新版本后回到确认框', async () => {
    mockUpdaterState.stage = 'error';
    mockUpdaterState.error = 'status 404';
    // 确认框标题取 context 的 version(真实运行时 checkForUpdates 会写入 state)。
    mockUpdaterState.version = '1.2.4';
    mockUpdaterState.checkForUpdates.mockResolvedValue({
      version: '1.2.4',
      downloadAndInstall: vi.fn(async () => {}),
    });

    render(<UpdateEntry />);
    fireEvent.click(screen.getByRole('button', { name: '更新失败' }));

    await vi.waitFor(() => {
      expect(screen.getByText('安装更新 1.2.4？')).toBeTruthy();
    });
    expect(mockUpdaterState.checkForUpdates).toHaveBeenCalledWith(
      expect.objectContaining({ interactive: true, throwOnError: true }),
    );
  });

  it('重新检查仍失败时停留在失败态并展示新原因', async () => {
    mockUpdaterState.stage = 'error';
    mockUpdaterState.error = 'status 404';
    mockUpdaterState.checkForUpdates.mockRejectedValue(new Error('network down'));

    render(<UpdateEntry />);
    fireEvent.click(screen.getByRole('button', { name: '更新失败' }));

    // 失败原因由 hook 自己写进 state,组件不吞异常、不弹确认框。
    await vi.waitFor(() => {
      expect(mockUpdaterState.checkForUpdates).toHaveBeenCalled();
    });
    expect(screen.queryByText(/安装更新/)).toBeNull();
  });

  it('浏览器形态隐藏壳独占的更新入口', async () => {
    useDaemonConnectionStore.setState({ hostForm: 'browser' });
    mockUpdaterState.stage = 'available';
    mockUpdaterState.version = '1.2.3';

    render(<UpdateEntry />);

    expect(screen.queryByRole('button', { name: /更新/ })).toBeNull();
  });
});
