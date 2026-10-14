// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 静态导入:如果在 it() 内 await import,首次模块图加载会计入测试超时(15s)。
import { ThemeToggle } from './ThemeToggle';

const setUiFontFamily = vi.fn();
const setContrast = vi.fn();
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
        uiFontFamily: '',
      uiFontSize: 14,
      codeFontSize: 13,
      radius: 'soft',
      contentWidth: 'fixed',
    },
    setAccent: vi.fn(),
    setContrast,
    setUiFontFamily,
    setUiFontSize,
    setCodeFontSize: vi.fn(),
    setRadius: vi.fn(),
    setContentWidth: vi.fn(),
    reset: vi.fn(),
  }),
}));

import { ACCENTS, accentSwatch, UI_FONT_SIZE_MAX, UI_FONT_SIZE_MIN } from '../../lib/appearance';

vi.mock('../../lib/systemFonts', () => ({
  loadSystemFonts: vi.fn().mockResolvedValue(['Segoe UI', 'Microsoft YaHei UI']),
}));

describe('ThemeToggle', () => {
  beforeEach(() => {
    setUiFontFamily.mockClear();
    setUiFontSize.mockClear();
    setContrast.mockClear();
    Element.prototype.scrollIntoView = vi.fn();
    // jsdom 没实现 matchMedia —— 「跟随系统」那张缩略图要按系统偏好画。
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
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

  it('不再提供 diff 取色器 —— 差异标记已从外观页移除', () => {
    render(<ThemeToggle />);

    expect(screen.queryByText('差异标记')).toBeNull();
    expect(document.querySelector('input[type=color]')).toBeNull();
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

  it('每张缩略图画一扇完整的窗,不做左右对半切', () => {
    render(<ThemeToggle />);

    // 之前把「跟随系统」劈成两半 36px 的小窗,缩出来什么也看不清 —— 钉住每张
    // 缩略图底下只有一扇窗。
    for (const label of ['浅色', '深色', '跟随系统']) {
      const thumb = screen.getByRole('button', { name: label });
      expect(thumb.children).toHaveLength(1);
    }
  });

  it('模式行是「标题在左、缩略图在右」的设置行,不是标题下再摆一排', () => {
    render(<ThemeToggle />);

    const thumb = screen.getByRole('button', { name: '浅色' });
    const controlCell = thumb.closest('.grid');
    expect(controlCell).not.toBeNull();
    expect(controlCell!.textContent).toContain('模式');
    // 三张缩略图都在同一行的控件格里（缩略图只有 aria-label，没有可见文字）
    for (const label of ['浅色', '深色', '跟随系统']) {
      expect(screen.getByRole('button', { name: label }).closest('.grid')).toBe(controlCell);
    }
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

  it('对比度滑块的轨道与把手都是自绘的,input 只当命中区', () => {
    render(<ThemeToggle />);

    const slider = screen.getByRole('slider', { name: '对比度' });
    // 原生把手必须彻底不参与布局 —— 之前正是它和自绘轨道各自居中,
    // 把手浮在轨道下面半截(见 92dd39c 的修复说明)。
    expect(slider.className).toContain('opacity-0');

    // 自绘把手:aria-hidden 的定位圆点,left 跟着当前值走。
    const thumb = document.querySelector('span[aria-hidden="true"].rounded-full.border-2');
    expect(thumb).not.toBeNull();
    expect((thumb as HTMLElement).style.left).toBe('45%');
  });

  it('高级区默认摊开,可以收起', () => {    render(<ThemeToggle />);

    const trigger = screen.getByText('高级').closest('button');
    expect(trigger).toHaveProperty('ariaExpanded', 'true');
    expect(screen.getByText('代码字体大小')).toBeTruthy();

    fireEvent.click(trigger!);
    expect(trigger).toHaveProperty('ariaExpanded', 'false');
  });
});
