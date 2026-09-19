// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AssistantCollapseToggle } from '@/components/agent/assistant-ui/assistantCollapse';

/**
 * 「本轮处理」整轮开关（精简 AI 输出）：它是它领起的那块内容的标题。
 * - 标题下那条分隔线在展开与收起两种状态都必须存在，否则「开关 → 下面内容」的距离
 *   会在切换时变化（用户反馈过这个跳动）。
 * - 时间与开关名同字号：两者都继承按钮上的 `text-ui-body`，时间不能自带更小的档位。
 */
describe('AssistantCollapseToggle', () => {
  it('展开与收起都在标题下留同一条分隔线', () => {
    const { container, rerender } = render(
      <AssistantCollapseToggle expanded={false} durationMs={30000} onClick={() => {}} />,
    );
    expect(container.querySelector('[data-slot="assistant-collapse-divider"]')).toBeTruthy();

    rerender(<AssistantCollapseToggle expanded durationMs={30000} onClick={() => {}} />);
    expect(container.querySelector('[data-slot="assistant-collapse-divider"]')).toBeTruthy();
  });

  it('时间与「已处理」同字号：都走按钮上的 text-ui-body', () => {
    const { container } = render(
      <AssistantCollapseToggle expanded={false} durationMs={30000} onClick={() => {}} />,
    );

    const toggle = container.querySelector('button');
    expect(toggle?.getAttribute('aria-label')).toBe('展开AI过程');
    expect(toggle?.className).toContain('text-ui-body');

    const time = Array.from(toggle?.querySelectorAll('span') ?? []).find((span) =>
      span.textContent?.includes('30'),
    );
    expect(time?.textContent).toBe('30s');
    // 时间不能自带更小的字号档位（否则会与「已处理」错层）。
    expect(time?.className ?? '').not.toMatch(/text-ui-(micro|caption|meta|compact)/);
  });

  it('点击开关回调一次', () => {
    const onClick = vi.fn();
    const { container } = render(<AssistantCollapseToggle expanded={false} onClick={onClick} />);

    const toggle = container.querySelector('button');
    fireEvent.click(toggle as HTMLElement);

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
