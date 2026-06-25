// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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

describe('SettingsView', () => {
  it('renders settings as an embedded page rather than a dialog', async () => {
    const { SettingsView } = await import('./SettingsDialog');

    render(<SettingsView onBack={vi.fn()} />);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('main', { name: '设置' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '返回应用' })).toBeTruthy();
  });
});
