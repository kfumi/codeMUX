// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ReasoningContent, ReasoningRoot, ReasoningText, ReasoningTrigger } from './reasoning';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
  },
);

describe('ReasoningText', () => {
  it('正文节点本身不创建滚动容器', () => {
    const { container } = render(<ReasoningText />);

    const className = container.firstElementChild?.className ?? '';

    expect(className).not.toContain('max-h-64');
    expect(className).not.toContain('overflow-y-auto');
  });
});

describe('ReasoningContent', () => {
  it('非流式展开时限制高度并允许面板内部滚动', () => {
    const { container } = render(
      <ReasoningRoot defaultOpen>
        <ReasoningContent>
          <ReasoningText>思考详情</ReasoningText>
        </ReasoningContent>
      </ReasoningRoot>,
    );

    const content = container.querySelector('[data-slot="reasoning-content"]');
    expect(content?.className).toContain('max-h-[min(36vh,24rem)]');
    expect(content?.className).toContain('overflow-y-auto');

    const fades = [...container.querySelectorAll('[data-slot="reasoning-fade"]')];
    expect(fades.some((fade) => fade.className.includes('bottom-0'))).toBe(false);
  });
});

describe('ReasoningRoot', () => {
  it('流式状态默认折叠', () => {
    const { container } = render(
      <ReasoningRoot streaming>
        <ReasoningTrigger />
        <ReasoningContent>
          <ReasoningText>正在思考</ReasoningText>
        </ReasoningContent>
      </ReasoningRoot>,
    );

    const content = container.querySelector('[data-slot="reasoning-content"]');
    expect(content).not.toBeNull();
    expect(container.querySelector('[data-slot="reasoning-trigger"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-slot="reasoning-trigger"]')?.className).toContain('font-normal');
    expect(container.querySelector('[data-slot="reasoning-trigger-chevron"]')?.getAttribute('class')).toContain('opacity-0');
    expect(container.querySelector('[data-slot="reasoning-trigger-chevron"]')?.getAttribute('class')).toContain('group-hover/trigger:opacity-100');
    expect(content?.className).toContain('max-h-[min(36vh,24rem)]');
  });
});

describe('ReasoningTrigger active 状态', () => {
  it('active 时图标带呼吸脉冲，文字保持单份（无 shimmer 叠层）', () => {
    const { container } = render(
      <ReasoningRoot>
        <ReasoningTrigger active />
      </ReasoningRoot>,
    );

    const icon = container.querySelector('[data-slot="reasoning-trigger-icon"]');
    expect(icon?.getAttribute('class')).toContain('animate-pulse-soft');
    expect(container.querySelector('[data-slot="reasoning-trigger-shimmer"]')).toBeNull();
    expect(container.querySelectorAll('[data-slot="reasoning-trigger-label"] > span')).toHaveLength(1);
  });

  it('非 active 时图标不带脉冲', () => {
    const { container } = render(
      <ReasoningRoot>
        <ReasoningTrigger />
      </ReasoningRoot>,
    );

    expect(container.querySelector('[data-slot="reasoning-trigger-icon"]')?.getAttribute('class')).not.toContain('animate-pulse-soft');
  });
});
