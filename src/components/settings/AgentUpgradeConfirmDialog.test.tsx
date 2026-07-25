// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AgentInstallationReport } from '@/lib/tauri';
import { AgentUpgradeConfirmDialog } from './AgentUpgradeConfirmDialog';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

function makeReport(overrides: Partial<AgentInstallationReport>): AgentInstallationReport {
  return {
    agentKind: 'claude_code',
    installs: [
      {
        path: '/usr/local/bin/claude',
        real: '/usr/local/bin/claude',
        version: '1.0.0',
        runnable: true,
        error: null,
        source: 'nvm',
        isPathDefault: true,
      },
      {
        path: '/opt/homebrew/bin/claude',
        real: '/opt/homebrew/bin/claude',
        version: '1.0.16',
        runnable: true,
        error: null,
        source: 'homebrew',
        isPathDefault: false,
      },
    ],
    isConflict: false,
    needsConfirmation: true,
    anchored: true,
    command: 'npm install -g @anthropic-ai/claude-code@latest',
    ...overrides,
  };
}

describe('AgentUpgradeConfirmDialog', () => {
  beforeAll(() => {
    // Radix 组件在 jsdom 中调用 scrollIntoView / pointer capture，需提供占位实现
    Element.prototype.scrollIntoView = () => {};
    if (!HTMLElement.prototype.hasPointerCapture) {
      HTMLElement.prototype.hasPointerCapture = () => false;
    }
    if (!HTMLElement.prototype.releasePointerCapture) {
      HTMLElement.prototype.releasePointerCapture = () => {};
    }
    if (!HTMLElement.prototype.setPointerCapture) {
      HTMLElement.prototype.setPointerCapture = () => {};
    }
  });

  afterEach(() => {
    cleanup();
  });

  it('open=false 时不渲染对话框内容', () => {
    render(
      <AgentUpgradeConfirmDialog
        open={false}
        report={makeReport({})}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('确认升级')).toBeNull();
  });

  it('open=true 且 report 有 2 处安装 → 渲染列表、命令字符串与"确认升级"按钮', () => {
    const report = makeReport({});
    render(
      <AgentUpgradeConfirmDialog
        open={true}
        report={report}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // 标题
    expect(screen.getByRole('heading', { name: '确认升级' })).toBeTruthy();
    // 描述含安装数
    expect(screen.getByText(/检测到 2 处安装/)).toBeTruthy();
    // 2 个 AgentInstallRow:通过 source 徽章和路径确认
    expect(screen.getByText('nvm')).toBeTruthy();
    expect(screen.getByText('brew')).toBeTruthy();
    expect(screen.getByText('/usr/local/bin/claude')).toBeTruthy();
    expect(screen.getByText('/opt/homebrew/bin/claude')).toBeTruthy();
    // 命令字符串
    expect(screen.getByText('npm install -g @anthropic-ai/claude-code@latest')).toBeTruthy();
    // 确认升级按钮
    expect(screen.getByRole('button', { name: '确认升级' })).toBeTruthy();
  });

  it('anchored=false → 渲染"默认入口无法确定"警告', () => {
    render(
      <AgentUpgradeConfirmDialog
        open={true}
        report={makeReport({ anchored: false })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('默认入口无法确定,将退到 npm 兜底')).toBeTruthy();
  });

  it('anchored=true → 不渲染"默认入口无法确定"警告', () => {
    render(
      <AgentUpgradeConfirmDialog
        open={true}
        report={makeReport({ anchored: true })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByText('默认入口无法确定,将退到 npm 兜底')).toBeNull();
  });

  it('isConflict=true → 渲染"检测到版本冲突"提示', () => {
    render(
      <AgentUpgradeConfirmDialog
        open={true}
        report={makeReport({ isConflict: true })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('检测到版本冲突')).toBeTruthy();
  });

  it('点击"确认升级"按钮调用 onConfirm', () => {
    const onConfirm = vi.fn();
    render(
      <AgentUpgradeConfirmDialog
        open={true}
        report={makeReport({})}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '确认升级' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('点击"取消"按钮调用 onCancel', () => {
    const onCancel = vi.fn();
    render(
      <AgentUpgradeConfirmDialog
        open={true}
        report={makeReport({})}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
