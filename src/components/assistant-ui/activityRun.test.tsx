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

  it('实时思考默认收起并带脉冲点', () => {
    const { container } = render(<ActivityStepThinking text="正在分析" streaming />);

    expect(container.querySelector('[data-slot="reasoning-trigger"]')?.getAttribute('aria-expanded')).toBe('false');
    // SVG 的 className 是对象，断言要走 getAttribute('class')。
    expect(container.querySelector('[data-slot="reasoning-trigger-pulse"]')?.getAttribute('class'))
      .toContain('animate-pulse');
  });

  it('流式思考默认收起，右侧单行摘要用 previewText 实时跟随', () => {
    const { container, rerender } = render(
      <ActivityStepThinking text={'先看目录结构\n再核对任务入口'} streaming previewText="先看目录结构 再核对" />,
    );

    // 流式中这一行保持收起，右侧单行摘要跟着节流揭示的文本走。
    expect(container.querySelector('[data-slot="reasoning-trigger"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-slot="reasoning-trigger-summary"]')?.textContent).toBe('先看目录结构 再核对');
    expect(container.querySelector('[data-slot="reasoning-trigger-label"]')?.textContent?.startsWith('思考')).toBe(true);

    rerender(<ActivityStepThinking text={'先看目录结构\n再核对任务入口'} streaming />);

    // 没有 previewText 时用完整思考文本压成单行。
    expect(container.querySelector('[data-slot="reasoning-trigger-summary"]')?.textContent)
      .toBe('先看目录结构 再核对任务入口');
  });

  it('已结束的思考步骤默认收起，不渲染正文', () => {
    const { container } = render(<ActivityStepThinking text="先看目录结构" streaming={false} />);

    expect(container.querySelector('[data-slot="reasoning-trigger"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-slot="activity-step-body"]')).toBeNull();
  });

  it('实时思考默认收起，展开后才渲染正文', () => {
    const { container } = render(<ActivityStepThinking text="正在分析" streaming body={<pre>正在分析</pre>} />);

    expect(container.querySelector('[data-slot="reasoning-trigger"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-slot="activity-step-body"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '展开思考内容' }));

    expect(container.querySelector('[data-slot="activity-step-body"]')?.textContent).toContain('正在分析');
  });

  it('动作图标带光学对齐微调（CJK 字形带比行盒中心偏上）', () => {
    const { container } = render(<ActivityStepThinking text="正在分析" />);

    // CJK 字形在行盒里偏上（雅黑 ascent ≫ descent），图标按盒居中会显得比右边文字低；
    // 用 em 微调补偿，随界面字号缩放。尺寸同样用 em 跟随界面字号，不能写死像素。
    const icon = container.querySelector('[data-slot="reasoning-trigger-icon"]');
    expect(icon?.getAttribute('class')).toContain('-translate-y-[0.035em]');
    expect(icon?.getAttribute('class')).toContain('size-[1.08em]');
  });

  it('思考结束后自动收起用户展开的实时正文', () => {
    const { container, rerender } = render(<ActivityStepThinking text="正在分析" streaming />);
    // 流式中默认收起，用户展开查看实时正文。
    expect(container.querySelector('[data-slot="activity-step-body"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开思考内容' }));
    expect(container.querySelector('[data-slot="activity-step-body"]')).toBeTruthy();

    rerender(<ActivityStepThinking text="正在分析" streaming={false} />);

    expect(container.querySelector('[data-slot="activity-step-body"]')).toBeNull();
    expect(container.querySelector('[data-slot="reasoning-trigger"]')?.getAttribute('aria-expanded')).toBe('false');
    // 收起后按钮语义回到「展开」。
    expect(screen.getByRole('button', { name: '展开思考内容' })).toBeTruthy();
  });

  it('streaming 状态变化会重置手动展开（开始与结束都回到默认收起）', () => {
    const { container, rerender } = render(<ActivityStepThinking text="先看目录结构" streaming={false} />);
    expect(container.querySelector('[data-slot="activity-step-body"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '展开思考内容' }));
    expect(container.querySelector('[data-slot="activity-step-body"]')).toBeTruthy();

    // 实时开始：重置为默认收起。
    rerender(<ActivityStepThinking text="先看目录结构" streaming />);
    expect(container.querySelector('[data-slot="activity-step-body"]')).toBeNull();
    expect(container.querySelector('[data-slot="reasoning-trigger"]')?.getAttribute('aria-expanded')).toBe('false');

    // 实时中用户再次展开。
    fireEvent.click(screen.getByRole('button', { name: '展开思考内容' }));
    expect(container.querySelector('[data-slot="activity-step-body"]')).toBeTruthy();

    // 实时结束：同样重置为默认收起。
    rerender(<ActivityStepThinking text="先看目录结构" streaming={false} />);
    expect(container.querySelector('[data-slot="activity-step-body"]')).toBeNull();
    expect(container.querySelector('[data-slot="reasoning-trigger"]')?.getAttribute('aria-expanded')).toBe('false');
  });
});

import { useAgentStore } from '@/stores/agentStore';
import { ActivityRunGroupHead } from './activity-run';

describe('ActivityRunGroupHead', () => {
  it('完成态：两个步骤起渲染组头（分类统计），单步骤不渲染', () => {
    const { container, rerender } = render(
      <ActivityRunGroupHead
        stepCount={2}
        live={false}
        open={false}
        onToggle={() => {}}
        completedText="已探索 2 次"
        fallbackTail=""
      />,
    );
    const header = container.querySelector('[data-slot="activity-run-trigger"]');
    expect(header).not.toBeNull();
    expect(header?.getAttribute('aria-expanded')).toBe('false');
    expect(header?.getAttribute('aria-label')).toBe('已探索 2 次');
    expect(container.querySelector('[data-slot="activity-run-pulse"]')).toBeNull();

    rerender(
      <ActivityRunGroupHead
        stepCount={1}
        live={false}
        open={false}
        onToggle={() => {}}
        completedText="已探索 1 次"
        fallbackTail=""
      />,
    );
    expect(container.querySelector('[data-slot="activity-run-trigger"]')).toBeNull();
  });

  it('实时态：无已提交步骤且无实时思考时未达门槛，不渲染', () => {
    useAgentStore.setState((state) => ({
      ...state,
      streamingThinking: { 'session-head-live': '' },
      streamingText: { 'session-head-live': '' },
      forceStopped: {},
    }));
    const { container } = render(
      <ActivityRunGroupHead
        stepCount={0}
        live
        open={false}
        onToggle={() => {}}
        completedText=""
        fallbackTail=""
        sessionId="session-head-live"
      />,
    );
    expect(container.querySelector('[data-slot="activity-run-trigger"]')).toBeNull();
  });

  it('实时态：有实时思考时显示尾部摘要（阈值跨过成组）', () => {
    useAgentStore.setState((state) => ({
      ...state,
      streamingThinking: { 'session-head-live-2': '正在核对任务入口' },
      streamingText: { 'session-head-live-2': '' },
      streamingThinkingStartEventCount: { 'session-head-live-2': 0 },
      events: { 'session-head-live-2': [] },
      forceStopped: {},
    }));
    const { container } = render(
      <ActivityRunGroupHead
        stepCount={1}
        live
        open={false}
        onToggle={() => {}}
        completedText=""
        fallbackTail="package.json"
        sessionId="session-head-live-2"
      />,
    );
    const header = container.querySelector('[data-slot="activity-run-trigger"]');
    expect(header).not.toBeNull();
    expect(header?.getAttribute('data-live')).toBe('true');
    expect(header?.getAttribute('aria-label')).toBe('正在核对任务入口');
    // 组头不画装饰动画（运行状态由实时摘要与「工作中」状态行表达）。
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });

  it('实时态：没有实时思考时回退未决工具摘要，再回退段尾摘要', () => {
    useAgentStore.setState((state) => ({
      ...state,
      streamingThinking: { 'session-head-live-3': '' },
      streamingText: { 'session-head-live-3': '' },
      events: { 'session-head-live-3': [] },
      forceStopped: {},
    }));
    const { container } = render(
      <ActivityRunGroupHead
        stepCount={2}
        live
        open={false}
        onToggle={() => {}}
        completedText="已探索 2 次"
        activeToolSummary="读取 package.json"
        fallbackTail="App.tsx"
        sessionId="session-head-live-3"
      />,
    );
    expect(container.querySelector('[data-slot="activity-run-trigger"]')?.getAttribute('aria-label'))
      .toBe('读取 package.json');

    const { container: fallbackContainer } = render(
      <ActivityRunGroupHead
        stepCount={2}
        live
        open={false}
        onToggle={() => {}}
        completedText="已探索 2 次"
        fallbackTail="App.tsx"
        sessionId="session-head-live-3"
      />,
    );
    expect(fallbackContainer.querySelector('[data-slot="activity-run-trigger"]')?.getAttribute('aria-label'))
      .toBe('App.tsx');
  });
});
