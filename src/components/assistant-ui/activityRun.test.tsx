// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ActivityStepThinking,
  thinkingSummaryLine,
} from './activity-run';

/** jsdom 默认没有 matchMedia：窄屏判定按 innerWidth（与实现一致）。 */
function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: undefined,
  });
}

afterEach(() => {
  cleanup();
  setViewport(1280);
});

describe('thinkingSummaryLine', () => {
  it('取开头那段并去掉标题与强调标记，压成单行', () => {
    expect(thinkingSummaryLine('# 标题\n\n**正在核对**任务入口')).toBe('标题 正在核对任务入口');
    expect(thinkingSummaryLine('第一行\n## 结尾这一行')).toBe('第一行 结尾这一行');
    expect(thinkingSummaryLine('')).toBe('');
  });
});

describe('ActivityStepThinking', () => {
  it('行壳是「思考 + 单行摘要」，正文默认不渲染', () => {
    const { container } = render(<ActivityStepThinking text={'先看目录结构\n再核对任务入口'} />);

    const trigger = container.querySelector('[data-slot="reasoning-trigger"]');
    // 摘要嵌在 label 里（两者按基线对齐），所以断言文档顺序，而不是直接子元素顺序。
    const slots = Array.from(trigger?.querySelectorAll('[data-slot]') ?? []).map((element) =>
      element.getAttribute('data-slot'),
    );

    expect(slots).toEqual([
      'reasoning-trigger-icon',
      'reasoning-trigger-label',
      'reasoning-trigger-summary',
      'reasoning-trigger-chevron',
    ]);
    expect(container.querySelector('[data-slot="reasoning-trigger-label"]')?.textContent?.startsWith('思考')).toBe(true);
    expect(container.querySelector('[data-slot="reasoning-trigger-summary"]')?.textContent).toBe('先看目录结构 再核对任务入口');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-slot="activity-step-body"]')).toBeNull();
  });

  it('展开后渲染这段思考的 Markdown 正文', () => {
    const { container } = render(<ActivityStepThinking text="先看目录结构" />);

    fireEvent.click(screen.getByRole('button', { name: '展开思考内容' }));

    const body = container.querySelector('[data-slot="activity-step-body"]');
    expect(body?.textContent).toContain('先看目录结构');
    expect(container.querySelector('[data-slot="reasoning-trigger"]')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('实时思考默认展开并带脉冲点', () => {
    const { container } = render(<ActivityStepThinking text="正在分析" streaming />);

    expect(container.querySelector('[data-slot="reasoning-trigger"]')?.getAttribute('aria-expanded')).toBe('true');
    // SVG 的 className 是对象，断言要走 getAttribute('class')。
    expect(container.querySelector('[data-slot="reasoning-trigger-pulse"]')?.getAttribute('class'))
      .toContain('animate-pulse');
  });

  it('流式思考不画行内单行摘要，思考结束收起后才显示', () => {
    const { container, rerender } = render(
      <ActivityStepThinking text={'先看目录结构\n再核对任务入口'} streaming />,
    );

    // 流式中这一行默认展开、正文就在下面：右侧摘要不跟着 delta 实时变长。
    expect(container.querySelector('[data-slot="reasoning-trigger"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-slot="reasoning-trigger-summary"]')).toBeNull();
    expect(container.querySelector('[data-slot="reasoning-trigger-label"]')?.textContent).toBe('思考');

    rerender(<ActivityStepThinking text={'先看目录结构\n再核对任务入口'} streaming={false} />);

    // 思考结束、行收起：这时一次性给出摘要。
    expect(container.querySelector('[data-slot="reasoning-trigger"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-slot="reasoning-trigger-summary"]')?.textContent)
      .toBe('先看目录结构 再核对任务入口');
  });

  it('已结束的思考步骤默认收起，不渲染正文', () => {
    const { container } = render(<ActivityStepThinking text="先看目录结构" streaming={false} />);

    expect(container.querySelector('[data-slot="reasoning-trigger"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-slot="activity-step-body"]')).toBeNull();
  });

  it('实时思考默认展开并渲染正文', () => {
    const { container } = render(<ActivityStepThinking text="正在分析" streaming body={<pre>正在分析</pre>} />);

    expect(container.querySelector('[data-slot="reasoning-trigger"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-slot="activity-step-body"]')?.textContent).toContain('正在分析');
  });

  it('思考结束（streaming 由 true 变 false）后详情自动收起', () => {
    const { container, rerender } = render(<ActivityStepThinking text="正在分析" streaming />);
    expect(container.querySelector('[data-slot="activity-step-body"]')).toBeTruthy();

    rerender(<ActivityStepThinking text="正在分析" streaming={false} />);

    expect(container.querySelector('[data-slot="activity-step-body"]')).toBeNull();
    expect(container.querySelector('[data-slot="reasoning-trigger"]')?.getAttribute('aria-expanded')).toBe('false');
    // 收起后按钮语义回到「展开」。
    expect(screen.getByRole('button', { name: '展开思考内容' })).toBeTruthy();
  });

  it('用户点开后 streaming 变化不再覆盖用户的展开状态', () => {
    const { container, rerender } = render(<ActivityStepThinking text="先看目录结构" streaming={false} />);
    expect(container.querySelector('[data-slot="activity-step-body"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '展开思考内容' }));
    expect(container.querySelector('[data-slot="activity-step-body"]')).toBeTruthy();

    // 实时开始：用户已接管，保持展开。
    rerender(<ActivityStepThinking text="先看目录结构" streaming />);
    expect(container.querySelector('[data-slot="activity-step-body"]')).toBeTruthy();

    // 实时结束：不再被自动收起。
    rerender(<ActivityStepThinking text="先看目录结构" streaming={false} />);
    expect(container.querySelector('[data-slot="activity-step-body"]')).toBeTruthy();
    expect(container.querySelector('[data-slot="reasoning-trigger"]')?.getAttribute('aria-expanded')).toBe('true');

    // 用户手动再收起后，实时中也不会被自动展开。
    fireEvent.click(screen.getByRole('button', { name: '收起思考内容' }));
    expect(container.querySelector('[data-slot="activity-step-body"]')).toBeNull();
    rerender(<ActivityStepThinking text="先看目录结构" streaming />);
    expect(container.querySelector('[data-slot="activity-step-body"]')).toBeNull();
  });
});
