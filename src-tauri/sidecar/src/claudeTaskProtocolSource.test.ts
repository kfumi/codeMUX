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
});
