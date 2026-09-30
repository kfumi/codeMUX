import { describe, expect, it } from 'vitest';

import { subagentLiveTail, SUBAGENT_LIVE_TAIL_MAX_CHARS } from '@/lib/subagentStreamingTail';
import { parseAgentEvent, type AgentMessage } from '@/stores/agentStore';

function parsed(raw: Record<string, unknown>): AgentMessage {
  return parseAgentEvent(raw);
}

function textDelta(index: number, text: string): AgentMessage {
  return parsed({ type: 'text_delta', session_id: 's1', index, text });
}

function reasoningDelta(index: number, text: string): AgentMessage {
  return parsed({ type: 'reasoning_delta', session_id: 's1', index, text });
}

function contentStarted(index: number, kind: 'text' | 'reasoning'): AgentMessage {
  return parsed({ type: 'content_started', session_id: 's1', index, content_kind: kind });
}

function contentFinished(index: number): AgentMessage {
  return parsed({ type: 'content_finished', session_id: 's1', index });
}

function assistantText(text: string): AgentMessage {
  return parsed({
    type: 'assistant_message',
    session_id: 's1',
    content: [{ type: 'text', text }],
  });
}

function toolStarted(id: string): AgentMessage {
  return parsed({ type: 'tool_started', session_id: 's1', tool_use_id: id, name: 'Grep', input: {} });
}

describe('subagentLiveTail', () => {
  it('空时间线没有尾部', () => {
    expect(subagentLiveTail([])).toEqual({ thinking: '', text: '', streaming: false });
  });

  it('尾部连续 delta 按顺序拼成正文', () => {
    const tail = subagentLiveTail([
      contentStarted(0, 'text'),
      textDelta(0, '结'),
      textDelta(0, '论'),
      textDelta(0, '：ok'),
    ]);
    expect(tail).toEqual({ thinking: '', text: '结论：ok', streaming: true });
  });

  it('思考与正文分属两个缓冲', () => {
    const tail = subagentLiveTail([
      contentStarted(0, 'reasoning'),
      reasoningDelta(0, '先看入口'),
      contentStarted(1, 'text'),
      textDelta(1, '找到了'),
    ]);
    expect(tail.thinking).toBe('先看入口');
    expect(tail.text).toBe('找到了');
    expect(tail.streaming).toBe(true);
  });

  it('撞到已提交消息即停：更早的 delta 不算未提交', () => {
    const tail = subagentLiveTail([
      textDelta(0, '旧的'),
      assistantText('旧的'),
      textDelta(0, '新的'),
      textDelta(0, '正文'),
    ]);
    expect(tail.text).toBe('新的正文');
  });

  /**
   * 核心不变量：**尾部为空 ⟺ 文本已被提交**。两者同时成立就会把同一段文字画两遍
   * （一次在已提交消息里、一次在实时尾部里）。
   */
  it('提交后尾部清空，同一段文字不会被显示两次', () => {
    const streaming: AgentMessage[] = [contentStarted(0, 'text'), textDelta(0, '完整正文')];
    expect(subagentLiveTail(streaming).text).toBe('完整正文');

    const committed = [...streaming, assistantText('完整正文')];
    expect(subagentLiveTail(committed).text).toBe('');
    expect(subagentLiveTail(committed).streaming).toBe(false);
  });

  it('OpenCode 的临时信封之后的 delta 构成新的一段尾部', () => {
    // 临时 assistant_message 之后又来 delta：那是下一个内容块，不该并进前一段。
    const tail = subagentLiveTail([
      textDelta(0, '第一段'),
      assistantText('第一段'),
      contentStarted(0, 'text'),
      textDelta(0, '第二段'),
    ]);
    expect(tail.text).toBe('第二段');
  });

  it('工具帧是提交点：其后的 delta 才是尾部', () => {
    const tail = subagentLiveTail([
      textDelta(0, '调工具前'),
      assistantText('调工具前'),
      toolStarted('c1'),
      textDelta(1, '调工具后'),
    ]);
    expect(tail.text).toBe('调工具后');
  });

  it('只有块的开始/结束、没有正文时不驱动绘制', () => {
    expect(subagentLiveTail([contentStarted(0, 'text'), contentFinished(0)]))
      .toEqual({ thinking: '', text: '', streaming: false });
  });

  it('尾部超长时只保留最近的一段', () => {
    const chunk = 'x'.repeat(1_000);
    const events: AgentMessage[] = [];
    for (let index = 0; index < 40; index += 1) {
      events.push(textDelta(0, chunk));
    }
    const tail = subagentLiveTail(events);
    expect(tail.text.length).toBe(SUBAGENT_LIVE_TAIL_MAX_CHARS);
    // 保留的是**尾部**：最后一段必须在，最后一段之前那段必须已被切掉。
    expect(tail.text.endsWith(chunk)).toBe(true);
  });

  it('未知形状的消息不算流式增量（保守：宁可尾巴短，不可重复显示）', () => {
    const tail = subagentLiveTail([
      textDelta(0, '正文'),
      parsed({ type: 'some_future_provider_event', session_id: 's1' }),
    ]);
    expect(tail.text).toBe('');
    expect(tail.streaming).toBe(false);
  });
});
