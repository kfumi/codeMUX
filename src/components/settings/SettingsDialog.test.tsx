// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDaemonConnectionStore } from '../../stores/daemonConnectionStore';
// 静态导入:如果在 it() 内 await import,首次模块图加载会计入测试超时(15s)。
import { SettingsView } from './SettingsDialog';

vi.mock('../../lib/facades/shell-facade', () => ({
  shellFacade: {
    getAppDataDirectory: vi.fn(async () => 'D:/codeMUX'),
  },
}));

vi.mock('./ProviderConfig', () => ({
  ProviderConfigPanel: () => <div>Provider config</div>,
}));

vi.mock('./AgentSettings', () => ({
  AgentSettingsPanel: () => <div>Agent settings</div>,
  AgentPreferencesPanel: () => <div>Agent preferences</div>,
}));

vi.mock('./AgentRuntimeSettings', () => ({
  AgentRuntimeSettingsPanel: () => <div>Agent runtime settings</div>,
}));

vi.mock('./McpSettings', () => ({
  McpSettingsPanel: () => <div>MCP settings</div>,
}));

vi.mock('./SkillsSettings', () => ({
  SkillsSettingsPanel: () => <div>Skills settings</div>,
}));

vi.mock('./ThemeToggle', () => ({
  ThemeToggle: () => <div>Theme toggle</div>,
}));

afterEach(() => {
  cleanup();
});

describe('SettingsView', () => {
  beforeEach(() => {
    // 桌面壳形态:全量设置入口(浏览器形态的收敛另见下面的用例)。
    useDaemonConnectionStore.setState({ hostForm: 'desktop' });
  });

  it('renders settings as an embedded page rather than a dialog', async () => {
    render(<SettingsView onBack={vi.fn()} />);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('main', { name: '设置' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '返回应用' })).toBeTruthy();
  });

  it('uses one combined entry for agent preferences and managed Runtime', async () => {
    render(<SettingsView onBack={vi.fn()} />);

    expect(screen.getByRole('button', { name: '智能体运行时' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '运行时环境' })).toBeNull();
    expect(screen.queryByRole('button', { name: '智能体引擎' })).toBeNull();
  });

  it('uses the same layered panel treatment as the main workspace', async () => {
    render(<SettingsView onBack={vi.fn()} />);

    const settingsMain = screen.getByRole('main', { name: '设置' });
    const sidebar = settingsMain.querySelector('aside');
    const content = settingsMain.querySelector('section');

    expect(sidebar?.className).toContain('bg-[hsl(var(--sidebar-bg))]');
    expect(sidebar?.className).toContain('w-[275px]');
    expect(content?.className).toContain('bg-[hsl(var(--background))]');
  });

  it('左导航按 Codex 形态分成四组,并给出分组标题', async () => {
    render(<SettingsView onBack={vi.fn()} />);

    for (const heading of ['通用', '智能体', '能力', '数据与系统']) {
      expect(screen.getByText(heading)).toBeTruthy();
    }
  });

  it('搜索框按标签与副标题过滤分页,空结果给出提示', async () => {
    render(<SettingsView onBack={vi.fn()} />);

    const search = screen.getByRole('searchbox', { name: '搜索设置' });

    fireEvent.change(search, { target: { value: '浏览' } });
    expect(screen.getByRole('button', { name: '浏览器控制' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '快捷键' })).toBeNull();
    // 被过滤空的分组连标题一起收起,不留光标题。
    expect(screen.queryByText('数据与系统')).toBeNull();

    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText('未找到结果')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }));
    expect(screen.getByRole('button', { name: '快捷键' })).toBeTruthy();
  });
});

describe('SettingsView 浏览器形态', () => {
  beforeEach(() => {
    useDaemonConnectionStore.setState({ hostForm: 'browser' });
  });

  it('隐藏壳独占的设置入口,而不是让用户点进去看到「桥不可用」', async () => {
    render(<SettingsView onBack={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /日志/ })).toBeNull();
    expect(screen.getByRole('button', { name: /模型配置/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /使用统计/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /关于/ })).toBeTruthy();
  });

  it('常规页渲染成功且不出现壳独占的配置文件区块', async () => {
    render(<SettingsView onBack={vi.fn()} />);

    // 回归:该区块曾以壳门面同步抛错把整页打成「渲染错误」。
    expect(screen.queryByText('渲染错误')).toBeNull();
    expect(screen.getByText('显示偏好')).toBeTruthy();
    expect(screen.queryByText('配置文件')).toBeNull();
  });
});
