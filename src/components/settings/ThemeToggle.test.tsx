// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setUiFontFamily = vi.fn();

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: { config: { theme: 'Light' }; setTheme: ReturnType<typeof vi.fn> }) => unknown) =>
    selector({ config: { theme: 'Light' }, setTheme: vi.fn() }),
}));

vi.mock('../../stores/appearanceStore', () => ({
  useAppearanceStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    prefs: { accent: 'azure', uiFontFamily: '', uiFontSize: 14, codeFontSize: 13, radius: 'soft', contentWidth: 'fixed' },
    setAccent: vi.fn(),
    setUiFontFamily,
    setUiFontSize: vi.fn(),
    setCodeFontSize: vi.fn(),
    setRadius: vi.fn(),
    setContentWidth: vi.fn(),
    reset: vi.fn(),
  }),
}));

vi.mock('../../lib/systemFonts', () => ({
  loadSystemFonts: vi.fn().mockResolvedValue(['Segoe UI', 'Microsoft YaHei UI']),
}));

describe('ThemeToggle', () => {
  beforeEach(() => {
    setUiFontFamily.mockClear();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  it('loads system fonts and applies the selected family', async () => {
    const { ThemeToggle } = await import('./ThemeToggle');
    render(<ThemeToggle />);

    expect(screen.getByText('界面字体')).toBeTruthy();
    fireEvent.click(screen.getByRole('combobox', { name: '界面字体' }));
    fireEvent.click(await screen.findByText('Microsoft YaHei UI'));
    expect(setUiFontFamily).toHaveBeenCalledWith('Microsoft YaHei UI');
  });
});
