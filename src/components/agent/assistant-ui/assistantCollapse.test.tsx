// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AssistantCollapseToggle } from '@/components/agent/assistant-ui/assistantCollapse';

/** DOM 顺序断言：a 是否排在 b 之前。 */
function comesFirst(a: Element | null | undefined, b: Element | null | undefined): boolean {
  return Boolean(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
}

/**
 * 「已处理」整轮开关（精简 AI 输出）：它是它领起的那块内容的标题。
 * - 标题下那条分隔线在展开与收起两种状态都必须存在，否则「开关 → 下面内容」的距离
 *   会在切换时变化（用户反馈过这个跳动）。
 * - 字号两档：时间与开关名同字号（都继承按钮上的 `text-ui-body`），步骤数小一号
 *   （`text-ui-compact`）——步骤数是旁注，不该和时长并列。
 * - 步骤里有工具异常时，步骤数前面先出警示图标。
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

  it('标题是「已处理 + 时长」，时间与它同字号', () => {
    const { container } = render(
      <AssistantCollapseToggle expanded={false} durationMs={30000} onClick={() => {}} />,
    );

    const toggle = container.querySelector('button');
    expect(toggle?.getAttribute('aria-label')).toBe('展开AI过程');
    expect(toggle?.className).toContain('text-ui-body');
    expect(toggle?.textContent).toContain('已处理');

    const duration = toggle?.querySelector('[data-slot="assistant-collapse-duration"]');
    expect(duration?.textContent).toBe('30s');
    // 时间不能自带更小的字号档位（否则会与「已处理」错层）。
    expect(duration?.className ?? '').not.toMatch(/text-ui-(micro|caption|meta|compact)/);
  });

  it('时长写得出秒：整轮标题是 `已处理 2h 32m 14s`', () => {
    const { container } = render(
      <AssistantCollapseToggle expanded={false} durationMs={9_134_000} onClick={() => {}} />,
    );

    expect(container.querySelector('[data-slot="assistant-collapse-duration"]')?.textContent)
      .toBe('2h 32m 14s');
  });

  it('步骤数小一号：排在时长之后、chevron 之前', () => {
    const { container } = render(
      <AssistantCollapseToggle expanded={false} durationMs={30000} stepCount={349} onClick={() => {}} />,
    );

    const toggle = container.querySelector('button');
    const duration = toggle?.querySelector('[data-slot="assistant-collapse-duration"]');
    const steps = toggle?.querySelector('[data-slot="assistant-collapse-steps"]');

    expect(steps?.textContent).toBe('349 个步骤');
    expect(steps?.className).toContain('text-ui-compact');
    expect(steps?.className).toContain('tabular-nums');
    expect(comesFirst(duration, steps)).toBe(true);
    expect(comesFirst(steps, toggle?.querySelector('.lucide-chevron-right'))).toBe(true);

    // 层次靠两档文字色：标题是主文字，步骤数浅一档（且 hover 不跟着按钮变亮）。
    expect(steps?.className).toContain('text-muted-foreground');
    expect(toggle?.querySelector('[data-slot="assistant-collapse-title"]')?.className)
      .toContain('text-foreground');
    // 时长跟「已处理」同档：它不能自带更浅的颜色档位。
    expect(duration?.className ?? '').not.toContain('text-muted-foreground');
  });

  it('步骤里有工具异常时，警示图标排在步骤数前面', () => {
    const { container } = render(
      <AssistantCollapseToggle
        expanded={false}
        durationMs={30000}
        stepCount={12}
        hasError
        onClick={() => {}}
      />,
    );

    const toggle = container.querySelector('button');
    const icon = toggle?.querySelector('.lucide-circle-alert');
    const steps = toggle?.querySelector('[data-slot="assistant-collapse-steps"]');

    expect(icon).toBeTruthy();
    expect(icon?.getAttribute('class')).toContain('text-destructive');
    expect(comesFirst(icon, steps)).toBe(true);

    // 按钮的可访问名是动作名（aria-label），状态得靠 aria-describedby 播报。
    const status = document.getElementById(toggle?.getAttribute('aria-describedby') ?? '');
    expect(status?.textContent).toBe('已处理 30s，12 个步骤，过程步骤里有异常');
  });

  it('没有异常时不出现警示图标', () => {
    const { container } = render(
      <AssistantCollapseToggle expanded={false} durationMs={30000} stepCount={12} onClick={() => {}} />,
    );

    expect(container.querySelector('.lucide-circle-alert')).toBeNull();
  });

  it('没有步骤与时长时只留开关名', () => {
    const { container } = render(<AssistantCollapseToggle expanded={false} onClick={() => {}} />);

    expect(container.querySelector('[data-slot="assistant-collapse-steps"]')).toBeNull();
    expect(container.querySelector('[data-slot="assistant-collapse-duration"]')).toBeNull();
    expect(container.querySelector('button')?.textContent).toContain('已处理');
  });

  it('点击开关回调一次', () => {
    const onClick = vi.fn();
    const { container } = render(<AssistantCollapseToggle expanded={false} onClick={onClick} />);

    const toggle = container.querySelector('button');
    fireEvent.click(toggle as HTMLElement);

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
