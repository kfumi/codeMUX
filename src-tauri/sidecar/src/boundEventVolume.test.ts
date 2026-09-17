import { describe, expect, it } from 'vitest';
import { boundEventVolume } from './boundEventVolume.js';

const TOOL_OUTPUT_MAX_CHARS = 64 * 1024;
const TOOL_INPUT_MAX_CHARS = 256 * 1024;

describe('boundEventVolume', () => {
  it('leaves small events untouched by reference', () => {
    const event = { type: 'tool_finished', session_id: 's1', content: 'ok', is_error: false };
    expect(boundEventVolume(event)).toBe(event);
  });

  it('leaves non-domain values untouched', () => {
    expect(boundEventVolume('plain')).toBe('plain');
    expect(boundEventVolume(null)).toBe(null);
    expect(boundEventVolume(42)).toBe(42);
  });

  it('truncates oversized tool output and marks it', () => {
    const content = 'x'.repeat(1024 * 1024);
    const bounded = boundEventVolume({ type: 'tool_finished', content, is_error: false }) as Record<string, unknown>;

    expect(bounded.content_truncated).toBe(true);
    expect(bounded.content_full_chars).toBe(content.length);
    expect(String(bounded.content)).toContain('已截断');
    // The kept payload must converge on the cap, not merely carry an annotation.
    expect(String(bounded.content).length).toBeLessThan(TOOL_OUTPUT_MAX_CHARS + 200);
  });

  it('keeps tool output exactly at the boundary', () => {
    const content = 'x'.repeat(TOOL_OUTPUT_MAX_CHARS);
    const event = { type: 'tool_finished', content, is_error: false };
    expect(boundEventVolume(event)).toBe(event);
  });

  it('bounds every oversized string value of tool input', () => {
    const big = 'y'.repeat(TOOL_INPUT_MAX_CHARS + 1_000);
    const bounded = boundEventVolume({
      type: 'tool_started',
      tool_use_id: 't1',
      name: 'Write',
      input: { file_path: 'a.ts', content: big },
    }) as Record<string, unknown>;

    expect(bounded.input_truncated).toBe(true);
    const input = bounded.input as Record<string, unknown>;
    expect(input.file_path).toBe('a.ts');
    expect(String(input.content).length).toBeLessThan(big.length);
  });

  it('bounds streaming tool input deltas', () => {
    const partial = 'z'.repeat(TOOL_INPUT_MAX_CHARS);
    const bounded = boundEventVolume({ type: 'tool_input_delta', partial_json: partial }) as Record<string, unknown>;
    expect(bounded.partial_json_truncated).toBe(true);
    expect(String(bounded.partial_json).length).toBeLessThan(partial.length);
  });

  it('never splits a surrogate pair when clipping', () => {
    const emoji = '😀'; // 2 UTF-16 code units
    const content = emoji.repeat(TOOL_OUTPUT_MAX_CHARS);
    const bounded = boundEventVolume({ type: 'tool_finished', content }) as Record<string, unknown>;
    const kept = String(bounded.content);
    // A dangling high surrogate would make the string encode to U+FFFD.
    expect(kept).not.toContain('\uFFFD');
    expect(kept.charCodeAt(kept.indexOf('…') - 1)).toBeLessThan(0xd800);
  });

  it('descends into batch payloads', () => {
    const batch = {
      type: 'codemux_event_batch',
      session_id: 's1',
      events: [
        { type: 'text_delta', text: 'hi' },
        { type: 'tool_finished', content: 'x'.repeat(TOOL_OUTPUT_MAX_CHARS + 10) },
      ],
    };
    const bounded = boundEventVolume(batch) as { events: Record<string, unknown>[] };
    expect(bounded.events[0].type).toBe('text_delta');
    expect(bounded.events[1].content_truncated).toBe(true);
  });

  it('descends into legacy stream_event envelopes', () => {
    const envelope = {
      type: 'stream_event',
      session_id: 's1',
      event: { type: 'tool_finished', content: 'x'.repeat(TOOL_OUTPUT_MAX_CHARS + 10) },
    };
    const bounded = boundEventVolume(envelope) as { event: Record<string, unknown> };
    expect(bounded.event.content_truncated).toBe(true);
  });

  it('never truncates assistant or user message bodies', () => {
    const body = 'a'.repeat(TOOL_INPUT_MAX_CHARS + 10);
    const assistant = { type: 'assistant_message', content: [{ type: 'text', text: body }] };
    expect(boundEventVolume(assistant)).toBe(assistant);

    const user = { type: 'user_message', content: body };
    expect(boundEventVolume(user)).toBe(user);
  });

  it('never truncates file snapshots because diff stats read them', () => {
    const original = 'o'.repeat(TOOL_INPUT_MAX_CHARS + 10);
    const snapshot = { type: 'file_snapshot', file_path: 'a.ts', original_content: original, is_new: false };
    expect(boundEventVolume(snapshot)).toBe(snapshot);
  });
});
