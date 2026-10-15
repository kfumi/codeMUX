// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModeRow } from './ModeRow';

describe('ModeRow', () => {
  beforeEach(() => {
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

  it('按 Codex 的顺序排三张:跟随系统、浅色、深色', () => {
    render(<ModeRow theme="Light" onChange={vi.fn()} />);

    const radios = screen.getAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('aria-label'))).toEqual([
      '跟随系统',
      '浅色',
      '深色',
    ]);
    expect(screen.getByRole('radio', { name: '浅色' })).toHaveProperty('checked', true);
    expect(screen.getByRole('radio', { name: '深色' })).toHaveProperty('checked', false);
  });

  it('点一张缩略图就把模式写回设置', () => {
    const onChange = vi.fn();
    render(<ModeRow theme="Light" onChange={onChange} />);

    fireEvent.click(screen.getByRole('radio', { name: '深色' }));
    expect(onChange).toHaveBeenCalledWith('Dark');
    fireEvent.click(screen.getByRole('radio', { name: '跟随系统' }));
    expect(onChange).toHaveBeenCalledWith('System');
  });

  it('跟随系统是左右对半的浅色/深色窗,浅色与深色各是一扇 80×60 的整窗', () => {
    render(<ModeRow theme="Light" onChange={vi.fn()} />);

    const tileOf = (label: string) =>
      screen.getByRole('radio', { name: label }).parentElement as HTMLElement;

    // 跟随系统:两张半幅(视口 0 0 40 60,把 80 宽的底裁掉右半),左边浅色右边深色。
    const systemShots = tileOf('跟随系统').querySelectorAll('svg');
    expect(systemShots).toHaveLength(2);
    expect(systemShots[0].getAttribute('viewBox')).toBe('0 0 40 60');
    expect(systemShots[1].getAttribute('viewBox')).toBe('0 0 40 60');
    expect(systemShots[0].querySelector('rect')?.getAttribute('fill')).toBe('#F4F4F4');
    expect(systemShots[1].querySelector('rect')?.getAttribute('fill')).toBe('#262626');

    // 浅色 / 深色:一扇整窗,画布就是缩略图本身的 80×60。
    for (const [label, desktop] of [
      ['浅色', '#F4F4F4'],
      ['深色', '#262626'],
    ] as const) {
      const shots = tileOf(label).querySelectorAll('svg');
      expect(shots).toHaveLength(1);
      expect(shots[0].getAttribute('viewBox')).toBe('0 0 80 60');
      expect(shots[0].querySelector('rect')?.getAttribute('fill')).toBe(desktop);
    }
  });

  it('缩略图里的强调部分跟着用户选的强调色走', () => {
    render(<ModeRow theme="Light" onChange={vi.fn()} />);

    const shot = screen.getByRole('radio', { name: '浅色' }).parentElement!.querySelector('svg')!;
    expect(shot.getAttribute('class')).toContain('text-primary');
    // 标题行 / 回答行的三条实线取 currentColor,不是写死的蓝。
    const accentRects = [...shot.querySelectorAll('rect')].filter(
      (rect) => rect.getAttribute('fill') === 'currentColor',
    );
    expect(accentRects).toHaveLength(3);
  });

  it('每张插图的滤镜 id 逐实例唯一,同页多张不会互相串色', () => {
    render(<ModeRow theme="Light" onChange={vi.fn()} />);

    // 跟随系统的两半 + 浅色 + 深色,一共四张插图四条滤镜。
    const ids = [...document.querySelectorAll('filter')].map((filter) => filter.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
