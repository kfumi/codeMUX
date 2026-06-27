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

  it('renders the environment check tab and reports missing Node.js', async () => {
    const { SettingsView } = await import('./SettingsDialog');

    render(<SettingsView onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /环境检测/ }));

    expect(await screen.findByText('Node.js')).toBeTruthy();
    expect(screen.getByText(/请安装 Node.js 18\+/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /重新检测/ })).toBeTruthy();
  });
});
