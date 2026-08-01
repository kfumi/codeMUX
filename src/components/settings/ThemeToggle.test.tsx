// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setUiFont = vi.fn();
const setUiFontSize = vi.fn();

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: { config: { theme: 'Light' }; setTheme: ReturnType<typeof vi.fn> }) => unknown) =>
    selector({ config: { theme: 'Light' }, setTheme: vi.fn() }),
}));

vi.mock('../../stores/appearanceStore', () => ({
  useAppearanceStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    prefs: { accent: 'azure', uiFont: 'inter', uiFontSize: 14, radius: 'soft', contentWidth: 'fixed' },
    setAccent: vi.fn(),
    setUiFont,
    setUiFontSize,
    setRadius: vi.fn(),
    setContentWidth: vi.fn(),
    reset: vi.fn(),
  }),
}));

describe('ThemeToggle', () => {
  beforeEach(() => {
    setUiFont.mockClear();
    setUiFontSize.mockClear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('exposes offline font options and keyboard-sized increment controls', async () => {
    const { ThemeToggle } = await import('./ThemeToggle');
    render(<ThemeToggle />);

    expect(screen.getByText('界面字体')).toBeTruthy();
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: /IBM Plex Sans/ }));
    expect(setUiFont).toHaveBeenCalledWith('ibm-plex-sans');

    fireEvent.click(screen.getByRole('button', { name: '减小界面字号' }));
    fireEvent.click(screen.getByRole('button', { name: '增大界面字号' }));
    expect(setUiFontSize).toHaveBeenNthCalledWith(1, 13);
    expect(setUiFontSize).toHaveBeenNthCalledWith(2, 15);
  });
});
