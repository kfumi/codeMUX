import { describe, expect, it } from 'vitest';

import { eventsToMessages } from './eventToMessages';
import type { ChatMessage } from './eventToMessages';
import { buildDisplayRows } from './messageLayout';
import { buildTurnDurationMap } from './turnDuration';

const tool = (id: string, name: string): ChatMessage => ({
  kind: 'tool',
  id,
  toolUseId: id,
  name,
  status: 'complete',
  collapsed: true,
});

const reasoning = (id: string): ChatMessage => ({
  kind: 'reasoning',
  id,
  content: 'thinking',
  collapsed: true,
});

const assistant = (id: string, content: string): ChatMessage => ({
  kind: 'assistant',
  id,
  content,
});

const user = (id: string, content: string): ChatMessage => ({
  kind: 'user',
  id,
  content,
});

describe('buildDisplayRows', () => {
  it('groups reasoning and read tools into an explore row', () => {
    const rows = buildDisplayRows([
      user('u1', 'hi'),
      reasoning('r1'),
      tool('t1', 'Read'),
      assistant('a1', 'done'),
    ], { compactAiOutput: false, expandedTurnKeys: new Set() });

    expect(rows.map((row) => row.kind)).toEqual(['single', 'explore', 'single']);
    const explore = rows.find((row) => row.kind === 'explore');
    expect(explore?.kind === 'explore' && explore.toolNames).toEqual(['Read']);
  });

  it('renders a reasoning-only process as a thinking row', () => {
    const rows = buildDisplayRows([
      user('u1', 'hi'),
      reasoning('r1'),
      assistant('a1', 'done'),
    ], { compactAiOutput: false, expandedTurnKeys: new Set() });

    expect(rows.map((row) => row.kind)).toEqual(['single', 'thinking', 'single']);
    const thinking = rows.find((row) => row.kind === 'thinking');
    expect(thinking?.kind === 'thinking' && thinking.messages.map((message) => message.id)).toEqual(['r1']);
  });

  it('keeps write tools outside explore groups', () => {
    const rows = buildDisplayRows([
      user('u1', 'hi'),
      tool('t1', 'Read'),
      tool('t2', 'Write'),
      tool('t3', 'Bash'),
    ], { compactAiOutput: false, expandedTurnKeys: new Set() });

    expect(rows.filter((row) => row.kind === 'explore')).toHaveLength(2);
    expect(rows.some((row) => row.kind === 'single' && row.message.kind === 'tool' && row.message.name === 'Write')).toBe(true);
  });

  it('collapses process rows behind a compact toggle', () => {
    const rows = buildDisplayRows([
      user('u1', 'hi'),
      reasoning('r1'),
      tool('t1', 'Read'),
      assistant('a1', 'done'),
    ], { compactAiOutput: true, expandedTurnKeys: new Set() });

    expect(rows.map((row) => row.kind)).toEqual(['single', 'compact-toggle', 'single']);
  });

  it('expands compact process rows when the turn is open', () => {
    const rows = buildDisplayRows([
      user('u1', 'hi'),
      reasoning('r1'),
      tool('t1', 'Read'),
      assistant('a1', 'done'),
    ], { compactAiOutput: true, expandedTurnKeys: new Set(['u1']) });

    expect(rows.map((row) => row.kind)).toEqual(['single', 'compact-toggle', 'explore', 'single']);
  });

  it('passes the completed turn duration to the compact process toggle', () => {
    const rows = buildDisplayRows([
      user('u1', 'hi'),
      reasoning('r1'),
      tool('t1', 'Read'),
      assistant('a1', 'done'),
    ], {
      compactAiOutput: true,
      expandedTurnKeys: new Set(),
      turnDurationsByUserId: new Map([['u1', 12_000]]),
    });

    const toggle = rows.find((row) => row.kind === 'compact-toggle');
    expect(toggle?.kind === 'compact-toggle' && toggle.durationMs).toBe(12_000);
  });

  it('keeps reasoning-only process as a thinking row when compact output is enabled', () => {
    const rows = buildDisplayRows([
      user('u-reasoning-only', 'hi'),
      reasoning('r-reasoning-only'),
      assistant('a-reasoning-only', 'done'),
    ], {
      compactAiOutput: true,
      expandedTurnKeys: new Set(),
      turnDurationsByUserId: new Map([['u-reasoning-only', 55_000]]),
    });

    expect(rows.map((row) => row.kind)).toEqual(['single', 'thinking', 'single']);
    expect(rows.some((row) => row.kind === 'compact-toggle')).toBe(false);
  });

  it('merges OpenCode intermediate results into one final compact process row', () => {
    const events = [
      { type: 'user_message', event_id: 'u-opencode', content: 'inspect the project history' },
      {
        type: 'assistant_message',
        event_id: 'a-process-1',
        content: [
          { type: 'thinking', thinking: '历史思考一' },
          { type: 'text', text: '历史过程一' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
        ],
      },
      { type: 'turn_finished', duration_ms: 400 },
      {
        type: 'assistant_message',
        event_id: 'a-process-2',
        content: [
          { type: 'thinking', thinking: '历史思考二' },
          { type: 'text', text: '历史过程二' },
          { type: 'tool_use', id: 'tool-2', name: 'Grep', input: {} },
        ],
      },
      { type: 'turn_finished', duration_ms: 800 },
      {
        type: 'assistant_message',
        event_id: 'a-final',
        content: [
          { type: 'thinking', thinking: '最终思考泄漏' },
          { type: 'text', text: '历史最终结果' },
        ],
      },
      { type: 'turn_finished', duration_ms: 1_200 },
    ];
    const messages = eventsToMessages(events);
    const rows = buildDisplayRows(messages, {
      compactAiOutput: true,
      expandedTurnKeys: new Set(),
      turnDurationsByUserId: buildTurnDurationMap(events),
    });

    expect(rows.filter((row) => row.kind === 'compact-toggle')).toHaveLength(1);
    const toggle = rows.find((row) => row.kind === 'compact-toggle');
    expect(toggle?.kind === 'compact-toggle' && toggle.durationMs).toBe(1_200);
    expect(rows.some((row) => (
      row.kind === 'single'
      && row.message.kind === 'assistant'
      && row.message.content === '历史最终结果'
    ))).toBe(true);
  });

  it('attaches desktop-equivalent footer stats to user and final assistant rows', () => {
    const rows = buildDisplayRows([
      {
        kind: 'user',
        id: 'u-footer',
        content: 'hi',
        timestamp: Date.parse('2026-08-18T07:00:00.000Z'),
      },
      {
        kind: 'reasoning',
        id: 'r-footer',
        content: 'thinking',
        collapsed: true,
      },
      {
        kind: 'assistant',
        id: 'a-footer',
        content: 'done',
        timestamp: Date.parse('2026-08-18T07:00:12.000Z'),
      },
    ], {
      compactAiOutput: true,
      expandedTurnKeys: new Set(),
      turnDurationsByUserId: new Map([['u-footer', 12_000]]),
    });

    const userRow = rows.find((row) => row.kind === 'single' && row.message.kind === 'user');
    const assistantRow = rows.find((row) => row.kind === 'single' && row.message.kind === 'assistant');

    expect(userRow?.kind === 'single' && userRow.footer).toEqual({
      timestamp: Date.parse('2026-08-18T07:00:00.000Z'),
    });
    expect(assistantRow?.kind === 'single' && assistantRow.footer).toEqual({
      timestamp: Date.parse('2026-08-18T07:00:12.000Z'),
      durationMs: 12_000,
    });
  });

  it('attaches session summary to the final assistant answer', () => {
    const rows = buildDisplayRows([
      user('u1', 'hi'),
      tool('t1', 'Write'),
      {
        kind: 'session_summary',
        id: 's1',
        diffs: [{ file: 'docs/adr/0008-mobile-companion.md', additions: 42 }],
      },
      assistant('a1', 'done'),
    ], { compactAiOutput: false, expandedTurnKeys: new Set() });

    const assistantRow = rows.find((row) => row.kind === 'single' && row.message.kind === 'assistant');
    expect(assistantRow?.kind === 'single' && assistantRow.sessionSummaries).toEqual([
      { file: 'docs/adr/0008-mobile-companion.md', additions: 42 },
    ]);
    expect(rows.some((row) => row.kind === 'single' && row.message.kind === 'session_summary')).toBe(false);
  });

  it('keeps runtime switch seams visible when compact output is enabled', () => {
    const rows = buildDisplayRows([
      user('u1', 'hi'),
      reasoning('r1'),
      tool('t1', 'Read'),
      {
        kind: 'runtime_switch',
        id: 'sw1',
        fromKind: 'opencode',
        toKind: 'claude_code',
        content: '已切换智能体',
      },
      assistant('a1', 'done'),
    ], { compactAiOutput: true, expandedTurnKeys: new Set() });

    expect(rows.map((row) => row.kind)).toEqual(['single', 'compact-toggle', 'single', 'single']);
    const seam = rows.find((row) => row.kind === 'single' && row.message.kind === 'runtime_switch');
    expect(seam?.kind === 'single' && seam.message.kind === 'runtime_switch').toBe(true);
  });

  it('keeps compact boundary seams visible when compact output is enabled', () => {
    const rows = buildDisplayRows([
      user('u1', 'hi'),
      reasoning('r1'),
      { kind: 'system', id: 'c1', content: '— 上下文已压缩 · 节省 1.2k tokens —' },
      assistant('a1', 'done'),
    ], { compactAiOutput: true, expandedTurnKeys: new Set() });

    expect(rows.some((row) => (
      row.kind === 'single'
      && row.message.kind === 'system'
      && row.message.content.includes('上下文已压缩')
    ))).toBe(true);
  });
});
