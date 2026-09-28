// updater 服务契约测试(工单 06):electron / electron-updater 以 mock 替身注入,
// 覆盖:未打包环境禁用(unavailable / 拒绝下载 / 不触发安装)、check 结果映射、
// 事件转发(updater-event)、downloadAndInstall 返回下载到的版本,
// 以及 updater.log 落盘。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const autoUpdaterMock = vi.hoisted(() => ({
  setFeedURL: vi.fn(),
  disableWebInstaller: false,
  autoDownload: true,
  autoInstallOnAppQuit: false,
  forceDevUpdateConfig: false,
  logger: undefined as unknown,
  setFeedURL: vi.fn(),
  on: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => '9.9.9',
    getAppPath: () => '/virtual/app',
  },
}));
vi.mock('electron-updater', () => ({
  autoUpdater: autoUpdaterMock,
}));

import { createUpdaterService, type UpdaterMainEvent } from '../src/updater';

function getEventListener(event: string): (...args: unknown[]) => void {
  const call = autoUpdaterMock.on.mock.calls.find(([name]) => name === event);
  if (!call) {
    throw new Error(`listener not registered: ${event}`);
  }
  return call[1] as (...args: unknown[]) => void;
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codemux-updater-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createService(isPackaged = true, overrides: Record<string, unknown> = {}) {
  const sendToRenderer = vi.fn();
  const logDir = makeTempDir();
  const service = createUpdaterService({ isPackaged: () => isPackaged, sendToRenderer, logDir, ...overrides });
  return {
    service,
    sendToRenderer,
    readLog: () => readFileSync(path.join(logDir, 'updater.log'), 'utf8'),
  };
}

describe('createUpdaterService(工单 06)', () => {
  beforeEach(() => {
    autoUpdaterMock.on.mockClear();
    autoUpdaterMock.setFeedURL.mockClear();
    autoUpdaterMock.checkForUpdates.mockReset();
    autoUpdaterMock.downloadUpdate.mockReset();
    autoUpdaterMock.quitAndInstall.mockClear();
    autoUpdaterMock.forceDevUpdateConfig = false;
  });

  it('注册 autoDownload=false / autoInstallOnAppQuit=true / disableWebInstaller=true', () => {
    createService();
    expect(autoUpdaterMock.autoDownload).toBe(false);
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(true);
    // NSIS 离线安装包,不走 web installer(否则下载时刷弃用警告)。
    expect(autoUpdaterMock.disableWebInstaller).toBe(true);
  });

  it('未打包环境:check 返回 unavailable,downloadAndInstall 拒绝,quitAndInstall 不触发', async () => {
    const { service } = createService(false);

    await expect(service.check()).resolves.toEqual({ status: 'unavailable', version: null });
    await expect(service.downloadAndInstall()).rejects.toThrow('更新器在开发/未打包环境不可用');
    service.quitAndInstall();
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled();
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    expect(service.currentVersion()).toBe('9.9.9');
  });

  it('打包环境:check 把 isUpdateAvailable 映射为 available/not-available', async () => {
    const { service } = createService(true);

    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: '1.2.3' },
    });
    await expect(service.check()).resolves.toEqual({ status: 'available', version: '1.2.3' });

    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: false,
      updateInfo: { version: '1.2.3' },
    });
    await expect(service.check()).resolves.toEqual({ status: 'not-available', version: '1.2.3' });
  });

  it('downloadUpdate 完成后返回已下载版本(check 时缓存)', async () => {
    const { service } = createService(true);
    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: '2.0.0' },
    });
    await service.check();
    autoUpdaterMock.downloadUpdate.mockResolvedValueOnce(['D:/pkg/Setup.exe']);

    await expect(service.downloadAndInstall()).resolves.toEqual({ version: '2.0.0' });
    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('quitAndInstall:静默安装 + 自动重启', () => {
    const { service } = createService(true);
    service.quitAndInstall();
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('事件经 sendToRenderer 以 updater-event 通道转发', () => {
    const { service, sendToRenderer } = createService(true);
    // 注册即订阅:构造后转发器已存在(访问一次确保注册断言成立)。
    expect(service.currentVersion()).toBe('9.9.9');

    const onProgress = getEventListener('download-progress');
    (onProgress as (info: unknown) => void)({ percent: 42.5, transferred: 425, total: 1000 });
    const forwarded = sendToRenderer.mock.calls.map(([channel, payload]) => ({ channel, payload }));
    expect(forwarded).toContainEqual({
      channel: 'updater-event',
      payload: { type: 'progress', percent: 42.5, transferred: 425, total: 1000 } satisfies UpdaterMainEvent,
    });
  });

  it('全过程落盘 updater.log:初始化、check 结果、下载成功与失败原因', async () => {
    const { service, readLog } = createService(true);
    expect(readLog()).toContain('更新器初始化:packaged=true');

    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: '3.0.0' },
    });
    await service.check();
    expect(readLog()).toContain('check: 发现新版本 3.0.0');

    autoUpdaterMock.downloadUpdate.mockResolvedValueOnce(['D:/pkg/Setup.exe']);
    await service.downloadAndInstall();
    expect(readLog()).toContain('downloadAndInstall: 下载完成 files=D:/pkg/Setup.exe');

    autoUpdaterMock.downloadUpdate.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND'));
    await expect(service.downloadAndInstall()).rejects.toThrow('getaddrinfo ENOTFOUND');
    expect(readLog()).toContain('downloadAndInstall: 下载失败');
    expect(readLog()).toContain('getaddrinfo ENOTFOUND');
  });

  it('autoUpdater.logger 不再是 null,electron-updater 本体日志也落同一个文件', () => {
    createService(true);
    expect(autoUpdaterMock.logger).not.toBeNull();
    expect(typeof autoUpdaterMock.logger.info).toBe('function');
  });

  it('未打包环境:即便 autoUpdater 仍可用也不放行,日志写明原因', async () => {
    const { service, readLog } = createService(false);
    expect(await service.check()).toEqual({ status: 'unavailable', version: null });
    expect(readLog()).toContain('未打包环境更新器禁用');
    // 关键回归:开发态绝不能碰 forceDevUpdateConfig / setFeedURL。
    expect(autoUpdaterMock.forceDevUpdateConfig).toBe(false);
    expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled();
  });
});
