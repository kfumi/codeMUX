// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SubagentActivityCard, SubagentNodeCard } from '@/components/assistant-ui/subagent-activity';
import type { SubagentActivity, SubagentActivityNode } from '@/lib/subagentActivity';

function node(overrides: Partial<SubagentActivityNode> & { subagentId: string }): SubagentActivityNode {
  return {
    name: 'Explore',
    provider: 'claude',
    statusLabel: '运行中',
    status: 'running',
    detail: '探索前端技术栈',
    stepCount: 3,
    live: true,
    ...overrides,
  };
}

const STARTED_AT = Date.parse('2026-08-29T05:47:20.000Z');
const EIGHT_MINUTES_57 = 8 * 60_000 + 57_000;

function activity(overrides: Partial<SubagentActivity> = {}): SubagentActivity {
  const nodes = overrides.nodes ?? [node({ subagentId: 'toolu_1' })];
  return {
    nodes,
    summary: {
      total: nodes.length,
      finished: nodes.filter((entry) => entry.status === 'completed').length,
      running: nodes.filter((entry) => entry.live).length,
      failed: nodes.filter((entry) => entry.status === 'failed').length,
      ...overrides.summary,
    },
  };
}

function cardElement(element: Element | null): Element {
  expect(element).not.toBeNull();
  return element as Element;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SubagentActivityCard', () => {
  it('收起态画出组头文案、计数与时长', () => {
    const { container } = render(
      <SubagentActivityCard
        activity={activity({
          summary: {
            total: 1,
            finished: 0,
            running: 1,
            failed: 0,
            startedAt: STARTED_AT,
            endedAt: STARTED_AT + EIGHT_MINUTES_57,
          },
        })}
        live={false}
        open={false}
      />,
    );

    const header = cardElement(container.querySelector('[data-slot="subagent-activity-header"]'));
    expect(header.textContent).toContain('Subagent 已完成');
    expect(header.textContent).toContain('1 个 Subagent');
    expect(header.textContent).toContain('已完成 0/1');
    expect(header.textContent).toContain('8m 57s');

    // 收起态的「当前进度」那一行已经删掉：这个槽位在任何开合状态下都不再渲染。
    expect(container.querySelector('[data-slot="subagent-activity-progress"]')).toBeNull();
  });

  it('运行中的组头说「正在工作」，失败过则说「完成，但存在问题」', () => {
    const running = render(
      <SubagentActivityCard activity={activity()} live open={false} />,
    );
    expect(cardElement(running.container.querySelector('[data-slot="subagent-activity-label"]'))!.textContent)
      .toBe('Subagent 正在工作');
    cleanup();

    const failed = render(
      <SubagentActivityCard
        activity={activity({
          nodes: [node({ subagentId: 'toolu_1', status: 'failed', statusLabel: '失败', live: false })],
          summary: { total: 1, finished: 0, running: 0, failed: 1 },
        })}
        live={false}
        open={false}
      />,
    );
    expect(cardElement(failed.container.querySelector('[data-slot="subagent-activity-label"]'))!.textContent)
      .toBe('Subagent 完成，但存在问题');
  });

  it('展开后拓扑画出主 Agent 与每个子智能体节点', () => {
    const { container } = render(
      <SubagentActivityCard
        activity={activity({
          nodes: [
            node({ subagentId: 'toolu_1', name: 'Explore' }),
            node({ subagentId: 'toolu_2', name: 'Plan', status: 'completed', statusLabel: '已完成', live: false }),
          ],
          summary: { total: 2, finished: 1, running: 1, failed: 0 },
        })}
        live
        open
      />,
    );

    expect(cardElement(container.querySelector('[data-slot="subagent-topology-root"]'))!.textContent)
      .toContain('正在协调 2 个委派任务');
    const nodes = container.querySelectorAll('[data-slot="subagent-topology-node"]');
    expect(nodes).toHaveLength(2);
    expect(nodes[0]?.textContent).toContain('Explore');
    expect(nodes[1]?.textContent).toContain('Plan');
    expect(nodes[1]?.textContent).toContain('已完成');
    // 运行中的节点带转圈；结束的节点没有。
    expect(nodes[0]?.querySelector('[data-slot="subagent-topology-node-spinner"]')).not.toBeNull();
    expect(nodes[1]?.querySelector('[data-slot="subagent-topology-node-spinner"]')).toBeNull();
    // 收起态的进度行不再渲染。
    expect(container.querySelector('[data-slot="subagent-activity-progress"]')).toBeNull();
  });

  it('节点显示模型：事件带 model 时用它，没有时退回 provider', () => {
    const { container } = render(
      <SubagentActivityCard
        activity={activity({
          nodes: [
            node({ subagentId: 'toolu_1', model: 'claude-sonnet-4-5' }),
            node({ subagentId: 'toolu_2', name: 'Plan', provider: 'opencode' }),
          ],
        })}
        live
        open
      />,
    );

    const models = Array.from(container.querySelectorAll('[data-slot="subagent-topology-node-model"]'));
    expect(models.map((entry) => entry.textContent)).toEqual(['claude-sonnet-4-5', 'opencode']);
    expect(models.map((entry) => entry.getAttribute('data-model-source'))).toEqual(['event', 'provider']);
  });

  it('点节点卡把子智能体 id 交给打开预览的回调', () => {
    const onOpenSubagent = vi.fn();
    const { container } = render(
      <SubagentActivityCard
        activity={activity({
          nodes: [node({ subagentId: 'toolu_1' }), node({ subagentId: 'toolu_2', name: 'Plan' })],
        })}
        live
        open
        onOpenSubagent={onOpenSubagent}
      />,
    );

    const nodeHeaders = container.querySelectorAll('[data-slot="subagent-topology-node-header"]');
    fireEvent.click(nodeHeaders[1] as HTMLElement);

    expect(onOpenSubagent).toHaveBeenCalledWith('toolu_2');
  });

  it('受控时点组头只上报 onToggle，开合由调用方决定', () => {
    const onToggle = vi.fn();
    const { container } = render(
      <SubagentActivityCard activity={activity()} live={false} open={false} onToggle={onToggle} />,
    );

    const header = cardElement(container.querySelector('[data-slot="subagent-activity-header"]'));
    fireEvent.click(header);

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(header.getAttribute('aria-expanded')).toBe('false');
  });

  it('aria-expanded / aria-controls / inert 跟随开合状态', () => {
    const { container } = render(<SubagentActivityCard activity={activity()} live />);

    const header = cardElement(container.querySelector('[data-slot="subagent-activity-header"]'));
    const body = cardElement(container.querySelector('[data-slot="subagent-activity-body"]'));
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(header.getAttribute('aria-controls')).toBe(body.getAttribute('id'));
    expect(body.hasAttribute('inert')).toBe(false);

    fireEvent.click(header);

    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(cardElement(container.querySelector('[data-slot="subagent-activity-body"]')).hasAttribute('inert'))
      .toBe(true);
  });

  it('未受控时运行中默认展开、结束后自动收起、用户点过之后由用户接管', () => {
    const { container, rerender } = render(<SubagentActivityCard activity={activity()} live />);

    const header = () => cardElement(container.querySelector('[data-slot="subagent-activity-header"]'));
    expect(header().getAttribute('aria-expanded')).toBe('true');

    // 子智能体跑完：自动收起。
    rerender(<SubagentActivityCard activity={activity()} live={false} />);
    expect(header().getAttribute('aria-expanded')).toBe('false');

    // 用户点开一次之后，后续的状态变化不再覆盖他的选择。
    fireEvent.click(header());
    expect(header().getAttribute('aria-expanded')).toBe('true');
    rerender(<SubagentActivityCard activity={activity()} live />);
    rerender(<SubagentActivityCard activity={activity()} live={false} />);
    expect(header().getAttribute('aria-expanded')).toBe('true');
  });

  it('展开区先画拓扑再平铺该段其余步骤', () => {
    const { container } = render(
      <SubagentActivityCard activity={activity()} live open>
        <span data-testid="step-row">思考</span>
      </SubagentActivityCard>,
    );

    const body = cardElement(container.querySelector('[data-slot="subagent-activity-body"]'));
    const inner = cardElement(body.querySelector('.subagent-activity-collapse-inner'));
    // 顺序：拓扑（主 Agent + 节点列）在前，该段其余步骤在后。
    expect(Array.from(inner.children).map((element) => element.getAttribute('data-slot')))
      .toEqual(['subagent-topology', 'subagent-activity-steps']);
    const steps = cardElement(container.querySelector('[data-slot="subagent-activity-steps"]'));
    expect(steps.querySelector('[data-testid="step-row"]')?.textContent).toBe('思考');
  });

  it('运行中节点的时长按「现在 - 首条事件」推进，已结束的用投影给的固定时长', () => {
    const { container } = render(
      <SubagentNodeCard
        node={node({
          subagentId: 'toolu_live',
          startedAt: STARTED_AT,
          durationMs: 1000,
        })}
        now={STARTED_AT + 65_000}
      />,
    );
    expect(cardElement(container.querySelector(
      '[data-slot="subagent-topology-node-status"]',
    )).textContent).toBe('运行中 · 1m 5s');

    cleanup();
    const settled = render(
      <SubagentNodeCard
        node={node({
          subagentId: 'toolu_done',
          status: 'completed',
          statusLabel: '已完成',
          live: false,
          startedAt: STARTED_AT,
          durationMs: 9000,
        })}
        now={STARTED_AT + 65_000}
      />,
    );
    expect(cardElement(settled.container.querySelector(
      '[data-slot="subagent-topology-node-status"]',
    )).textContent).toBe('已完成 · 9s');
  });
});
