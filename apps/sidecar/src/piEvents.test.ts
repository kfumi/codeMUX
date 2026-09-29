import { describe, expect, it } from 'vitest';

import { createPiEventContext, toCodeMuxEvents } from './piEvents.js';

function createContext() {
  let id = 0;
  return createPiEventContext({
    sessionId: 'app-session',
    eventIdFactory: () => `evt-${++id}`,
  });
}

const BASE = { agent_id: 'pi', session_id: 'app-session' };

describe('piEvents text/thinking streaming', () => {
  it('opens a text block on the first text_delta and streams deltas', () => {
    const ctx = createContext();
    const first = toCodeMuxEvents({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } }, ctx);
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({ ...BASE, type: 'content_started', index: 0, content_kind: 'text', event_id: 'evt-1' });
    expect(first[1]).toMatchObject({ ...BASE, type: 'text_delta', index: 0, text: 'Hello', event_id: 'evt-2' });

    const second = toCodeMuxEvents({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' world' } }, ctx);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ type: 'text_delta', index: 0, text: ' world' });
  });

  it('opens a separate reasoning block and finishes blocks on end events', () => {
    const ctx = createContext();
    const events = [
      ...toCodeMuxEvents({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } }, ctx),
      ...toCodeMuxEvents({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end' } }, ctx),
      ...toCodeMuxEvents({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'answer' } }, ctx),
      ...toCodeMuxEvents({ type: 'message_update', assistantMessageEvent: { type: 'done' } }, ctx),
    ];
    expect(events.map((event) => event.type)).toEqual([
      'content_started',
      'reasoning_delta',
      'content_finished',
      'content_started',
      'text_delta',
      'content_finished',
    ]);
    expect(events[1]?.type === 'reasoning_delta' && (events[1] as { index: number }).index === 0).toBe(true);
    expect(events[4]).toMatchObject({ index: 1, text: 'answer' });
  });

  it('emits assistant_message on message_end with mapped content blocks', () => {
    const ctx = createContext();
    const events = toCodeMuxEvents(
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'done' },
            { type: 'thinking', thinking: 'why' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
          ],
          stopReason: 'stop',
        },
      },
      ctx,
    );
    expect(events.map((event) => event.type)).toEqual(['assistant_message', 'tool_started']);
    expect(events[0]).toMatchObject({ ...BASE, type: 'assistant_message' });
    const content = (events[0] as { content: Array<Record<string, unknown>> }).content;
    expect(content).toEqual([
      { type: 'text', text: 'done' },
      { type: 'thinking', thinking: 'why' },
    ]);
    expect(events[1]).toMatchObject({
      ...BASE,
      type: 'tool_started',
      tool_use_id: 'call-1',
      name: 'read',
      input: { path: 'a.ts' },
    });
  });

  it('emits only tool_started when a message_end carries no thinking or text', () => {
    const ctx = createContext();
    const events = toCodeMuxEvents(
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } },
          ],
          stopReason: 'toolUse',
        },
      },
      ctx,
    );
    expect(events.map((event) => event.type)).toEqual(['tool_started']);
  });
});

describe('piEvents COMPAT cumulative message_update', () => {
  it('projects the missing suffix when pi repeats the cumulative message', () => {
    const ctx = createContext();
    const first = toCodeMuxEvents(
      { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'AB' }] } },
      ctx,
    );
    expect(first).toEqual([
      expect.objectContaining({ type: 'content_started', content_kind: 'text' }),
      expect.objectContaining({ type: 'text_delta', text: 'AB' }),
    ]);

    const second = toCodeMuxEvents(
      { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'ABCD' }] } },
      ctx,
    );
    expect(second).toEqual([expect.objectContaining({ type: 'text_delta', text: 'CD' })]);

    const third = toCodeMuxEvents(
      { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'ABCD' }] } },
      ctx,
    );
    expect(third).toEqual([]);
  });
});

describe('piEvents tool execution', () => {
  it('maps tool start/end by toolCallId and surfaces errors', () => {
    const ctx = createContext();
    const start = toCodeMuxEvents(
      { type: 'tool_execution_start', toolCallId: 'call-9', toolName: 'bash', args: { command: 'ls' } },
      ctx,
    );
    expect(start).toHaveLength(1);
    expect(start[0]).toMatchObject({ ...BASE, type: 'tool_started', tool_use_id: 'call-9', name: 'bash', input: { command: 'ls' } });

    const end = toCodeMuxEvents(
      { type: 'tool_execution_end', toolCallId: 'call-9', toolName: 'bash', result: 'file.ts', isError: false },
      ctx,
    );
    expect(end).toHaveLength(1);
    expect(end[0]).toMatchObject({ type: 'tool_finished', tool_use_id: 'call-9', content: 'file.ts', is_error: false });

    const failed = toCodeMuxEvents(
      { type: 'tool_execution_end', toolCallId: 'call-9', toolName: 'bash', result: { message: 'boom' }, isError: true },
      ctx,
    );
    expect(failed[0]).toMatchObject({ type: 'tool_finished', is_error: true, content: '{"message":"boom"}' });
  });

  it('normalizes ask_user_question answers into the question card shape', () => {
    const ctx = createContext();
    const finished = toCodeMuxEvents(
      {
        type: 'tool_execution_end',
        toolCallId: 'call-ask',
        toolName: 'ask_user_question',
        result: {
          content: [{ type: 'text', text: 'Q1: a\nQ2: b' }],
          details: { answers: [{ question: 'Q1', answer: 'a' }, { question: 'Q2', answer: 'b' }] },
        },
        isError: false,
      },
      ctx,
    );
    // 提问卡按位置序读 answers；直接透传 result 会让它读不到（回显"未作答"）。
    expect(finished[0]).toMatchObject({ type: 'tool_finished', content: '{"answers":[["a"],["b"]]}' });

    // 部分作答（中途取消）：未作答项落成空串而非 null，须与历史投影
    // `crates/daemon/src/agent/pi_history.rs` 的 `pi_tool_result_content` 逐字一致。
    const mixed = toCodeMuxEvents(
      {
        type: 'tool_execution_end',
        toolCallId: 'call-ask-mixed',
        toolName: 'ask_user_question',
        result: {
          content: [{ type: 'text', text: 'Q1: (no answer)\nQ2: b' }],
          details: {
            answers: [
              { question: 'Q1', answer: null },
              { question: 'Q2', answer: 'b' },
            ],
          },
        },
        isError: false,
      },
      ctx,
    );
    expect(mixed[0]).toMatchObject({ content: '{"answers":[[""],["b"]]}' });
  });

  it('maps an all-null ask_user_question answer list to the cancelled sentinel', () => {
    const ctx = createContext();
    const cancelled = toCodeMuxEvents(
      {
        type: 'tool_execution_end',
        toolCallId: 'call-ask',
        toolName: 'ask_user_question',
        result: {
          content: [{ type: 'text', 'text': 'Q1: (no answer)' }],
          details: { answers: [{ question: 'Q1', answer: null }] },
        },
        isError: false,
      },
      ctx,
    );
    expect(cancelled[0]).toMatchObject({ type: 'tool_finished', content: '__cancelled__' });

    // 空串是合法的自由文本答复，不能当取消。
    const blank = toCodeMuxEvents(
      {
        type: 'tool_execution_end',
        toolCallId: 'call-ask',
        toolName: 'ask_user_question',
        result: { content: [], details: { answers: [{ question: 'Q1', answer: '' }] } },
        isError: false,
      },
      ctx,
    );
    expect(blank[0]).toMatchObject({ content: '{"answers":[[""]]}' });
  });

  it('flattens the result when the ask tool has no structured answers', () => {
    const ctx = createContext();
    const withoutDetails = toCodeMuxEvents(
      {
        type: 'tool_execution_end',
        toolCallId: 'call-ask',
        toolName: 'ask_user_question',
        result: { content: [{ type: 'text', text: 'Q1: a' }], details: {} },
        isError: false,
      },
      ctx,
    );
    // 提问投影拿不到结构化答案时回落到拍平文本，而不是 JSON 转储。
    // 与 `crates/daemon/src/agent/pi_history.rs` 的 `without_details` 用例逐字一致。
    expect(withoutDetails[0]).toMatchObject({
      type: 'tool_finished',
      content: 'Q1: a',
    });

    // 空 answers 数组：本侧返回空 answers，Rust 侧返回拍平文本——双方注释里记录的
    // 刻意差异，真实 pi 不产出空数组。
    const emptyAnswers = toCodeMuxEvents(
      {
        type: 'tool_execution_end',
        toolCallId: 'call-ask-empty',
        toolName: 'ask_user_question',
        result: { content: [], details: { answers: [] } },
        isError: false,
      },
      ctx,
    );
    expect(emptyAnswers[0]).toMatchObject({ content: '{"answers":[]}' });

    // 非提问工具即便碰巧带 details.answers 也不套用提问投影（避免误伤别的工具输出）。
    // 缺 `content` 时本侧保留整个 result 的 JSON（Rust 侧会拍成空串，见双方注释
    // 记录的刻意差异），避免把非标准返回值的工具结果整条吞掉。
    const otherTool = toCodeMuxEvents(
      {
        type: 'tool_execution_end',
        toolCallId: 'call-x',
        toolName: 'bash',
        result: { details: { answers: [{ question: 'Q', answer: 'a' }] } },
        isError: false,
      },
      ctx,
    );
    expect(otherTool[0]).toMatchObject({
      type: 'tool_finished',
      content: '{"details":{"answers":[{"question":"Q","answer":"a"}]}}',
    });
  });

  it('flattens content text blocks for non-ask tools', () => {
    const ctx = createContext();

    // 命令输出按 "\n\n" 拼成纯文本，而不是 `{"content":[{"type":"text",...}]}` 转储。
    // 与 `crates/daemon/src/agent/pi_history.rs` 的
    // `flattens_error_tool_result_content` 逐字一致。
    const failed = toCodeMuxEvents(
      {
        type: 'tool_execution_end',
        toolCallId: 'call-err',
        toolName: 'bash',
        result: {
          content: [
            { type: 'text', text: 'tree: command not found' },
            { type: 'text', text: 'Command exited with code 127' },
          ],
          details: {},
        },
        isError: true,
      },
      ctx,
    );
    expect(failed[0]).toMatchObject({
      type: 'tool_finished',
      content: 'tree: command not found\n\nCommand exited with code 127',
      is_error: true,
    });

    // 字符串 content 原样透传。
    const stringContent = toCodeMuxEvents(
      {
        type: 'tool_execution_end',
        toolCallId: 'call-str',
        toolName: 'bash',
        result: { content: 'hello' },
        isError: false,
      },
      ctx,
    );
    expect(stringContent[0]).toMatchObject({ content: 'hello' });

    // 非文本块被忽略。
    const noText = toCodeMuxEvents(
      {
        type: 'tool_execution_end',
        toolCallId: 'call-img',
        toolName: 'bash',
        result: { content: [{ type: 'image', data: 'xx' }] },
        isError: false,
      },
      ctx,
    );
    expect(noText[0]).toMatchObject({ content: '' });

    // 裸字符串 result 保持原样。
    const plainString = toCodeMuxEvents(
      {
        type: 'tool_execution_end',
        toolCallId: 'call-plain',
        toolName: 'read',
        result: 'file contents',
        isError: false,
      },
      ctx,
    );
    expect(plainString[0]).toMatchObject({ content: 'file contents' });

    // 拍不出文本的 result（数字等非字符串非对象）仍走 JSON.stringify 兜底。
    const numeric = toCodeMuxEvents(
      {
        type: 'tool_execution_end',
        toolCallId: 'call-num',
        toolName: 'bash',
        result: 42,
        isError: false,
      },
      ctx,
    );
    expect(numeric[0]).toMatchObject({ content: '42' });

    // 非文本块的 content 原样透传（对齐 Rust 侧 `other => other.clone()`）。
    const passthrough = toCodeMuxEvents(
      {
        type: 'tool_execution_end',
        toolCallId: 'call-obj',
        toolName: 'bash',
        result: { content: { stdout: 'x' } },
        isError: false,
      },
      ctx,
    );
    expect(passthrough[0]).toMatchObject({ content: '{"stdout":"x"}' });
  });

  it('ignores lifecycle and unsupported events without output', () => {
    const ctx = createContext();
    for (const event of [
      { type: 'agent_start' },
      { type: 'turn_start' },
      { type: 'agent_settled' },
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      { type: 'tool_execution_update', toolCallId: 'call-9', partialResult: 'x' },
      { type: 'compaction_start', reason: 'manual' },
      { type: 'queue_update' },
    ]) {
      expect(toCodeMuxEvents(event, ctx)).toEqual([]);
    }
  });
});
