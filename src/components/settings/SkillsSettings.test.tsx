// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toggleApp = vi.fn();
const importFromApps = vi.fn().mockResolvedValue(0);
const listImportable = vi.fn().mockResolvedValue([]);
const fetchInstalled = vi.fn().mockResolvedValue(undefined);
const syncBuiltins = vi.fn().mockResolvedValue(undefined);
const uninstallSkill = vi.fn();
const getSkillContent = vi.fn().mockResolvedValue('');

const mockState = {
  installedSkills: [
    {
      id: 's1',
      name: 'alpha',
      display_name: 'Alpha',
      description: 'A skill',
      installed_at: '2026-01-01T00:00:00Z',
      apps: { claude: true, codex: false, gemini: false, opencode: false },
      disk_path: null,
      directory: 'alpha',
    },
    {
      id: 's2',
      name: 'beta',
      display_name: 'Beta',
      description: 'Another skill',
      installed_at: '2026-01-01T00:00:00Z',
      apps: { claude: false, codex: true, gemini: false, opencode: false },
      disk_path: null,
      directory: 'beta',
    },
  ],
  isLoading: false,
  error: null,
  fetchInstalled,
  listImportable,
  uninstallSkill,
  toggleApp,
  getSkillContent,
  syncBuiltins,
  importFromApps,
};

vi.mock('../../stores/skillStore', () => ({
  useSkillStore: (selector?: (state: typeof mockState) => unknown) =>
    selector ? selector(mockState) : mockState,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../agent/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

describe('SkillsSettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders 4 agent icon toggles per skill', async () => {
    const { SkillsSettingsPanel } = await import('./SkillsSettings');
    render(<SkillsSettingsPanel />);

    expect(screen.getByLabelText('toggle-s1-claude')).toBeTruthy();
    expect(screen.getByLabelText('toggle-s1-codex')).toBeTruthy();
    expect(screen.getByLabelText('toggle-s1-gemini')).toBeTruthy();
    expect(screen.getByLabelText('toggle-s1-opencode')).toBeTruthy();

    expect(screen.getByLabelText('toggle-s2-claude')).toBeTruthy();
    expect(screen.getByLabelText('toggle-s2-codex')).toBeTruthy();
  });

  it('clicking an agent icon triggers toggleApp', async () => {
    const { SkillsSettingsPanel } = await import('./SkillsSettings');
    render(<SkillsSettingsPanel />);

    fireEvent.click(screen.getByLabelText('toggle-s1-codex'));
    expect(toggleApp).toHaveBeenCalledWith('s1', 'codex', true);

    fireEvent.click(screen.getByLabelText('toggle-s1-gemini'));
    expect(toggleApp).toHaveBeenCalledWith('s1', 'gemini', true);
  });

  it('shows uninstall button for all skills', async () => {
    const { SkillsSettingsPanel } = await import('./SkillsSettings');
    render(<SkillsSettingsPanel />);

    // Both skills should have a trash button (no builtin protection)
    const trashButtons = screen.getAllByRole('button').filter(
      (btn) => btn.querySelector('[class*="lucide"]') || btn.getAttribute('class')?.includes('destructive'),
    );
    expect(trashButtons.length).toBeGreaterThanOrEqual(2);
  });

  it('opens import dialog and scans importable skills on click', async () => {
    const { SkillsSettingsPanel } = await import('./SkillsSettings');
    render(<SkillsSettingsPanel />);

    fireEvent.click(screen.getByText('从工具导入'));
    await waitFor(() => {
      expect(listImportable).toHaveBeenCalled();
    });
  });
});
