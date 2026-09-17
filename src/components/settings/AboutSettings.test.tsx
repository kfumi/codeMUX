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
    expect(screen.getByText('暂时无法检查更新，请稍后再试。')).toBeTruthy();
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
});
