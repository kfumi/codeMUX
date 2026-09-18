// @vitest-environment jsdom
/**
 * 导航条标记的用户事件口径：正文里被隐藏的「协议回声」在导航条上也不该有标记。
 *
 * 回归的是 `/compact`：用户敲 `/compact` 时 store 会把这条命令当普通用户消息推进
 * `events`（`startQuery` 的本地显示消息），正文由 `isHiddenAssistantThreadUserEvent`
 * 判定为不可见、只渲染压缩样式标记；而 `buildUserNavItems` 只挡了空文本与中断标记，
 * 于是导航条上凭空多出一条 `/compact` 标记，Claude 的压缩摘要用户行同样漏了进去。
 *
 * 不变量：导航项 ⇔ 正文里真实渲染出来的用户气泡，两边必须用同一条判定。
 */

import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '../../../stores/agentStore';
import { buildUserNavItems } from './CodeMuxThread';

const CLAUDE_COMPACT_SUMMARY_TEXT =
  'This session is being continued from a previous conversation that ran out of context.\n\n'
  + 'Summary:\n1. Primary Request and Intent: 用户要求排查导航条。';

const CODEX_COMPACT_SUMMARY_TEXT =
  'Another language model started to solve this problem and produced a summary of its thinking process.';

function user(content: string, extra: Record<string, unknown> = {}): AgentMessage {
  return { kind: 'user', data: { content, ...extra } as AgentMessage['data'] } as AgentMessage;
}

function assistant(id: string, text: string): AgentMessage {
  return {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: id,
      session_id: 'session-nav-compact',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
    } as AgentMessage['data'],
  } as AgentMessage;
}

function compactBoundary(trigger: 'manual' | 'auto'): AgentMessage {
  return {
    kind: 'compact',
    data: {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger, pre_tokens: 40956 },
    },
  };
}

describe('buildUserNavItems 过滤压缩相关的非用户发言', () => {
  it('Claude 手动 /compact 不产生导航项，前后两轮各自保留', () => {
    const events: AgentMessage[] = [
      user('第一个问题'),
      assistant('assistant-1', '第一个回答'),
      // 用户敲下 /compact：store 里就是一条普通用户事件。
      user('/compact'),
      // Claude 落盘时的压缩摘要与本地命令回声。
      user(CLAUDE_COMPACT_SUMMARY_TEXT, {
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      }),
      user('<local-command-stdout>Compacted</local-command-stdout>'),
      compactBoundary('manual'),
      user('第二个问题'),
      assistant('assistant-2', '第二个回答'),
    ];

    const items = buildUserNavItems(events);

    expect(items.map((item) => item.title)).toEqual(['第一个问题', '第二个问题']);
    expect(items.map((item) => item.eventIndex)).toEqual([0, 6]);
    expect(items.map((item) => item.summary)).toEqual(['第一个回答', '第二个回答']);
  });

  it('Codex 自动压缩不产生导航项，压缩摘要也不冒充上一轮的回答摘要', () => {
    const events: AgentMessage[] = [
      user('问题一'),
      assistant('assistant-1', '回答一'),
      // Codex 把压缩摘要写成普通 assistant 事件，正文里同样被隐藏。
      assistant('assistant-compact', CODEX_COMPACT_SUMMARY_TEXT),
      compactBoundary('auto'),
      user('问题二'),
      assistant('assistant-2', '回答二'),
    ];

    const items = buildUserNavItems(events);

    expect(items.map((item) => item.title)).toEqual(['问题一', '问题二']);
    expect(items.map((item) => item.summary)).toEqual(['回答一', '回答二']);
  });

  it('中断标记与工具结果回填仍然不产生导航项（回归）', () => {
    const interrupt = user('[Request interrupted by user]');
    const toolResultOnly = {
      kind: 'user',
      data: {
        content: '',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
      },
    } as unknown as AgentMessage;
    const events: AgentMessage[] = [
      user('唯一一条真实发言'),
      interrupt,
      toolResultOnly,
      assistant('assistant-1', '回答'),
    ];

    const items = buildUserNavItems(events);

    expect(items.map((item) => item.eventIndex)).toEqual([0]);
    expect(items.map((item) => item.title)).toEqual(['唯一一条真实发言']);
  });
});
