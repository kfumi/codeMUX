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

describe('SettingsDialog', () => {
  it('renders the settings dialog without an outer border', async () => {
    const { SettingsDialog } = await import('./SettingsDialog');

    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    const dialogClassName = screen.getByRole('dialog').className;
    expect(dialogClassName).toContain('border-0');
    expect(dialogClassName).not.toContain('inset_0_1px');
  });
});
