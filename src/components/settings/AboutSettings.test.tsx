// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDaemonConnectionStore } from '../../stores/daemonConnectionStore';
// 静态导入:如果在 it() 内 await import,首次模块图加载会计入测试超时(15s)。
import { AboutSettings } from './AboutSettings';

// vi.mock 工厂会被提升到文件顶部执行,这里必须用 vi.hoisted 声明,
// 否则 desktop-bridge 被更早的导入链(host-form → daemonConnectionStore)拉取时会踩到 TDZ。
const currentVersionMock = vi.hoisted(() => vi.fn(async () => '1.0.0'));

type MockUpdaterContext = {
  stage: 'idle' | 'checking' | 'available' | 'latest' | 'downloading' | 'installing' | 'restarting' | 'error';
  version?: string;
  progress?: { totalBytes: number | null; downloadedBytes: number };
  error?: string;
  checkForUpdates: ReturnType<typeof vi.fn>;
  startUpdate: ReturnType<typeof vi.fn>;
};

let mockUpdaterContext: MockUpdaterContext;

vi.mock('../../lib/desktop-bridge', async () => {
  const actual = await vi.importActual<typeof import('../../lib/desktop-bridge')>('../../lib/desktop-bridge');
  return {
    ...actual,
    desktopBridge: { currentVersion: currentVersionMock },
  };
});

vi.mock('../../features/update/UpdaterProvider', () => ({
  useUpdaterContext: () => mockUpdaterContext,
}));

describe('AboutSettings', () => {
  beforeEach(() => {
    // 自动更新是壳独占能力:下面的用例断言桌面壳行为。
    useDaemonConnectionStore.setState({ hostForm: 'desktop' });
    mockUpdaterContext = {
      stage: 'idle',
      version: undefined,
      progress: undefined,
      error: undefined,
      checkForUpdates: vi.fn(async () => null),
      startUpdate: vi.fn(),
    };
  });

  afterEach(() => {
    cleanup();
  });

  it('点击检查更新时调用交互式更新检查', async () => {
    render(<AboutSettings />);

    await screen.findByText('CodeMUX');

    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));

    expect(mockUpdaterContext.checkForUpdates).toHaveBeenCalledWith({
      interactive: true,
      announceNoUpdate: true,
      throwOnError: true,
    });
  });

  it('手动检查发现更新后弹出确认窗，确认后开始下载安装', async () => {
    mockUpdaterContext.checkForUpdates.mockResolvedValueOnce({
      version: '1.2.3',
      downloadAndInstall: vi.fn(async () => {}),
    });
    mockUpdaterContext.version = '1.2.3';

    render(<AboutSettings />);

    await screen.findByText('CodeMUX');

    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));

    expect(await screen.findByText('安装更新 1.2.3？')).toBeTruthy();
    expect(mockUpdaterContext.startUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '下载并安装' }));

    expect(mockUpdaterContext.startUpdate).toHaveBeenCalledTimes(1);
  });

  it('手动检查没有更新时弹出最新版本提示', async () => {
    render(<AboutSettings />);

    await screen.findByText('CodeMUX');

    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));

    expect(await screen.findByText('已经是最新版本')).toBeTruthy();
    expect(screen.getByText('当前安装的 CodeMUX 已经是最新版本。')).toBeTruthy();
  });

  it('手动检查失败时弹出失败提示且不展示底层错误原因', async () => {
    mockUpdaterContext.checkForUpdates.mockRejectedValueOnce(new Error('network down'));

    render(<AboutSettings />);

    await screen.findByText('CodeMUX');

    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));

    await vi.waitFor(() => {
      expect(mockUpdaterContext.checkForUpdates).toHaveBeenCalled();
    });

    expect(await screen.findByText('检查更新失败')).toBeTruthy();
    expect(screen.getByText('暂时无法检查更新，请确认网络可访问 GitHub，并在桌面正式环境中重试。')).toBeTruthy();
    expect(screen.queryByText('network down')).toBeNull();
    expect(screen.queryByText('已经是最新版本')).toBeNull();
    expect(screen.queryByText('安装更新')).toBeNull();
  });

  it('检查中展示加载态并禁用按钮', async () => {
    mockUpdaterContext.stage = 'checking';

    render(<AboutSettings />);

    const button = await screen.findByRole('button', { name: '检查中...' });
    expect(button).toHaveProperty('disabled', true);
    fireEvent.click(button);
    expect(mockUpdaterContext.checkForUpdates).not.toHaveBeenCalled();
  });

  it.each([
    ['downloading'],
    ['installing'],
    ['restarting'],
  ] as const)('更新处于 %s 阶段时禁用检查更新按钮且不允许再次触发', async (stage) => {
    mockUpdaterContext.stage = stage;

    render(<AboutSettings />);

    const button = await screen.findByRole('button', { name: '检查更新' });
    expect(button).toHaveProperty('disabled', true);

    fireEvent.click(button);

    expect(mockUpdaterContext.checkForUpdates).not.toHaveBeenCalled();
  });

  it('读取应用信息失败时仍显示规范品牌名', async () => {
    currentVersionMock.mockRejectedValueOnce(new Error('unavailable'));

    render(<AboutSettings />);

    expect(await screen.findByText('CodeMUX')).toBeTruthy();
  });

  it('浏览器形态隐藏「检查更新」并标注当前宿主形态', async () => {
    useDaemonConnectionStore.setState({ hostForm: 'browser' });

    render(<AboutSettings />);

    expect(await screen.findByText('CodeMUX')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '检查更新' })).toBeNull();
    expect(screen.getByText('PC 浏览器')).toBeTruthy();
  });

  it('下载中展示百分比进度条与字节数(回归:本页此前完全没有进度反馈)', async () => {
    mockUpdaterContext.stage = 'downloading';
    mockUpdaterContext.progress = { totalBytes: 2 * 1024 * 1024, downloadedBytes: 1024 * 1024 };

    render(<AboutSettings />);
    await screen.findByText('CodeMUX');

    const bar = screen.getByRole('progressbar', { name: '更新下载进度' });
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByText('1.0 MB / 2.0 MB')).toBeTruthy();
  });

  it('总量未知时不显示假百分比,退化为不确定态', async () => {
    mockUpdaterContext.stage = 'downloading';
    mockUpdaterContext.progress = { totalBytes: null, downloadedBytes: 2048 };

    render(<AboutSettings />);
    await screen.findByText('CodeMUX');

    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull();
    expect(screen.queryByText('%')).toBeNull();
    expect(screen.getByText('已下载 2 KB')).toBeTruthy();
  });

  it('安装中/重启中展示阶段文案', async () => {
    mockUpdaterContext.stage = 'installing';
    const { rerender } = render(<AboutSettings />);
    await screen.findByText('CodeMUX');
    expect(screen.getByText('安装中')).toBeTruthy();

    mockUpdaterContext.stage = 'restarting';
    rerender(<AboutSettings />);
    expect(screen.getByText('重启中')).toBeTruthy();
  });

  it('更新失败时展示原因与日志指引,而不是静默', async () => {
    mockUpdaterContext.stage = 'error';
    mockUpdaterContext.error = 'Cannot download "CodeMUX-Setup-0.4.6.exe", status 404';

    render(<AboutSettings />);
    await screen.findByText('CodeMUX');

    expect(screen.getByText('更新失败')).toBeTruthy();
    expect(screen.getByText(/status 404/)).toBeTruthy();
    expect(screen.getByText(/logs\/updater\.log/)).toBeTruthy();
  });

  it('idle 状态不展示进度区', async () => {
    render(<AboutSettings />);
    await screen.findByText('CodeMUX');
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});
