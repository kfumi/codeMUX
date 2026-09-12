// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LogFileInfo } from '../../lib/desktop-bridge';

const getLogFilesMock = vi.hoisted(() => vi.fn());
const getLogDirectoryMock = vi.hoisted(() => vi.fn());
const readLogFileMock = vi.hoisted(() => vi.fn());
const openInExplorerMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/facades/shell-facade', () => ({
  shellFacade: {
    getLogFiles: getLogFilesMock,
    getLogDirectory: getLogDirectoryMock,
    readLogFile: readLogFileMock,
    openInExplorer: openInExplorerMock,
  },
}));

import { LogSettings, pickDefaultLogFile, pickLogFiles } from './LogSettings';

function logFile(name: string, modified: string, size = 100): LogFileInfo {
  return { name, path: `C:\\logs\\${name}`, size, modified };
}

describe('pickLogFiles', () => {
  it('只保留 .log 文件并按修改时间倒序', () => {
    const files = [
      logFile('renderer.log', '2026-09-12 23:44:00'),
      logFile('crash.dmp', '2026-09-12 23:45:00'),
      logFile('daemon.log', '2026-09-12 23:43:00'),
      logFile('notes.txt', '2026-09-12 23:46:00'),
    ];
    expect(pickLogFiles(files).map((f) => f.name)).toEqual(['renderer.log', 'daemon.log']);
  });
});

describe('pickDefaultLogFile', () => {
  it('优先 daemon.log', () => {
    const files = [logFile('renderer.log', '2026-09-12 23:44:00'), logFile('daemon.log', '2026-09-12 23:43:00')];
    expect(pickDefaultLogFile(files)).toBe('daemon.log');
  });

  it('daemon.log 缺失时回退到第一个文件', () => {
    const files = [logFile('renderer.log', '2026-09-12 23:44:00')];
    expect(pickDefaultLogFile(files)).toBe('renderer.log');
  });

  it('无日志文件时返回空串', () => {
    expect(pickDefaultLogFile([])).toBe('');
  });
});

describe('LogSettings', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = () => {};
  });

  beforeEach(() => {
    getLogDirectoryMock.mockResolvedValue('C:\\logs');
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('默认展示 daemon.log 内容(即使列表里 renderer.log 更新)', async () => {
    getLogFilesMock.mockResolvedValue([
      logFile('renderer.log', '2026-09-12 23:44:00'),
      logFile('daemon.log', '2026-09-12 23:43:00'),
    ]);
    readLogFileMock.mockImplementation(async (name: string) => `${name}: hello`);

    render(<LogSettings />);

    await waitFor(() => {
      expect(screen.getByText('daemon.log: hello')).toBeTruthy();
    });
    expect(readLogFileMock).toHaveBeenCalledWith('daemon.log');
  });

  it('目录里没有 .log 文件时显示暂无日志', async () => {
    getLogFilesMock.mockResolvedValue([logFile('crash.dmp', '2026-09-12 23:45:00')]);

    render(<LogSettings />);

    await waitFor(() => {
      expect(screen.getByText('暂无日志')).toBeTruthy();
    });
    expect(readLogFileMock).not.toHaveBeenCalled();
  });

  it('读取失败时展示错误信息', async () => {
    getLogFilesMock.mockResolvedValue([logFile('daemon.log', '2026-09-12 23:43:00')]);
    readLogFileMock.mockRejectedValue(new Error('EPERM'));

    render(<LogSettings />);

    await waitFor(() => {
      expect(screen.getByText('EPERM')).toBeTruthy();
    });
  });

  it('存在多个日志文件时提供文件切换', async () => {
    getLogFilesMock.mockResolvedValue([
      logFile('renderer.log', '2026-09-12 23:44:00'),
      logFile('daemon.log', '2026-09-12 23:43:00'),
    ]);
    readLogFileMock.mockImplementation(async (name: string) => `${name}: hello`);

    render(<LogSettings />);

    const trigger = await screen.findByRole('combobox', { name: '日志文件' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const option = await screen.findByRole('option', { name: 'renderer.log' });
    fireEvent.click(option);

    await waitFor(() => {
      expect(readLogFileMock).toHaveBeenCalledWith('renderer.log');
    });
    expect(await screen.findByText('renderer.log: hello')).toBeTruthy();
  });
});
