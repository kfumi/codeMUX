// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 静态导入:如果在 it() 内 await import,首次模块图加载会计入测试超时(15s)。
import { ThemeToggle } from './ThemeToggle';

const setUiFontFamily = vi.fn();
const setContrast = vi.fn();
const setUiFontSize = vi.fn();
const setTheme = vi.fn();

// 可变状态:默认浅色 + azure,个别用例切到「跟随系统」与「黑白」档来验证解析逻辑。
const uiState = vi.hoisted(() => ({
  theme: 'Light' as 'Light' | 'Dark' | 'System',
  accent: 'azure',
}));

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: { config: { theme: string }; setTheme: typeof setTheme }) => unknown) =>
    selector({ config: { theme: uiState.theme }, setTheme }),
}));

vi.mock('../../stores/appearanceStore', () => ({
  useAppearanceStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    prefs: {
      accent: uiState.accent,
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
    setTheme.mockClear();
    uiState.theme = 'Light';
    uiState.accent = 'azure';
    Element.prototype.scrollIntoView = vi.fn();
    // jsdom 没实现 matchMedia / ResizeObserver,Radix 的浮层要这两样。
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

  it('跟随系统时色点、十六进制与显示名按系统深浅解析,而不是恒按浅色', () => {
    uiState.theme = 'System';
    uiState.accent = 'graphite';
    // 系统为深色:面板必须显示白色那一面(hex + 色点 + 名称「白」)。
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-color-scheme: dark'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    render(<ThemeToggle />);

    expect(screen.getByText(accentSwatch('graphite', true).toUpperCase())).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '强调色' }).textContent).toContain('白色');
  });

  it('模式行在面板里可选,选中项回写主题', () => {
    render(<ThemeToggle />);

    expect(screen.getByRole('radio', { name: '浅色' })).toHaveProperty('checked', true);
    fireEvent.click(screen.getByRole('radio', { name: '深色' }));
    expect(setTheme).toHaveBeenCalledWith('Dark');
  });

  it('模式行是「标题在左、缩略图在右」的设置行,不是标题下再摆一排', () => {
    render(<ThemeToggle />);

    const group = screen.getByRole('radiogroup', { name: '模式' });
    // 控件格 → 设置行:同一行里既有这一排缩略图,也有左边的可见标题。
    const row = group.parentElement!.parentElement as HTMLElement;
    expect(row.className).toContain('grid');
    expect(row.textContent).toContain('模式');
    for (const label of ['跟随系统', '浅色', '深色']) {
      expect(screen.getByRole('radio', { name: label }).closest('[role=radiogroup]')).toBe(group);
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

  it('对比度滑块的轨道是强调色渐变,把手交给原生 thumb', () => {
    render(<ThemeToggle />);

    const slider = screen.getByRole('slider', { name: '对比度' });
    // 轨道就是 input 自己:2px 高,背景是一条**静态**的强调色渐变(强调色 35% 混表面
    // → 纯强调色),不随当前值分段,和 Codex 一样。
    expect(slider.className).toContain('h-0.5');
    expect(slider.style.background).toContain('linear-gradient');
    expect(slider.style.background).toContain('hsl(var(--primary) / 0.35)');
    // 20px 的把手要落在 2px 的轨道正中:(2 - 20) / 2 = -9px,位置是算出来的。
    expect(slider.className).toContain('[&::-webkit-slider-thumb]:mt-[-9px]');
    expect(slider.className).toContain('[&::-webkit-slider-thumb]:h-5');
    // 控件格必须有确定宽度:否则 flex-1 的轨道在自动宽度的列里被解成 0,整条滑块
    // 塌成一个点贴在数字左边。
    expect((slider.parentElement as HTMLElement).className).toContain('sm:w-56');
  });

  it('高级区默认摊开,可以收起', () => {    render(<ThemeToggle />);

    const trigger = screen.getByText('高级').closest('button');
    expect(trigger).toHaveProperty('ariaExpanded', 'true');
    expect(screen.getByText('代码字体大小')).toBeTruthy();

    fireEvent.click(trigger!);
    expect(trigger).toHaveProperty('ariaExpanded', 'false');
  });
});
