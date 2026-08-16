import { describe, expect, it } from 'vitest';

import type { ChatMessage } from './eventToMessages';
import { buildDisplayRows } from './messageLayout';

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
