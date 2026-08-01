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
  it('使用外层线程面板滚动，不创建嵌套滚动容器', () => {
    const { container } = render(<ReasoningText />);

    const className = container.firstElementChild?.className ?? '';

    expect(className).not.toContain('max-h-64');
    expect(className).not.toContain('overflow-y-auto');
  });
});

describe('ReasoningContent', () => {
  it('非流式展开时不渲染底部渐变遮罩', () => {
    const { container } = render(
      <ReasoningRoot defaultOpen>
        <ReasoningContent>
          <ReasoningText>思考详情</ReasoningText>
        </ReasoningContent>
      </ReasoningRoot>,
    );

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

    expect(container.querySelector('[data-slot="reasoning-content"]')).not.toBeNull();
    const fades = [...container.querySelectorAll('[data-slot="reasoning-fade"]')];
    expect(fades.some((fade) => fade.className.includes('bottom-0'))).toBe(true);
  });
});
