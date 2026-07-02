// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getNameMock = vi.fn(async () => 'codeMUX');
const getVersionMock = vi.fn(async () => '1.0.0');
const getTauriVersionMock = vi.fn(async () => '2.0.0');

type MockUpdaterContext = {
  stage: 'idle' | 'checking' | 'available' | 'latest' | 'downloading' | 'installing' | 'restarting' | 'error';
  version?: string;
  checkForUpdates: ReturnType<typeof vi.fn>;
  startUpdate: ReturnType<typeof vi.fn>;
};

let mockUpdaterContext: MockUpdaterContext;

vi.mock('@tauri-apps/api/app', () => ({
  getName: getNameMock,
  getVersion: getVersionMock,
  getTauriVersion: getTauriVersionMock,
}));

vi.mock('../../features/update/UpdaterProvider', () => ({
  useUpdaterContext: () => mockUpdaterContext,
}));

describe('AboutSettings', () => {
  beforeEach(() => {
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
    const { AboutSettings } = await import('./AboutSettings');

    render(<AboutSettings />);

    await screen.findByText('codeMUX');

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
    const { AboutSettings } = await import('./AboutSettings');

    render(<AboutSettings />);

    await screen.findByText('codeMUX');

    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));

    expect(await screen.findByText('安装更新 1.2.3？')).toBeTruthy();
    expect(mockUpdaterContext.startUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '下载并安装' }));

    expect(mockUpdaterContext.startUpdate).toHaveBeenCalledTimes(1);
  });

  it('手动检查没有更新时弹出最新版本提示', async () => {
    const { AboutSettings } = await import('./AboutSettings');

    render(<AboutSettings />);

    await screen.findByText('codeMUX');

    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));

    expect(await screen.findByText('已经是最新版本')).toBeTruthy();
    expect(screen.getByText('当前安装的 codeMUX 已经是最新版本。')).toBeTruthy();
  });

  it('手动检查失败时不误弹最新版本提示', async () => {
    mockUpdaterContext.checkForUpdates.mockRejectedValueOnce(new Error('network down'));
    const { AboutSettings } = await import('./AboutSettings');

    render(<AboutSettings />);

    await screen.findByText('codeMUX');

    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));

    await vi.waitFor(() => {
      expect(mockUpdaterContext.checkForUpdates).toHaveBeenCalled();
    });

    expect(screen.queryByText('已经是最新版本')).toBeNull();
    expect(screen.queryByText('安装更新')).toBeNull();
  });

  it('检查中展示加载态并禁用按钮', async () => {
    mockUpdaterContext.stage = 'checking';

    const { AboutSettings } = await import('./AboutSettings');

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

    const { AboutSettings } = await import('./AboutSettings');

    render(<AboutSettings />);

    const button = await screen.findByRole('button', { name: '检查更新' });
    expect(button).toHaveProperty('disabled', true);

    fireEvent.click(button);

    expect(mockUpdaterContext.checkForUpdates).not.toHaveBeenCalled();
  });
});
