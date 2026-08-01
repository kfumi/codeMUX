// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ReasoningContent, ReasoningRoot, ReasoningText } from './reasoning';

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
  it('流式状态自动展开并渲染底部渐变遮罩', () => {
    const { container } = render(
      <ReasoningRoot streaming>
        <ReasoningContent>
          <ReasoningText>正在思考</ReasoningText>
        </ReasoningContent>
      </ReasoningRoot>,
    );

    const content = container.querySelector('[data-slot="reasoning-content"]');
    expect(content).not.toBeNull();
    expect(content?.className).not.toContain('max-h-[min(36vh,24rem)]');
    const fades = [...container.querySelectorAll('[data-slot="reasoning-fade"]')];
    expect(fades.some((fade) => fade.className.includes('bottom-0'))).toBe(true);
  });
});
