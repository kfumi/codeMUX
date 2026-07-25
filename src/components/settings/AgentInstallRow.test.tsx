// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentInstallation } from '../../lib/tauri';
import { AgentInstallRow } from './AgentInstallRow';

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    success: toastSuccess,
    error: toastError,
    loading: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

function makeInstall(overrides: Partial<AgentInstallation>): AgentInstallation {
  return {
    path: '/usr/local/bin/claude',
    real: '/usr/local/bin/claude',
    version: '1.0.16',
    runnable: true,
    error: null,
    source: 'homebrew',
    isPathDefault: false,
    ...overrides,
  };
}

describe('AgentInstallRow', () => {
  beforeEach(() => {
    toastSuccess.mockReset();
    toastError.mockReset();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('正常 runnable + 有版本 + 非默认 → 展示 source 徽章、路径、版本号，不展示"默认"', () => {
    render(<AgentInstallRow install={makeInstall({ source: 'homebrew' })} />);

    // source 徽章映射 homebrew → brew
    expect(screen.getByText('brew')).toBeTruthy();
    // 路径
    expect(screen.getByText('/usr/local/bin/claude')).toBeTruthy();
    // 版本号
    expect(screen.getByText('1.0.16')).toBeTruthy();
    // 不展示"默认"标记
    expect(screen.queryByText('默认')).toBeNull();
    // 不展示"无法运行"
    expect(screen.queryByText('无法运行')).toBeNull();
  });

  it('runnable=false → 展示"无法运行"并使用 destructive 颜色', () => {
    render(
      <AgentInstallRow
        install={makeInstall({ runnable: false, version: null, error: 'boom' })}
      />,
    );

    const broken = screen.getByText('无法运行');
    expect(broken).toBeTruthy();
    expect(broken.className).toContain('text-destructive');
    // 不展示版本号
    expect(screen.queryByText('1.0.16')).toBeNull();
  });

  it('isPathDefault=true → 展示"默认"徽章', () => {
    render(<AgentInstallRow install={makeInstall({ isPathDefault: true })} />);

    const defaultBadge = screen.getByText('默认');
    expect(defaultBadge).toBeTruthy();
  });

  it('点击 Copy 按钮调用剪贴板写入并反馈 toast', async () => {
    render(<AgentInstallRow install={makeInstall({ path: '/usr/local/bin/claude' })} />);

    const copyBtn = screen.getByRole('button', { name: '复制路径' });
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/usr/local/bin/claude');
    });
    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith('已复制到剪贴板');
    });
  });
});
