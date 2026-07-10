// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ReasoningContent, ReasoningRoot, ReasoningText } from './reasoning';

describe('ReasoningText', () => {
  it('缩小思考内容里 Markdown 块级元素的字号', () => {
    const { container } = render(<ReasoningText />);

    const className = container.firstElementChild?.className ?? '';

    expect(className).toContain('[&_.aui-md-h1]:text-sm');
    expect(className).toContain('[&_.aui-md-h2]:text-sm');
    expect(className).toContain('[&_.aui-md-h3]:text-xs');
    expect(className).toContain('[&_.aui-md-table]:text-xs');
    expect(className).toContain("[&_[data-streamdown='code-block']]:text-[11px]");
  });
});

describe('ReasoningContent', () => {
  it('不在思考展开详情底部渲染渐变遮罩', () => {
    const { container } = render(
      <ReasoningRoot defaultOpen>
        <ReasoningContent>
          <ReasoningText>思考详情</ReasoningText>
        </ReasoningContent>
      </ReasoningRoot>,
    );

    expect(container.querySelector('[data-slot="reasoning-fade"]')).toBeNull();
  });
});
