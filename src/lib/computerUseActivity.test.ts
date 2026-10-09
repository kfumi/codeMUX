// 电脑控制活动信号(工单 10 跟进)契约:提示条/全局 Esc 只在智能体真的在操作
// 桌面时武装 —— 判据是 computer_* 工具调用在飞,不是「某个回合在跑」。
import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '../stores/agentStore';

import { buildConversationTurns } from './conversationTurns';
import {
  isComputerUseToolName,
  subagentTimelineHasPendingComputerUse,
  turnHasPendingComputerUseCall,
  turnIsWaitingOnTool,
} from './computerUseActivity';

describe('isComputerUseToolName', () => {
  it('recognizes the mcp server-prefixed form (Claude / Codex)', () => {
    expect(isComputerUseToolName('mcp__codemux-browser__computer_click')).toBe(true);
    expect(isComputerUseToolName('mcp__codemux-browser__computer_screenshot')).toBe(true);
    expect(isComputerUseToolName('mcp__codemux-browser__computer_set_value')).toBe(true);
  });

  it('recognizes the underscore server-prefixed form (OpenCode style)', () => {
    expect(isComputerUseToolName('codemux-browser_computer_launch')).toBe(true);
    expect(isComputerUseToolName('codemux_browser_computer_type')).toBe(true);
  });

  it('recognizes the bare names daemon approval frames use', () => {
    expect(isComputerUseToolName('computer_elements')).toBe(true);
    expect(isComputerUseToolName('computer_wait')).toBe(true);
  });

  it('is case and whitespace tolerant', () => {
    expect(isComputerUseToolName('  MCP__CODEMUX-BROWSER__COMPUTER_CLICK ')).toBe(true);
  });

  it('never counts browser tools or other mcp servers', () => {
    expect(isComputerUseToolName('browser_click')).toBe(false);
    expect(isComputerUseToolName('mcp__codemux-browser__browser_click')).toBe(false);
    expect(isComputerUseToolName('mcp__context7__resolve-library-id')).toBe(false);
    expect(isComputerUseToolName('mcp__other__computer_click')).toBe(false);
  });

  it('does not count lookalike names', () => {
    expect(isComputerUseToolName('computer_vision')).toBe(false);
    expect(isComputerUseToolName('my_computer_click')).toBe(false);
    expect(isComputerUseToolName('')).toBe(false);
  });
});

let assistantCount = 0;

function user(content: string): AgentMessage {
  return {
    kind: 'user',
    data: { content, locator: { providerMessageId: `user-${content}`, role: 'user', textFingerprint: content } },
  };
}

function assistant(content: Array<Record<string, unknown>>): AgentMessage {
  return {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: `assistant-${++assistantCount}`,
      session_id: 'session-1',
      message: { role: 'assistant', content },
      parent_tool_use_id: null,
    },
  };
}

function toolResult(toolUseId: string): AgentMessage {
  return {
    kind: 'tool_result',
    data: {
      type: 'user',
      uuid: `tool-result-${toolUseId}`,
      session_id: 'session-1',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }],
      },
      parent_tool_use_id: null,
    },
  };
}

function turnsOf(events: AgentMessage[], isRunning: boolean) {
  return buildConversationTurns(events, { isRunning, sessionId: 'session-1' });
}

describe('turnHasPendingComputerUseCall', () => {
  it('is true while a computer tool call waits for its result', () => {
    const [turn] = turnsOf([
      user('看一下这个窗口'),
      assistant([{ type: 'tool_use', id: 'call-1', name: 'mcp__codemux-browser__computer_click', input: {} }]),
    ], true);
    expect(turn && turnHasPendingComputerUseCall(turn)).toBe(true);
  });

  it('is false once the tool result lands', () => {
    const [turn] = turnsOf([
      user('看一下这个窗口'),
      assistant([{ type: 'tool_use', id: 'call-1', name: 'mcp__codemux-browser__computer_click', input: {} }]),
      toolResult('call-1'),
    ], true);
    expect(turn && turnHasPendingComputerUseCall(turn)).toBe(false);
  });

  it('ignores pending browser tools (in-app browser is not desktop control)', () => {
    const [turn] = turnsOf([
      user('点一下页面'),
      assistant([{ type: 'tool_use', id: 'call-2', name: 'mcp__codemux-browser__browser_click', input: {} }]),
    ], true);
    expect(turn && turnHasPendingComputerUseCall(turn)).toBe(false);
  });

  it('is false without pending tools', () => {
    const [turn] = turnsOf([
      user('你好'),
      assistant([{ type: 'text', text: '你好，有什么可以帮你？' }]),
    ], true);
    expect(turn && turnHasPendingComputerUseCall(turn)).toBe(false);
  });
});

describe('turnIsWaitingOnTool', () => {
  it('is true while the last message is the assistant tool call', () => {
    const [turn] = turnsOf([
      user('看一下这个窗口'),
      assistant([{ type: 'tool_use', id: 'call-1', name: 'mcp__codemux-browser__computer_click', input: {} }]),
    ], true);
    expect(turn && turnIsWaitingOnTool(turn)).toBe(true);
  });

  it('stays true while parallel tool results come back one by one', () => {
    const [turn] = turnsOf([
      user('看一下这个窗口'),
      assistant([
        { type: 'tool_use', id: 'call-1', name: 'mcp__codemux-browser__computer_click', input: {} },
        { type: 'tool_use', id: 'call-2', name: 'mcp__codemux-browser__computer_elements', input: {} },
      ]),
      toolResult('call-1'),
    ], true);
    expect(turn && turnIsWaitingOnTool(turn)).toBe(true);
    expect(turn && turnHasPendingComputerUseCall(turn)).toBe(true);
  });

  it('is false once a terminal marker follows the pending tool (stale interrupted turn)', () => {
    const [turn] = turnsOf([
      user('看一下这个窗口'),
      assistant([{ type: 'tool_use', id: 'call-1', name: 'mcp__codemux-browser__computer_click', input: {} }]),
      { kind: 'done' },
    ], true);
    expect(turn && turnIsWaitingOnTool(turn)).toBe(false);
  });
});

describe('subagentTimelineHasPendingComputerUse', () => {
  it('is true while a subagent computer call has no finished frame', () => {
    expect(subagentTimelineHasPendingComputerUse([
      { type: 'tool_started', tool_use_id: 'sub-call-1', name: 'mcp__codemux-browser__computer_key', input: {} },
    ])).toBe(true);
  });

  it('is false once the matching tool_finished arrives', () => {
    expect(subagentTimelineHasPendingComputerUse([
      { type: 'tool_started', tool_use_id: 'sub-call-1', name: 'mcp__codemux-browser__computer_key', input: {} },
      { type: 'tool_finished', tool_use_id: 'sub-call-1', name: 'mcp__codemux-browser__computer_key' },
    ])).toBe(false);
  });

  it('ignores browser tools and unmatched finishes', () => {
    expect(subagentTimelineHasPendingComputerUse([
      { type: 'tool_started', tool_use_id: 'sub-call-2', name: 'mcp__codemux-browser__browser_click', input: {} },
      { type: 'tool_finished', tool_use_id: 'other', name: 'mcp__codemux-browser__computer_click' },
    ])).toBe(false);
  });

  it('keeps the call pending across input refresh frames', () => {
    expect(subagentTimelineHasPendingComputerUse([
      { type: 'tool_started', tool_use_id: 'sub-call-3', name: 'codemux-browser_computer_click', input: {} },
      { type: 'tool_started', tool_use_id: 'sub-call-3', name: 'codemux-browser_computer_click', input: { count: 2 } },
    ])).toBe(true);
  });
});
