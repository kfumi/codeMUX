// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 静态导入:如果在 it() 内 await import,首次模块图加载会计入测试超时(15s)。
import { ThemeToggle } from './ThemeToggle';

const setUiFontFamily = vi.fn();
const setContrast = vi.fn();
const setDiffColor = vi.fn();

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: { config: { theme: 'Light' }; setTheme: ReturnType<typeof vi.fn> }) => unknown) =>
    selector({ config: { theme: 'Light' }, setTheme: vi.fn() }),
}));

vi.mock('../../stores/appearanceStore', () => ({
  useAppearanceStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    prefs: {
      accent: 'azure',
      contrast: 45,
      diff: {},
      uiFontFamily: '',
      uiFontSize: 14,
      codeFontSize: 13,
      radius: 'soft',
      contentWidth: 'fixed',
    },
    setAccent: vi.fn(),
    setContrast,
    setDiffColor,
    setUiFontFamily,
    setUiFontSize: vi.fn(),
    setCodeFontSize: vi.fn(),
    setRadius: vi.fn(),
    setContentWidth: vi.fn(),
    reset: vi.fn(),
  }),
}));

import { SEMANTIC_SEEDS } from '../../lib/colorDerivation';

vi.mock('../../lib/systemFonts', () => ({
  loadSystemFonts: vi.fn().mockResolvedValue(['Segoe UI', 'Microsoft YaHei UI']),
}));

describe('ThemeToggle', () => {
  beforeEach(() => {
    setUiFontFamily.mockClear();
    setContrast.mockClear();
    setDiffColor.mockClear();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('loads system fonts and applies the selected family', async () => {
    render(<ThemeToggle />);

    expect(screen.getByText('界面字体')).toBeTruthy();
    fireEvent.click(screen.getByRole('combobox', { name: '界面字体' }));
    fireEvent.click(await screen.findByText('Microsoft YaHei UI'));
    expect(setUiFontFamily).toHaveBeenCalledWith('Microsoft YaHei UI');
  });

  it('drives the contrast knob from 0 to 100', () => {
    render(<ThemeToggle />);

    const slider = screen.getByRole('slider', { name: '对比度' });
    expect(slider).toHaveProperty('value', '45');
    expect(slider).toHaveProperty('min', '0');
    expect(slider).toHaveProperty('max', '100');

    fireEvent.change(slider, { target: { value: '82' } });
    expect(setContrast).toHaveBeenCalledWith(82);
  });

  it('shows four diff color pickers and writes the picked hex', () => {
    render(<ThemeToggle />);

    const added = screen.getByLabelText('浅色 · 新增');
    const removed = screen.getByLabelText('深色 · 删除');
    fireEvent.change(added, { target: { value: '#123456' } });
    fireEvent.change(removed, { target: { value: '#654321' } });
    expect(setDiffColor).toHaveBeenCalledWith('lightAdded', '#123456');
    expect(setDiffColor).toHaveBeenCalledWith('darkRemoved', '#654321');
  });

  it('offers no reset button until a diff color is customized', () => {
    render(<ThemeToggle />);

    expect(screen.queryByLabelText('浅色 · 新增恢复默认')).toBeNull();
    expect(screen.getByLabelText('浅色 · 新增')).toHaveProperty('value', SEMANTIC_SEEDS.light.diffAdded);
  });
});
