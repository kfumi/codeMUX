import { describe, expect, it } from 'vitest';
import { ClaudeTaskProtocolSource } from './claudeTaskProtocolSource.js';
import type { CodeMuxSubagentEvent, CodeMuxSubagentTimelineEvent, CodeMuxSubagentUpsertEvent } from './codeMuxProtocol.js';

function taskStarted(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: 'task-1',
    tool_use_id: 'toolu_1',
    task_type: 'local_agent',
    subagent_type: 'Explore',
    prompt: 'find all entry points',
    ...overrides,
  };
}

function isUpsert(event: CodeMuxSubagentEvent): event is CodeMuxSubagentUpsertEvent {
  return event.type === 'subagent_upsert';
}

function isTimeline(event: CodeMuxSubagentEvent): event is CodeMuxSubagentTimelineEvent {
  return event.type === 'subagent_timeline';
}

describe('ClaudeTaskProtocolSource.observe', () => {
  it('declares a subagent from task_started with canonical id = first tool_use_id', () => {
    const source = new ClaudeTaskProtocolSource();
    const events = source.observe(taskStarted(), { sessionId: 'app-1' });

    const upserts = events.filter(isUpsert);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      type: 'subagent_upsert',
      session_id: 'app-1',
      subagent_id: 'toolu_1',
      provider: 'claude',
      title: 'Explore',
      status: 'running',
      tool_call_id: 'toolu_1',
    });
    // The prompt becomes the first timeline entry.
    const timeline = events.filter(isTimeline);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].subagent_id).toBe('toolu_1');
    expect(timeline[0].event).toMatchObject({ type: 'user_message', content: 'find all entry points' });
  });

  it('records new tool_use_id as an alias instead of creating a second descriptor', () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted(), {});
    const events = source.observe(taskStarted({ tool_use_id: 'toolu_2' }), {});

    const upserts = events.filter(isUpsert);
    expect(upserts).toHaveLength(0);
    expect(source.resolveSubagentId('toolu_2')).toBe('toolu_1');
  });

  it('ignores local_bash tasks', () => {
    const source = new ClaudeTaskProtocolSource();
    const events = source.observe(taskStarted({ task_type: 'local_bash', subagent_type: undefined }), {});
    expect(events).toHaveLength(0);
  });

  it('ignores skip_transcript tasks and tasks without any subagent marker', () => {
    const source = new ClaudeTaskProtocolSource();
    expect(source.observe(taskStarted({ skip_transcript: true }), {})).toHaveLength(0);
    expect(source.observe(taskStarted({ task_type: undefined, subagent_type: undefined }), {})).toHaveLength(0);
  });

  it('routes sidechain frames to the declared subagent as timeline events', () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted(), {});

    const events = source.observe({
      type: 'assistant',
      isSidechain: true,
      parent_tool_use_id: 'toolu_1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'looking at src/main.ts' },
          { type: 'tool_use', id: 'toolu_child_1', name: 'Grep', input: { pattern: 'main' } },
        ],
      },
    }, {});

    const timeline = events.filter(isTimeline);
    expect(timeline.map((event) => event.subagent_id)).toEqual(['toolu_1', 'toolu_1']);
    // Tool events are projected first, then the remaining text content (same
    // ordering as the parent turn projection).
    expect(timeline[0].event).toMatchObject({ type: 'tool_started', tool_use_id: 'toolu_child_1', name: 'Grep' });
    expect(timeline[1].event).toMatchObject({ type: 'assistant_message' });
    // Per-subagent sequence is monotonic.
    const sequences = timeline.map((event) => (event.event as { sequence: number }).sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });

  it('drops sidechain frames for undeclared tool ids', () => {
    const source = new ClaudeTaskProtocolSource();
    const events = source.observe({
      type: 'assistant',
      isSidechain: true,
      parent_tool_use_id: 'toolu_unknown',
      message: { role: 'assistant', content: [{ type: 'text', text: 'orphan' }] },
    }, {});
    expect(events).toHaveLength(0);
  });

  it('keeps explicitly-backgrounded children running after parent result', () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted(), {});
    source.observe({ type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { is_backgrounded: true } }, {});

    const cancelEvents = source.cancelRunningForegroundTasks();
    expect(cancelEvents).toHaveLength(0);
    expect(source.hasRunningTasks()).toBe(true);
  });

  it('cancels explicitly-foreground children on parent result', () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted(), {});
    source.observe({ type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { is_backgrounded: false } }, {});

    const cancelEvents = source.cancelRunningForegroundTasks();
    const upserts = cancelEvents.filter(isUpsert);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ subagent_id: 'toolu_1', status: 'canceled' });
    expect(source.hasRunningTasks()).toBe(false);
  });

  it('keeps children without a backgrounded patch running after parent result', () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted(), {});

    expect(source.cancelRunningForegroundTasks()).toHaveLength(0);
    expect(source.hasRunningTasks()).toBe(true);
  });

  it('fails all running children (incl. backgrounded) on stop', () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted({ task_id: 'task-1', tool_use_id: 'toolu_1' }), {});
    source.observe(taskStarted({ task_id: 'task-2', tool_use_id: 'toolu_2' }), {});
    source.observe({ type: 'system', subtype: 'task_updated', task_id: 'task-2', patch: { is_backgrounded: true } }, {});

    const events = source.failRunningTasks();
    const upserts = events.filter(isUpsert);
    expect(upserts.map((event) => [event.subagent_id, event.status])).toEqual([
      ['toolu_1', 'failed'],
      ['toolu_2', 'failed'],
    ]);
    expect(source.hasRunningTasks()).toBe(false);
  });

  it('maps task_notification terminal statuses and usage subtitles', () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted(), {});

    const events = source.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-1',
      status: 'completed',
      usage: { input_tokens: 3200, output_tokens: 8100 },
    }, {});

    const upserts = events.filter(isUpsert);
    const status = upserts.find((event) => event.status);
    expect(status).toMatchObject({ subagent_id: 'toolu_1', status: 'completed' });
    const subtitle = upserts.find((event) => event.subtitle);
    expect(subtitle?.subtitle).toContain('3.2k');
  });

  it('maps killed/stopped statuses to canceled', () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted(), {});
    const events = source.observe({ type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { status: 'stopped' } }, {});
    expect(events.filter(isUpsert)[0]).toMatchObject({ status: 'canceled' });
  });

  it('never resurrects a terminal descriptor back to running', () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted(), {});
    source.observe({ type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed' }, {});

    const events = source.observe({ type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { status: 'running' } }, {});
    expect(events.filter(isUpsert)).toHaveLength(0);
  });

  it('emits a workflow declaration with description as the first timeline entry', () => {
    const source = new ClaudeTaskProtocolSource();
    const events = source.observe(taskStarted({
      task_type: 'local_workflow',
      subagent_type: undefined,
      description: 'multi-step refactor',
      prompt: 'ignored for workflow',
    }), {});

    const timeline = events.filter(isTimeline);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].event).toMatchObject({ type: 'user_message', content: 'multi-step refactor' });
  });

  it('routes final sidechain summaries that only carry parentUuid', () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted(), {});

    source.observe({
      type: 'assistant',
      isSidechain: true,
      parent_tool_use_id: 'toolu_1',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'a.ts' } }],
      },
    }, {});

    source.observe({
      type: 'user',
      uuid: 'tool-result-1',
      isSidechain: true,
      parent_tool_use_id: 'toolu_1',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'ok' }],
      },
    }, {});

    const events = source.observe({
      type: 'assistant',
      isSidechain: true,
      parentUuid: 'tool-result-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '- Status: DONE\n- Commit: 1d585333' }],
      },
    }, {});

    const summaries = events
      .filter(isTimeline)
      .filter((event) => event.event.type === 'assistant_message');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].subagent_id).toBe('toolu_1');
    expect(summaries[0].event).toMatchObject({
      content: [{ type: 'text', text: '- Status: DONE\n- Commit: 1d585333' }],
    });
  });

  it('carries the sidechain frame model on the projected assistant_message event', () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted(), {});

    const sidechainFrame = (overrides: Record<string, unknown>): Record<string, unknown> => ({
      type: 'assistant',
      isSidechain: true,
      parent_tool_use_id: 'toolu_1',
      ...overrides,
    });

    const withModel = source.observe(sidechainFrame({
      uuid: 'sidechain-model-1',
      message: {
        role: 'assistant',
        model: 'glm-5.3-flash',
        content: [{ type: 'text', text: 'reading main.ts' }],
      },
    }), {});

    const assistant = withModel
      .filter(isTimeline)
      .find((event) => event.event.type === 'assistant_message');
    expect(assistant?.event).toMatchObject({ type: 'assistant_message', model: 'glm-5.3-flash' });

    // A frame without a model must not gain a `model` key (safe degrade).
    const withoutModel = source.observe(sidechainFrame({
      uuid: 'sidechain-model-2',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    }), {});
    const plain = withoutModel
      .filter(isTimeline)
      .find((event) => event.event.type === 'assistant_message');
    expect(plain?.event).not.toHaveProperty('model');
  });

  it('tool-only sidechain frames carry the model on the tool_started event', () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted(), {});

    // Explore 类子智能体常年只调工具、不产文本：这种帧不会留下 assistant_message，
    // 模型名必须挂在 tool_started 上，否则界面上只能退回显示 provider（`claude`）。
    const toolOnly = source.observe({
      type: 'assistant',
      isSidechain: true,
      parent_tool_use_id: 'toolu_1',
      uuid: 'sidechain-tool-only-1',
      message: {
        role: 'assistant',
        model: 'glm-5.3-flash',
        content: [{ type: 'tool_use', id: 'toolu_child_1', name: 'Read', input: { file_path: 'src/main.ts' } }],
      },
    }, {});

    const timeline = toolOnly.filter(isTimeline);
    expect(timeline.some((event) => event.event.type === 'assistant_message')).toBe(false);
    const started = timeline.find((event) => event.event.type === 'tool_started');
    expect(started?.event).toMatchObject({
      type: 'tool_started',
      tool_use_id: 'toolu_child_1',
      model: 'glm-5.3-flash',
    });

    // 帧上没有模型时不加 `model` 键（安全降级）。
    const withoutModel = source.observe({
      type: 'assistant',
      isSidechain: true,
      parent_tool_use_id: 'toolu_1',
      uuid: 'sidechain-tool-only-2',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_child_2', name: 'Read', input: { file_path: 'src/app.ts' } }],
      },
    }, {});
    const plain = withoutModel.filter(isTimeline).find((event) => event.event.type === 'tool_started');
    expect(plain?.event).not.toHaveProperty('model');
  });

  it('ignores non-task and non-sidechain messages', () => {
    const source = new ClaudeTaskProtocolSource();
    expect(source.observe({ type: 'assistant', message: { role: 'assistant', content: [] } }, {})).toHaveLength(0);
    expect(source.observe({ type: 'system', subtype: 'init', mcp_servers: [] }, {})).toHaveLength(0);
  });

  it('reset clears all state', () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted(), {});
    source.reset();
    expect(source.hasRunningTasks()).toBe(false);
    expect(source.resolveSubagentId('toolu_1')).toBeUndefined();
  });
  it('assembles sidechain stream deltas into an assistant_message on the subagent', () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted(), {});

    // 线上实测（会话 8ba20d2b）：子会话的思考/正文只以 stream_event 增量到达，
    // 聚合帧只带 tool_use。增量本身不能进时间线（面板不渲染半截文本）。
    const streamFrame = (inner: Record<string, unknown>): Record<string, unknown> => ({
      type: 'stream_event',
      isSidechain: true,
      parent_tool_use_id: 'toolu_1',
      event: inner,
    });

    expect(source.observe(streamFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }), {})).toEqual([]);
    expect(source.observe(streamFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I will ' } }), {})).toEqual([]);
    expect(source.observe(streamFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'read the config.' } }), {})).toEqual([]);

    const flushed = source.observe(streamFrame({ type: 'content_block_stop', index: 0 }), {});
    const message = flushed.filter(isTimeline)[0];
    expect(message?.subagent_id).toBe('toolu_1');
    expect(message?.event).toMatchObject({
      type: 'assistant_message',
      content: [{ type: 'text', text: 'I will read the config.' }],
    });

    // 思考块合成 thinking 块。
    source.observe(streamFrame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }), {});
    source.observe(streamFrame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先看目录' } }), {});
    const thinking = source.observe(streamFrame({ type: 'content_block_stop', index: 0 }), {}).filter(isTimeline)[0];
    expect(thinking?.event).toMatchObject({
      type: 'assistant_message',
      content: [{ type: 'thinking', thinking: '先看目录' }],
    });

    // 只有空白的块不合成消息。
    source.observe(streamFrame({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }), {});
    source.observe(streamFrame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '   ' } }), {});
    expect(source.observe(streamFrame({ type: 'content_block_stop', index: 1 }), {})).toEqual([]);

    // 没有父工具 id 的流帧无从归属：丢弃，而不是塞进父线程。
    expect(source.observe({
      type: 'stream_event',
      isSidechain: true,
      event: { type: 'content_block_stop', index: 0 },
    }, {})).toEqual([]);
  });

});
