// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 静态导入:如果在 it() 内 await import,首次模块图加载会计入测试超时(15s)。
import { ThemeToggle } from './ThemeToggle';

const setUiFontFamily = vi.fn();
const setContrast = vi.fn();
const setDiffColor = vi.fn();
const setUiFontSize = vi.fn();

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
    setUiFontSize,
    setCodeFontSize: vi.fn(),
    setRadius: vi.fn(),
    setContentWidth: vi.fn(),
    reset: vi.fn(),
  }),
}));

import { ACCENTS, accentSwatch, UI_FONT_SIZE_MAX, UI_FONT_SIZE_MIN } from '../../lib/appearance';
import { SEMANTIC_SEEDS } from '../../lib/colorDerivation';

vi.mock('../../lib/systemFonts', () => ({
  loadSystemFonts: vi.fn().mockResolvedValue(['Segoe UI', 'Microsoft YaHei UI']),
}));

describe('ThemeToggle', () => {
  beforeEach(() => {
    setUiFontFamily.mockClear();
    setUiFontSize.mockClear();
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

  it('按 Codex 的版式:分组小标题 + 左标题右控件的行', () => {
    render(<ThemeToggle />);

    // 分组小标题而不是大标题
    expect(screen.getByText('视觉风格')).toBeTruthy();
    // 行:标题在左、控件在右
    expect(screen.getByText('强调色')).toBeTruthy();
    expect(screen.getByText('界面字体')).toBeTruthy();
    expect(screen.getByText('圆角风格')).toBeTruthy();
    expect(screen.getByText('幕布宽度')).toBeTruthy();
    // 强调色右侧直接给出当前生效的十六进制
    expect(screen.getByText(accentSwatch('azure', false).toUpperCase())).toBeTruthy();
    // 下拉触发器回显当前预设名 + 色点（Radix 的 SelectValue 渲染选中项 children）
    const accentTrigger = screen.getByRole('combobox', { name: '强调色' });
    expect(accentTrigger.textContent).toContain(ACCENTS.azure.name);
  });

  it('模式是一排三张缩略图,当前项 aria-pressed', () => {
    render(<ThemeToggle />);

    for (const label of ['浅色', '深色', '跟随系统']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: '浅色' })).toHaveProperty('ariaPressed', 'true');
    expect(screen.getByRole('button', { name: '深色' })).toHaveProperty('ariaPressed', 'false');
  });

  it('字号用数值框而不是步进器,并把越界值夹回区间', () => {
    render(<ThemeToggle />);

    const field = screen.getByLabelText('界面字号');
    expect(field).toHaveProperty('type', 'number');

    fireEvent.change(field, { target: { value: '99' } });
    expect(setUiFontSize).toHaveBeenCalledWith(UI_FONT_SIZE_MAX);

    fireEvent.change(field, { target: { value: '-5' } });
    expect(setUiFontSize).toHaveBeenCalledWith(UI_FONT_SIZE_MIN);

    fireEvent.change(field, { target: { value: '16' } });
    expect(setUiFontSize).toHaveBeenCalledWith(16);
  });

  it('高级区默认摊开,可以收起', () => {
    render(<ThemeToggle />);

    const trigger = screen.getByText('高级').closest('button');
    expect(trigger).toHaveProperty('ariaExpanded', 'true');
    expect(screen.getByText('代码字体大小')).toBeTruthy();

    fireEvent.click(trigger!);
    expect(trigger).toHaveProperty('ariaExpanded', 'false');
  });
});
