import { describe, expect, it } from 'vitest';

import { appendEvent, eventToMessages } from './eventToMessages';

describe('appendEvent', () => {
  it('merges streaming assistant deltas', () => {
    let messages = appendEvent([], {
      type: 'text_delta',
      event_id: 'a1',
      text: 'Hello',
    });
    messages = appendEvent(messages, {
      type: 'text_delta',
      event_id: 'a1',
      text: ' world',
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: 'assistant', content: 'Hello world', streaming: true });
  });

  it('merges tool started and finished by tool_use_id', () => {
    let messages = appendEvent([], {
      type: 'tool_started',
      event_id: 't1',
      tool_use_id: 'tool-1',
      name: 'Read',
      input: { path: 'foo.ts' },
    });
    messages = appendEvent(messages, {
      type: 'tool_finished',
      event_id: 't2',
      tool_use_id: 'tool-1',
      name: 'Read',
      content: 'ok',
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: 'tool',
      name: 'Read',
      status: 'complete',
      result: 'ok',
    });
  });

  it('parses assistant_message thinking blocks as reasoning', () => {
    const messages = appendEvent([], {
      type: 'assistant_message',
      event_id: 'm1',
      timestamp: '2026-08-18T07:00:02.000Z',
      uuid: 'assistant-uuid-1',
      content: [
        { type: 'thinking', thinking: 'Let me think...' },
        { type: 'text', text: 'Done.' },
      ],
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      kind: 'reasoning',
      content: 'Let me think...',
      timestamp: Date.parse('2026-08-18T07:00:02.000Z'),
      sourceUuid: 'assistant-uuid-1',
    });
    expect(messages[1]).toMatchObject({
      kind: 'assistant',
      content: 'Done.',
      timestamp: Date.parse('2026-08-18T07:00:02.000Z'),
      sourceUuid: 'assistant-uuid-1',
    });
  });

  it('preserves user message metadata needed by the message footer', () => {
    const messages = appendEvent([], {
      type: 'user_message',
      event_id: 'u-footer-1',
      timestamp: '2026-08-18T07:00:00.000Z',
      uuid: 'user-uuid-1',
      content: 'Show the footer',
    });

    expect(messages[0]).toMatchObject({
      kind: 'user',
      timestamp: Date.parse('2026-08-18T07:00:00.000Z'),
      sourceUuid: 'user-uuid-1',
    });
  });

  it('hides compact summary user events like the desktop transcript', () => {
    expect(eventToMessages({
      type: 'user_message',
      event_id: 'compact-summary-1',
      content: 'This session is being continued from a previous conversation that ran out of context.',
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    })).toEqual([]);
  });

  it('hides compact summary assistant events like the desktop transcript', () => {
    expect(eventToMessages({
      type: 'assistant_message',
      event_id: 'compact-assistant-1',
      content: [{
        type: 'text',
        text: 'Another language model started to solve this problem and produced a summary of its thinking process.',
      }],
    })).toEqual([]);
  });

  it('hides internal system_event subtypes without content', () => {
    const messages = appendEvent([], {
      type: 'system_event',
      event_id: 's1',
      subtype: 'init',
    });
    expect(messages).toHaveLength(0);
  });

  it('renders compact boundary as a readable system marker', () => {
    const messages = appendEvent([], {
      type: 'system_event',
      event_id: 's2',
      subtype: 'compact_boundary',
      compact_metadata: { pre_tokens: 1200 },
    });
    expect(messages[0]).toMatchObject({
      kind: 'system',
      content: expect.stringContaining('上下文已压缩'),
    });
  });

  it('renders the compacting state as a loading marker', () => {
    const messages = appendEvent([], {
      type: 'system_event',
      event_id: 's2-loading',
      subtype: 'compact_boundary',
      compact_metadata: { status: 'compacting', pre_tokens: 0, post_tokens: 0 },
    });
    expect(messages[0]).toMatchObject({
      kind: 'system',
      content: expect.stringContaining('正在压缩上下文'),
    });
  });

  it('merges streaming reasoning deltas', () => {
    let messages = appendEvent([], {
      type: 'reasoning_delta',
      event_id: 'r1',
      text: 'Step 1',
    });
    messages = appendEvent(messages, {
      type: 'reasoning_delta',
      event_id: 'r2',
      text: ' and 2',
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: 'reasoning', content: 'Step 1 and 2', streaming: true });
  });

  it('finalizes streaming placeholders when a turn finishes', () => {
    let messages = appendEvent([], {
      type: 'text_delta',
      event_id: 'a1',
      text: 'Partial answer',
    });
    messages = appendEvent(messages, {
      type: 'turn_finished',
      event_id: 'done-1',
    });
    expect(messages[0]).toMatchObject({ kind: 'assistant', content: 'Partial answer', streaming: false });
  });

  it('dedupes identical consecutive user messages', () => {
    let messages = appendEvent([], {
      type: 'user_message',
      event_id: 'u1',
      content: 'hello',
    });
    messages = appendEvent(messages, {
      type: 'user_message',
      event_id: 'u2',
      content: 'hello',
    });
    expect(messages).toHaveLength(1);
  });

  it('clears permission cards after tool starts on another client', () => {
    let messages = appendEvent([], {
      type: 'permission_requested',
      event_id: 'p1',
      request_id: 'req-1',
      description: 'Allow read?',
    });
    messages = appendEvent(messages, {
      type: 'tool_started',
      event_id: 't1',
      tool_use_id: 'tool-1',
      name: 'Read',
      input: { path: 'foo.ts' },
    });
    expect(messages.some((message) => message.kind === 'permission')).toBe(false);
    expect(messages.some((message) => message.kind === 'tool')).toBe(true);
  });

  it('parses session summary file changes', () => {
    const messages = appendEvent([], {
      type: 'system_event',
      event_id: 'summary-1',
      subtype: 'session_summary',
      diffs: [{ file: 'src/app.ts', additions: 3, deletions: 1 }],
    });
    expect(messages[0]).toMatchObject({
      kind: 'session_summary',
      diffs: [{ file: 'src/app.ts', additions: 3, deletions: 1 }],
    });
  });

  it('parses codex input_text blocks and strips enrichment context', () => {
    const messages = appendEvent([], {
      type: 'user_message',
      event_id: 'u3',
      content: [
        { type: 'input_text', text: '<attachment_context>hidden</attachment_context>Hello /review' },
      ],
    });
    expect(messages[0]).toMatchObject({
      kind: 'user',
      content: 'Hello /review',
    });
  });

  it('filters injected agent prompt user messages', () => {
    const messages = appendEvent([], {
      type: 'user_message',
      event_id: 'u4',
      content: '# AGENTS.md instructions for project\n<INSTRUCTIONS>\nrules',
    });
    expect(messages).toHaveLength(0);
  });

  it('parses runtime_switch as a dedicated seam instead of a system pill', () => {
    const messages = appendEvent([], {
      type: 'system_event',
      event_id: 'rs1',
      subtype: 'runtime_switch',
      from_kind: 'codex',
      to_kind: 'opencode',
      content: '已切换到 OpenCode。',
      briefing: '[CodeMUX runtime switch]\nPrevious driver: Codex.',
    });
    expect(messages[0]).toMatchObject({
      kind: 'runtime_switch',
      fromKind: 'codex',
      toKind: 'opencode',
      briefing: expect.stringContaining('Previous driver: Codex'),
    });
  });

  it('preserves tool name when tool_finished omits name', () => {
    let messages = appendEvent([], {
      type: 'tool_started',
      event_id: 't1',
      tool_use_id: 'tool-1',
      name: 'Bash',
      input: { command: 'pwd' },
    });
    messages = appendEvent(messages, {
      type: 'tool_finished',
      event_id: 't2',
      tool_use_id: 'tool-1',
      content: '/workspace',
    });
    expect(messages[0]).toMatchObject({
      kind: 'tool',
      name: 'Bash',
      status: 'complete',
    });
  });

  it('hides switch briefing-only user messages', () => {
    const messages = appendEvent([], {
      type: 'user_message',
      event_id: 'u5',
      content: '[CodeMUX runtime switch]\nPrevious driver: Codex.\nCurrent driver: OpenCode.',
    });
    expect(messages).toHaveLength(0);
  });

  it('keeps user follow-up after stripping switch briefing prefix', () => {
    const messages = appendEvent([], {
      type: 'user_message',
      event_id: 'u6',
      content: '[CodeMUX runtime switch]\nPrevious driver: Codex.\n---\nUser follow-up:\n继续',
    });
    expect(messages[0]).toMatchObject({ kind: 'user', content: '继续' });
  });

  it('filters switch briefing text from assistant messages', () => {
    const messages = appendEvent([], {
      type: 'assistant_message',
      event_id: 'a2',
      content: [
        { type: 'text', text: '[CodeMUX runtime switch]\nPrevious driver: Codex.' },
      ],
    });
    expect(messages).toHaveLength(0);
  });
});
