import { describe, expect, it } from 'vitest';
import { convertChatStreamToResponsesEvents } from './codexStreamTransform.js';

async function collectEvents(chunks: AsyncIterable<Record<string, unknown>>): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  for await (const event of chunks) events.push(event);
  return events;
}

async function* makeChunks(items: Array<Record<string, unknown>>): AsyncGenerator<Record<string, unknown>> {
  for (const item of items) yield item;
}

const IDS = { responseId: 'resp_1', model: 'test', reasoningId: 'rs_1', messageId: 'msg_1' };

describe('convertChatStreamToResponsesEvents', () => {
  it('emits response.created and response.in_progress', async () => {
    const events = await collectEvents(convertChatStreamToResponsesEvents(makeChunks([
      { choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] },
    ]), IDS));
    expect(events[0].type).toBe('response.created');
    expect(events[1].type).toBe('response.in_progress');
  });

  it('converts text deltas to output_text.delta', async () => {
    const events = await collectEvents(convertChatStreamToResponsesEvents(makeChunks([
      { choices: [{ delta: { content: 'hello' }, finish_reason: null }] },
      { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }] },
    ]), IDS));
    const textDeltas = events.filter((e) => e.type === 'response.output_text.delta');
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0].delta).toBe('hello');
    expect(textDeltas[1].delta).toBe(' world');
  });

  it('converts reasoning_content deltas', async () => {
    const events = await collectEvents(convertChatStreamToResponsesEvents(makeChunks([
      { choices: [{ delta: { reasoning_content: 'let me think...' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
    ]), IDS));
    const reasoningDeltas = events.filter((e) => e.type === 'response.reasoning_delta');
    expect(reasoningDeltas).toHaveLength(1);
    expect(reasoningDeltas[0].delta).toEqual({ type: 'reasoning_summary_text_delta', text: 'let me think...' });
  });

  it('detects inline <think> tags in content and splits to reasoning + text', async () => {
    const events = await collectEvents(convertChatStreamToResponsesEvents(makeChunks([
      { choices: [{ delta: { content: '<think>plan' }, finish_reason: null }] },
      { choices: [{ delta: { content: ' details</think>answer' }, finish_reason: 'stop' }] },
    ]), IDS));
    const reasoningDeltas = events.filter((e) => e.type === 'response.reasoning_delta');
    const textDeltas = events.filter((e) => e.type === 'response.output_text.delta');
    expect(reasoningDeltas.length).toBeGreaterThanOrEqual(1);
    const reasoningText = reasoningDeltas.map((e) => (e.delta as any).text).join('');
    expect(reasoningText).toContain('plan');
    expect(reasoningText).toContain('details');
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    const textContent = textDeltas.map((e) => e.delta).join('');
    expect(textContent).toContain('answer');
  });

  it('handles <think> split across multiple chunks', async () => {
    const events = await collectEvents(convertChatStreamToResponsesEvents(makeChunks([
      { choices: [{ delta: { content: '<think>rea' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'soning</th' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'ink>text' }, finish_reason: 'stop' }] },
    ]), IDS));
    const reasoningDeltas = events.filter((e) => e.type === 'response.reasoning_delta');
    const textDeltas = events.filter((e) => e.type === 'response.output_text.delta');
    expect(reasoningDeltas.length).toBeGreaterThanOrEqual(1);
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
  });

  it('accumulates tool_calls across chunks', async () => {
    const events = await collectEvents(convertChatStreamToResponsesEvents(makeChunks([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"/tmp"}' } }] }, finish_reason: 'stop' }] },
    ]), IDS));
    const functionCallDone = events.filter((e) => e.type === 'response.function_call_arguments.done');
    expect(functionCallDone).toHaveLength(1);
    expect(functionCallDone[0].arguments).toBe('{"path":"/tmp"}');
  });

  it('emits response.completed with usage', async () => {
    const events = await collectEvents(convertChatStreamToResponsesEvents(makeChunks([
      { choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ]), IDS));
    const completed = events.find((e) => e.type === 'response.completed');
    expect(completed).toBeTruthy();
    const response = completed!.response as any;
    expect(response.usage.input_tokens).toBe(10);
    expect(response.usage.output_tokens).toBe(5);
  });

  it('closes items on finish_reason, not just at generator end', async () => {
    const events = await collectEvents(convertChatStreamToResponsesEvents(makeChunks([
      { choices: [{ delta: { content: 'text' }, finish_reason: 'stop' }] },
    ]), IDS));
    const itemDone = events.filter((e) => e.type === 'response.output_item.done');
    expect(itemDone.length).toBeGreaterThanOrEqual(1);
  });
});
