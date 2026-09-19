// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ACTIVITY_RUN_STEP_INDENT,
  ActivityRunHeader,
  ActivityRunSteps,
  ActivityStepThinking,
  activityRunLabel,
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

describe('activityRunLabel', () => {
  it('运行中：有工具用「处理中」，整段只有思考用「思考中」，都带计时', () => {
    expect(activityRunLabel({ live: true, onlyThinking: false, durationMs: 12000 })).toBe('处理中 · 12s');
    expect(activityRunLabel({ live: true, onlyThinking: true, durationMs: 12000 })).toBe('思考中 · 12s');
    expect(activityRunLabel({ live: true, onlyThinking: false, durationMs: 90000 })).toBe('处理中 · 1m 30s');
    // 末步仍在流式的思考：即使段里有工具也读作「思考中」。
    expect(activityRunLabel({ live: true, onlyThinking: false, thinkingNow: true, durationMs: 3000 })).toBe('思考中 · 3s');
  });

  it('结束后：含工具说「已处理」，仅思考说「已思考」', () => {
    expect(activityRunLabel({ live: false, onlyThinking: false, durationMs: 12000 })).toBe('已处理 12s');
    expect(activityRunLabel({ live: false, onlyThinking: true, durationMs: 12000 })).toBe('已思考 12s');
  });

  it('没有计时信息时不硬凑时间', () => {
    expect(activityRunLabel({ live: false, onlyThinking: false })).toBe('已处理');
    expect(activityRunLabel({ live: false, onlyThinking: true })).toBe('思考');
    expect(activityRunLabel({ live: true, onlyThinking: true })).toBe('思考中');
    // 0 是真实时长（瞬时完成的段），照常显示。
    expect(activityRunLabel({ live: false, onlyThinking: false, durationMs: 0 })).toBe('已处理 0s');
  });
});

describe('thinkingSummaryLine', () => {
  it('取开头那段并去掉标题与强调标记，压成单行', () => {
    expect(thinkingSummaryLine('# 标题\n\n**正在核对**任务入口')).toBe('标题 正在核对任务入口');
    expect(thinkingSummaryLine('第一行\n## 结尾这一行')).toBe('第一行 结尾这一行');
    expect(thinkingSummaryLine('')).toBe('');
  });
});

describe('ActivityRunHeader', () => {
  it('渲染图标、文案、步骤数与箭头，步骤数为 1 时不显示计数', () => {
    const { container } = render(
      <ActivityRunHeader
        open={false}
        onToggle={() => {}}
        live={false}
        onlyThinking={false}
        durationMs={12000}
        stepCount={5}
        tail=""
      />,
    );

    const trigger = container.querySelector('[data-slot="activity-run-trigger"]');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-slot="activity-run-icon"]')).toBeTruthy();
    expect(container.querySelector('[data-slot="activity-run-label"]')?.textContent).toBe('已处理 12s');
    expect(container.querySelector('[data-slot="activity-run-count"]')?.textContent).toBe('5 个步骤');
    expect(container.querySelector('[data-slot="activity-run-caret"]')).toBeTruthy();
    // 收起的段才有展开箭头语义；静止态箭头靠 hover 显隐而不是常驻。
    expect(container.querySelector('[data-slot="activity-run-caret"]')?.getAttribute('class')).toContain('opacity-0');
  });

  it('只有一步时不显示「1 个步骤」', () => {
    const { container } = render(
      <ActivityRunHeader
        open
        onToggle={() => {}}
        live={false}
        onlyThinking
        durationMs={3000}
        stepCount={1}
      />,
    );

    expect(container.querySelector('[data-slot="activity-run-count"]')).toBeNull();
    expect(container.querySelector('[data-slot="activity-run-label"]')?.textContent).toBe('已思考 3s');
  });

  it('尾预览只在「运行中且已收起」时出现', () => {
    const { container, rerender } = render(
      <ActivityRunHeader
        open={false}
        onToggle={() => {}}
        live
        onlyThinking={false}
        durationMs={3000}
        stepCount={2}
        tail="正在读取 CodeMuxThread.tsx"
      />,
    );

    expect(container.querySelector('[data-slot="activity-run-preview"]')?.textContent)
      .toBe('正在读取 CodeMuxThread.tsx');

    // 展开后让位给步骤行。
    rerender(
      <ActivityRunHeader
        open
        onToggle={() => {}}
        live
        onlyThinking={false}
        durationMs={3000}
        stepCount={2}
        tail="正在读取 CodeMuxThread.tsx"
      />,
    );
    expect(container.querySelector('[data-slot="activity-run-preview"]')).toBeNull();

    // 结束后不再有实时预览。
    rerender(
      <ActivityRunHeader
        open={false}
        onToggle={() => {}}
        live={false}
        onlyThinking={false}
        durationMs={3000}
        stepCount={2}
        tail="正在读取 CodeMuxThread.tsx"
      />,
    );
    expect(container.querySelector('[data-slot="activity-run-preview"]')).toBeNull();
  });

  it('运行中显示脉冲点，并在 prefers-reduced-motion 下关闭动画', () => {
    const { container, rerender } = render(
      <ActivityRunHeader open onToggle={() => {}} live onlyThinking stepCount={1} />,
    );

    const pulse = container.querySelector('[data-slot="activity-run-pulse"]');
    expect(pulse).toBeTruthy();
    expect(pulse?.className).toContain('animate-pulse');
    expect(pulse?.className).toContain('motion-reduce:animate-none');
    expect(container.querySelector('[data-slot="activity-run-trigger"]')?.getAttribute('data-live')).toBe('true');

    rerender(<ActivityRunHeader open onToggle={() => {}} live={false} onlyThinking stepCount={1} />);
    expect(container.querySelector('[data-slot="activity-run-pulse"]')).toBeNull();
    expect(container.querySelector('[data-slot="activity-run-trigger"]')?.getAttribute('data-live')).toBe('false');
  });

  it('窄屏没有 hover：箭头常显', () => {
    setViewport(390);
    const { container } = render(
      <ActivityRunHeader open={false} onToggle={() => {}} live={false} onlyThinking stepCount={1} />,
    );

    expect(container.querySelector('[data-slot="activity-run-caret"]')?.getAttribute('class')).toContain('opacity-100');
  });

  it('点击段头回调', () => {
    const onToggle = vi.fn();
    render(<ActivityRunHeader open={false} onToggle={onToggle} live={false} onlyThinking stepCount={1} />);

    fireEvent.click(screen.getByRole('button', { name: '思考' }));

    expect(onToggle).toHaveBeenCalledTimes(1);
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

  it('段内步骤行的缩进常量钉在实际值上（pl-5 = 20px）', () => {
    expect(ACTIVITY_RUN_STEP_INDENT).toBe('pl-5');
  });

  it('段内步骤容器带一条对齐段组头图标中线的竖线', () => {
    const { container } = render(
      <ActivityRunSteps>
        <span>步骤</span>
      </ActivityRunSteps>,
    );
    const rail = container.querySelector('[data-slot="activity-run-steps-rail"]');
    const stepsContainer = rail?.parentElement;

    expect(stepsContainer?.getAttribute('class')).toContain(ACTIVITY_RUN_STEP_INDENT);
    expect(stepsContainer?.getAttribute('class')).toContain('gap-[3px]');
    // 组头触发器 -mx-[3px] px-[5px] + 15px 图标 → 图标中心 9.5px；1px 线放在 left-9 即对齐。
    expect(rail?.getAttribute('class')).toContain('left-[9px]');
    expect(rail?.getAttribute('class')).toContain('w-px');
    expect(rail?.getAttribute('aria-hidden')).toBe('true');
    expect(container.textContent).toContain('步骤');
  });

  it('段在本行之后还有步骤时竖线向下多探，接上下一行', () => {
    const { container } = render(
      <ActivityRunSteps extendsIntoGap>
        <span>步骤</span>
      </ActivityRunSteps>,
    );
    const rail = container.querySelector('[data-slot="activity-run-steps-rail"]');

    // 主线程跨行行距 3px、预览面板 8px（space-y-2）：多探 8px 两个都能接上。
    expect(rail?.getAttribute('class')).toContain('bottom-[-8px]');
    expect(rail?.getAttribute('class')).not.toContain('bottom-1');
  });

  it('实时思考行跟在已提交步骤行后面时竖线向上接上', () => {
    const { container } = render(
      <ActivityRunSteps extendsUpward>
        <span>实时思考</span>
      </ActivityRunSteps>,
    );
    const rail = container.querySelector('[data-slot="activity-run-steps-rail"]');

    expect(rail?.getAttribute('class')).toContain('top-[-8px]');
  });
});
