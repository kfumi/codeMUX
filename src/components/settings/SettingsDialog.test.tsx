// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/tauri', () => ({
  appApi: {
    getAppDataDirectory: vi.fn(async () => 'D:/codeMUX'),
    checkDevelopmentEnvironment: vi.fn(async () => ({
      checkedAt: '2026-06-27T00:00:00Z',
      tools: [
        {
          name: 'Node.js',
          command: 'node',
          status: 'missing',
          version: null,
          path: null,
          message: '未找到 Node.js，请安装 Node.js 18+ 并确认 PATH 已生效。',
        },
        {
          name: 'npm',
          command: 'npm',
          status: 'missing',
          version: null,
          path: null,
          message: '未找到 npm，请确认 Node.js 安装包含 npm 且 PATH 已生效。',
        },
        {
          name: 'Git',
          command: 'git',
          status: 'ok',
          version: '2.34.1.windows.1',
          path: null,
          message: 'Git 可用。',
        },
      ],
    })),
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
  it('renders settings as an embedded page rather than a dialog', async () => {
    const { SettingsView } = await import('./SettingsDialog');

    render(<SettingsView onBack={vi.fn()} />);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('main', { name: '设置' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '返回应用' })).toBeTruthy();
  });

  it('renders the system tools tab and reports missing Node.js/npm', async () => {
    const { SettingsView } = await import('./SettingsDialog');

    render(<SettingsView onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /系统工具/ }));

    expect(await screen.findByText('Node.js')).toBeTruthy();
    expect(screen.getAllByText('npm').length).toBeGreaterThan(0);
    expect(screen.getByText(/请安装 Node.js 18\+/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /重新检测/ })).toBeTruthy();
  });

  it('uses one combined entry for agent preferences and managed Runtime', async () => {
    const { SettingsView } = await import('./SettingsDialog');

    render(<SettingsView onBack={vi.fn()} />);

    expect(screen.getByRole('button', { name: '智能体运行时' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '运行时环境' })).toBeNull();
    expect(screen.queryByRole('button', { name: '智能体引擎' })).toBeNull();
  });

  it('uses the same layered panel treatment as the main workspace', async () => {
    const { SettingsView } = await import('./SettingsDialog');

    render(<SettingsView onBack={vi.fn()} />);

    const settingsMain = screen.getByRole('main', { name: '设置' });
    const sidebar = settingsMain.querySelector('aside');
    const content = settingsMain.querySelector('section');

    expect(sidebar?.className).toContain('bg-[hsl(var(--surface-2)/0.88)]');
    expect(sidebar?.className).toContain('backdrop-blur-xl');
    expect(sidebar?.className).toContain('shadow-[inset_-1px_0_0_hsl(var(--foreground)/0.04)]');
    expect(content?.className).toContain('bg-[hsl(var(--background))]');
  });
});
