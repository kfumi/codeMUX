import { describe, expect, it } from 'vitest';

import {
  buildRunSubagentActivity,
  buildSubagentActivity,
  findSubagentIdByToolCallId,
  runSubagentActivityEqual,
  subagentActivityEqual,
  subagentActivityLabel,
  subagentIdsForToolCallIds,
  subagentModelFromEvents,
} from '@/lib/subagentActivity';
import type { AgentMessage } from '@/stores/agentStore';
import type { SubagentDescriptor } from '@/stores/subagentStore';

function descriptor(
  overrides: Partial<SubagentDescriptor> & { subagentId: string },
): SubagentDescriptor {
  return {
    provider: 'claude',
    title: 'Explore',
    description: '探索前端技术栈',
    status: 'running',
    toolCallId: overrides.subagentId,
    subtitle: null,
    updatedAt: 0,
    ...overrides,
  };
}

function assistantToolUse(id: string, name = 'Task'): AgentMessage {
  return {
    kind: 'assistant',
    data: { uuid: id, message: { content: [{ type: 'tool_use', id, name, input: {} }] } },
  } as unknown as AgentMessage;
}

/** 子智能体时间线：一段思考 + 一次工具调用（首末时间戳相差 2s）。 */
const timeline = [
  {
    type: 'assistant_message',
    content: [{ type: 'thinking', thinking: '先看入口' }],
    event_id: 'e1',
    timestamp: '2026-08-29T05:47:20.000Z',
  },
  {
    type: 'tool_started',
    tool_use_id: 'c1',
    name: 'Grep',
    input: {},
    event_id: 'e2',
    timestamp: '2026-08-29T05:47:21.000Z',
  },
  {
    type: 'tool_finished',
    tool_use_id: 'c1',
    event_id: 'e3',
    timestamp: '2026-08-29T05:47:22.000Z',
  },
];

const T0 = Date.parse('2026-08-29T05:47:20.000Z');
const T2 = Date.parse('2026-08-29T05:47:22.000Z');

/**
 * 纯流式增量：sidecar 在子智能体吐字时源源不断送来的这一组事件。
 *
 * 它们按 `activityRuns.rendersNoRow` 的口径「不画行」，又按 `classifyProcessEvent` 的口径
 * 「不计步」，所以无论追加多少，步骤数与段结构都不该变——这正是步骤数缓存可以按「前缀同
 * 引用 + 只追加流式增量」复用旧计数的前提。
 */
const deltas: Record<string, unknown>[] = [
  { type: 'content_started', index: 0, content_kind: 'text', event_id: 'd1', timestamp: '2026-08-29T05:47:23.000Z' },
  { type: 'text_delta', index: 0, text: '结', event_id: 'd2', timestamp: '2026-08-29T05:47:23.100Z' },
  { type: 'text_delta', index: 0, text: '论：', event_id: 'd3', timestamp: '2026-08-29T05:47:23.200Z' },
  { type: 'reasoning_delta', index: 1, text: '再确认一遍', event_id: 'd4', timestamp: '2026-08-29T05:47:23.300Z' },
  { type: 'content_finished', index: 0, event_id: 'd5', timestamp: '2026-08-29T05:47:23.400Z' },
];

describe('buildSubagentActivity', () => {
  it('汇总计数：总数 / 已完成 / 运行中 / 失败，空列表给零值', () => {
    const activity = buildSubagentActivity({
      order: ['a', 'b', 'c', 'd'],
      descriptors: {
        a: descriptor({ subagentId: 'a', status: 'completed' }),
        b: descriptor({ subagentId: 'b', status: 'running' }),
        c: descriptor({ subagentId: 'c', status: 'failed' }),
        d: descriptor({ subagentId: 'd', status: 'canceled' }),
      },
      events: {},
      now: T2,
    });

    // 「已完成」= 不再运行（含失败/取消，与参考实现同口径），失败数另由 failed 表达。
    expect(activity.summary).toMatchObject({ total: 4, finished: 3, running: 1, failed: 2 });
    expect(activity.nodes.map((node) => node.status)).toEqual([
      'completed',
      'running',
      'failed',
      'canceled',
    ]);

    const empty = buildSubagentActivity({ order: [], descriptors: {}, events: {} });
    expect(empty.nodes).toEqual([]);
    expect(empty.summary).toMatchObject({ total: 0, finished: 0, running: 0, failed: 0 });
    expect(empty.summary.startedAt).toBeUndefined();
    expect(empty.summary.endedAt).toBeUndefined();
  });

  it('时长取首末事件时间戳；运行中不落时长，交给展示层按秒自走', () => {
    const completed = buildSubagentActivity({
      order: ['a'],
      descriptors: { a: descriptor({ subagentId: 'a', status: 'completed' }) },
      events: { a: timeline },
    });
    expect(completed.nodes[0]?.durationMs).toBe(T2 - T0);
    expect(completed.summary.startedAt).toBe(T0);
    expect(completed.summary.endedAt).toBe(T2);

    // 运行中的子智能体没有结束时刻：尾部源源不断的 text_delta 每来一个都会改掉
    // 「最后一条事件时间戳」，落进投影就等于每吐一个字换掉整张卡片的活动对象，
    // 进而让主线程每一行已挂载消息重新协调。
    const running = buildSubagentActivity({
      order: ['a'],
      descriptors: { a: descriptor({ subagentId: 'a', status: 'running' }) },
      events: { a: timeline },
    });
    expect(running.nodes[0]?.durationMs).toBeUndefined();
    expect(running.nodes[0]?.startedAt).toBe(T0);
    expect(running.summary.endedAt).toBeUndefined();
  });

  it('纯流式 delta 追加不改变步骤数，投影始终渲染等价', () => {
    const project = (events: Record<string, unknown>[]) => buildSubagentActivity({
      order: ['a'],
      descriptors: { a: descriptor({ subagentId: 'a', status: 'running' }) },
      events: { a: events },
    });
    const events: Record<string, unknown>[] = [...timeline];
    let previous = project(events);
    const stepCount = previous.nodes[0]?.stepCount;
    expect(stepCount).toBeGreaterThan(0);

    for (const delta of deltas) {
      events.push(delta);
      const next = project(events);
      expect(next.nodes[0]?.stepCount).toBe(stepCount);
      expect(subagentActivityEqual(previous, next)).toBe(true);
      previous = next;
    }
  });

  it('终态后追加 delta 会改掉结束时刻，投影因此判为「变了」', () => {
    const events: Record<string, unknown>[] = [...timeline];
    const before = buildSubagentActivity({
      order: ['a'],
      descriptors: { a: descriptor({ subagentId: 'a', status: 'completed' }) },
      events: { a: events },
    });
    events.push(deltas[0]);
    const after = buildSubagentActivity({
      order: ['a'],
      descriptors: { a: descriptor({ subagentId: 'a', status: 'completed' }) },
      events: { a: events },
    });
    expect(after.summary.endedAt).not.toBe(before.summary.endedAt);
    expect(subagentActivityEqual(before, after)).toBe(false);
  });

  it('追加真正的步骤事件时步骤数必须跟着涨（缓存不得陈旧）', () => {
    const events: Record<string, unknown>[] = [...timeline];
    const project = () => buildSubagentActivity({
      order: ['a'],
      descriptors: { a: descriptor({ subagentId: 'a', status: 'running' }) },
      events: { a: events },
    });
    const before = project().nodes[0]?.stepCount;
    expect(before).toBeGreaterThan(0);

    // 纯流式增量先来一轮：步骤数不动。
    for (const delta of deltas) events.push(delta);
    expect(project().nodes[0]?.stepCount).toBe(before);

    // 接着来一次真正的工具调用：步骤数必须 +1。
    events.push({
      type: 'tool_started',
      tool_use_id: 'c2',
      name: 'Read',
      input: {},
      event_id: 'e4',
      timestamp: '2026-08-29T05:47:24.000Z',
    });
    expect(project().nodes[0]?.stepCount).toBe((before ?? 0) + 1);
  });

  it('没有事件时不给时长', () => {
    const activity = buildSubagentActivity({
      order: ['a'],
      descriptors: { a: descriptor({ subagentId: 'a' }) },
      events: { a: [] },
      now: T2,
    });
    expect(activity.nodes[0]?.durationMs).toBeUndefined();
    expect(activity.nodes[0]?.stepCount).toBe(0);
  });

  it('步骤数是子智能体时间线里处理段的步骤之和', () => {
    const activity = buildSubagentActivity({
      order: ['a'],
      descriptors: { a: descriptor({ subagentId: 'a', status: 'completed' }) },
      events: { a: timeline },
    });
    // 一段「思考 + 工具」= 2 步（与子智能体预览面板同一套投影）。
    expect(activity.nodes[0]?.stepCount).toBe(2);
  });

  it('同一 tool_use_id 的重复帧是输入刷新，只算一步', () => {
    const activity = buildSubagentActivity({
      order: ['a'],
      descriptors: { a: descriptor({ subagentId: 'a', status: 'completed' }) },
      events: {
        a: [
          { type: 'tool_started', tool_use_id: 'c1', name: 'read', input: {}, event_id: 'e1', timestamp: '2026-08-29T05:47:21.000Z' },
          { type: 'tool_started', tool_use_id: 'c1', name: 'read', input: { filePath: 'a.ts' }, event_id: 'e2', timestamp: '2026-08-29T05:47:22.000Z' },
          { type: 'tool_finished', tool_use_id: 'c1', event_id: 'e3', timestamp: '2026-08-29T05:47:23.000Z' },
        ],
      },
    });

    // OpenCode 先发 pending（input 空）、再发 running（补全 input）：渲染层视为同一次调用的
    // 参数刷新，所以卡片上的步骤数只算 1（不去重就会算成 2）。
    expect(activity.nodes[0]?.stepCount).toBe(1);
  });

  it('状态文案：运行中 / 已完成 / 失败 / 已取消', () => {
    const activity = buildSubagentActivity({
      order: ['a', 'b', 'c', 'd'],
      descriptors: {
        a: descriptor({ subagentId: 'a', status: 'running' }),
        b: descriptor({ subagentId: 'b', status: 'completed' }),
        c: descriptor({ subagentId: 'c', status: 'failed' }),
        d: descriptor({ subagentId: 'd', status: 'canceled' }),
      },
      events: {},
      now: T0,
    });
    expect(activity.nodes.map((node) => node.statusLabel)).toEqual([
      '运行中',
      '已完成',
      '失败',
      '已取消',
    ]);
  });

  it('名称回退到「未命名子智能体」，描述回退到 subtitle', () => {
    const named = buildSubagentActivity({
      order: ['a'],
      descriptors: {
        a: descriptor({ subagentId: 'a', title: 'Explore', subtitle: 'Reading src/main.tsx' }),
      },
      events: {},
      now: T0,
    });
    expect(named.nodes[0]?.name).toBe('Explore');

    const unnamed = buildSubagentActivity({
      order: ['a'],
      descriptors: {
        a: descriptor({ subagentId: 'a', title: '  ', description: null, subtitle: '读取入口文件' }),
      },
      events: {},
      now: T0,
    });
    expect(unnamed.nodes[0]?.name).toBe('未命名子智能体');
    // 节点描述：description → subtitle。
    expect(unnamed.nodes[0]?.detail).toBe('读取入口文件');
  });

  it('事件里没有 model 字段时不猜模型，节点不给 model（展示层退回 provider）', () => {
    const activity = buildSubagentActivity({
      order: ['a'],
      descriptors: { a: descriptor({ subagentId: 'a', provider: 'opencode' }) },
      events: { a: timeline },
      now: T0,
    });
    expect(activity.nodes[0]?.model).toBeUndefined();
    expect(activity.nodes[0]?.provider).toBe('opencode');
  });

  it('model 依次从 event.model / event.data.model / event.message.model 读取第一个非空值', () => {
    expect(subagentModelFromEvents([{ model: 'claude-sonnet-4-5' }])).toBe('claude-sonnet-4-5');
    expect(subagentModelFromEvents([{ data: { model: 'claude-opus-4-1' } }])).toBe('claude-opus-4-1');
    expect(subagentModelFromEvents([{ message: { model: 'glm-4.6' } }])).toBe('glm-4.6');
    // Claude 侧链的 tool-only 子智能体没有 assistant_message，模型挂在工具事件上。
    expect(subagentModelFromEvents([
      { type: 'tool_started', tool_use_id: 't1', name: 'Read', model: 'glm-5.3-flash' },
    ])).toBe('glm-5.3-flash');
    expect(subagentModelFromEvents([
      { model: '   ' },
      { data: { model: '' } },
      { message: { model: 'gpt-5' } },
    ])).toBe('gpt-5');
    expect(subagentModelFromEvents([{ model: 42 }, { data: { model: null } }])).toBeUndefined();
  });
});

describe('subagentActivityLabel', () => {
  it('运行中 / 已完成 / 有问题', () => {
    expect(subagentActivityLabel({ failed: 0 }, true)).toBe('Subagent 正在工作');
    expect(subagentActivityLabel({ failed: 0 }, false)).toBe('Subagent 已完成');
    expect(subagentActivityLabel({ failed: 1 }, false)).toBe('Subagent 完成，但存在问题');
    // 仍在运行时「有问题」不抢戏：只要还有人没结束，说的就是「正在工作」。
    expect(subagentActivityLabel({ failed: 1 }, true)).toBe('Subagent 正在工作');
  });
});

describe('委派归属', () => {
  const descriptors: Record<string, SubagentDescriptor> = {
    'toolu_a': descriptor({ subagentId: 'toolu_a', toolCallId: 'toolu_a' }),
    'sub_2': descriptor({ subagentId: 'sub_2', toolCallId: 'toolu_b' }),
  };

  it('按父工具调用 id 找描述符（key 与 toolCallId 都算）', () => {
    expect(findSubagentIdByToolCallId(descriptors, 'toolu_a')).toBe('toolu_a');
    expect(findSubagentIdByToolCallId(descriptors, 'toolu_b')).toBe('sub_2');
    expect(findSubagentIdByToolCallId(descriptors, 'toolu_missing')).toBeUndefined();
    expect(findSubagentIdByToolCallId(descriptors, null)).toBeUndefined();
  });

  it('按描述符到达顺序返回段内的子智能体', () => {
    expect(subagentIdsForToolCallIds(
      new Set(['toolu_b', 'toolu_a']),
      ['toolu_a', 'sub_2'],
      descriptors,
    )).toEqual(['toolu_a', 'sub_2']);
    expect(subagentIdsForToolCallIds(new Set(), ['toolu_a'], descriptors)).toEqual([]);
  });

  it('只有含委派的处理段才有条目', () => {
    const runs = [
      { runKey: 'turn-1-0', eventIndices: [0, 1] },
      { runKey: 'turn-1-2', eventIndices: [2] },
    ];
    const byRun = buildRunSubagentActivity({
      runs,
      agentEvents: [assistantToolUse('toolu_a'), assistantToolUse('toolu_x', 'Grep'), assistantToolUse('toolu_b')],
      order: ['toolu_a', 'sub_2'],
      descriptors,
      subagentEvents: { toolu_a: timeline, sub_2: [] },
      now: T2,
    });

    expect([...byRun.keys()]).toEqual(['turn-1-0', 'turn-1-2']);
    expect(byRun.get('turn-1-0')?.nodes.map((node) => node.subagentId)).toEqual(['toolu_a']);
    expect(byRun.get('turn-1-2')?.nodes.map((node) => node.subagentId)).toEqual(['sub_2']);
    // 没有描述符命中的段（普通工具）不产生条目。
    expect(buildRunSubagentActivity({
      runs: [{ runKey: 'turn-1-0', eventIndices: [0] }],
      agentEvents: [assistantToolUse('toolu_x', 'Grep')],
      order: ['toolu_a'],
      descriptors,
      subagentEvents: {},
    }).size).toBe(0);
  });
});
