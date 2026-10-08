import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/stores/agentStore';
import { normalizeTurnProcessEventOrder } from '@/lib/agentTurnOrdering';

function toolAssistant(id: string, name: string): AgentMessage {
  return {
    kind: 'assistant',
    data: {
      message: {
        content: [{ type: 'tool_use', id, name, input: {} }],
      },
    },
  } as unknown as AgentMessage;
}

function textAssistant(text: string): AgentMessage {
  return {
    kind: 'assistant',
    data: {
      message: {
        content: [{ type: 'text', text }],
      },
    },
  } as unknown as AgentMessage;
}

describe('normalizeTurnProcessEventOrder', () => {
  it('moves trailing tool steps before the final text assistant', () => {
    const events = [
      { kind: 'user', data: { content: 'request' } },
      textAssistant('final answer'),
      toolAssistant('tool-1', 'bash'),
      toolAssistant('tool-2', 'read'),
      { kind: 'result', data: { type: 'result', duration_ms: 100 } },
    ] as unknown as AgentMessage[];

    expect(normalizeTurnProcessEventOrder(events).map((event) => event.kind)).toEqual([
      'user',
      'assistant',
      'assistant',
      'assistant',
      'result',
    ]);
  });

  it('leaves already-correct turns unchanged', () => {
    const events = [
      { kind: 'user', data: { content: 'request' } },
      toolAssistant('tool-1', 'bash'),
      textAssistant('final answer'),
      { kind: 'result', data: { type: 'result', duration_ms: 100 } },
    ] as unknown as AgentMessage[];

    expect(normalizeTurnProcessEventOrder(events)).toEqual(events);
  });

  it('keeps non-process events (session_summary) between the final assistant and result', () => {
    // 生产实测(15:17 轮):sidecar 帧序 assistant → session_summary → turn_finished。
    // result 入列触发重排时,summary 夹在区间 (finalAssistant, result) 内且不可重排;
    // 原实现重组时直接把它丢掉 → 产物卡片永久消失(实时),刷新才能从 DB 恢复。
    const events = [
      { kind: 'user', data: { content: 'request' } },
      toolAssistant('tool-1', 'edit'),
      { kind: 'tool_result', data: { tool_use_id: 'tool-1' } },
      textAssistant('final answer'),
      { kind: 'session_summary', data: { diffs: [] } },
      { kind: 'result', data: { type: 'result', duration_ms: 100 } },
    ] as unknown as AgentMessage[];

    const normalized = normalizeTurnProcessEventOrder(events);
    expect(normalized.map((event) => event.kind)).toEqual([
      'user',
      'assistant',
      'tool_result',
      'assistant',
      'session_summary',
      'result',
    ]);
    // 工具步骤仍需挪到最终文本 assistant 之前(本用例原本就在前面,顺序保持)。
    expect(normalized).toHaveLength(events.length);
  });

  it('moves trailing tool steps while preserving a non-process event after the final assistant', () => {
    // 工具步骤迟到(Pi/OpenCode 晚到工具) + summary 在 result 前:工具前移、summary 保留。
    const events = [
      { kind: 'user', data: { content: 'request' } },
      textAssistant('final answer'),
      toolAssistant('tool-late', 'bash'),
      { kind: 'session_summary', data: { diffs: [] } },
      { kind: 'result', data: { type: 'result', duration_ms: 100 } },
    ] as unknown as AgentMessage[];

    const normalized = normalizeTurnProcessEventOrder(events);
    expect(normalized.map((event) => event.kind)).toEqual([
      'user',
      'assistant',
      'assistant',
      'session_summary',
      'result',
    ]);
    expect(normalized).toHaveLength(events.length);
  });
});
