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
  it('优先最新的 daemon 按天日志(列表按时间倒序)', () => {
    const files = [
      logFile('daemon-2026-09-12.log', '2026-09-12 23:44:00'),
      logFile('daemon-2026-09-11.log', '2026-09-11 23:44:00'),
    ];
    expect(pickDefaultLogFile(files)).toBe('daemon-2026-09-12.log');
  });

  it('跳过 daemon-stderr.log', () => {
    const files = [
      logFile('daemon-stderr.log', '2026-09-12 23:45:00'),
      logFile('daemon-2026-09-12.log', '2026-09-12 23:44:00'),
    ];
    expect(pickDefaultLogFile(files)).toBe('daemon-2026-09-12.log');
  });

  it('兼容旧版 daemon.log', () => {
    const files = [
      logFile('renderer-2026-09-12.log', '2026-09-12 23:45:00'),
      logFile('daemon.log', '2026-09-12 23:43:00'),
    ];
    expect(pickDefaultLogFile(files)).toBe('daemon.log');
  });

  it('无 daemon 日志时回退到第一个文件', () => {
    const files = [logFile('renderer-2026-09-12.log', '2026-09-12 23:44:00')];
    expect(pickDefaultLogFile(files)).toBe('renderer-2026-09-12.log');
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
    readLogFileMock.mockImplementation(async (name: string) => ({
      content: `${name}: hello`,
      truncated: false,
      totalBytes: 0,
    }));

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
    readLogFileMock.mockImplementation(async (name: string) => ({
      content: `${name}: hello`,
      truncated: false,
      totalBytes: 0,
    }));

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

  it('文件被壳侧截断时提示仅显示末尾部分', async () => {
    getLogFilesMock.mockResolvedValue([logFile('daemon.log', '2026-09-12 23:43:00')]);
    readLogFileMock.mockResolvedValue({ content: 'tail only', truncated: true, totalBytes: 9_000_000 });

    render(<LogSettings />);

    expect(await screen.findByText(/仅显示末尾部分/)).toBeTruthy();
  });

  it('行数超过上限时只提示最近 2000 行', async () => {
    getLogFilesMock.mockResolvedValue([logFile('daemon.log', '2026-09-12 23:43:00')]);
    const content = Array.from({ length: 3000 }, (_, i) => `line-${i}`).join('\n');
    readLogFileMock.mockResolvedValue({ content, truncated: false, totalBytes: content.length });

    render(<LogSettings />);

    expect(await screen.findByText(/仅显示最近 2000 行\(共 3000 行\)/)).toBeTruthy();
    // 最旧的 1000 行不应出现在 DOM 里。
    expect(screen.queryByText('line-0')).toBeNull();
    expect(screen.getByText('line-2999')).toBeTruthy();
  });
});
