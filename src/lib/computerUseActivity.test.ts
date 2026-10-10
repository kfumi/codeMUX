// 电脑控制活动信号(工单 10 及其跟进,口径见工单 15)契约:提示条/全局 Esc 只在智能体
// 真的在操作桌面时武装 —— 判据是「这个回合里出现过 computer_* 调用」,不看结果是否
// 已回,所以模型两次调用之间的思考空档不会把提示条闪断。
import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '../stores/agentStore';

import { buildConversationTurns } from './conversationTurns';
import {
  isComputerUseToolName,
  subagentTimelineHasComputerUse,
  turnHasComputerUseCall,
  turnIsWaitingOnTool,
} from './computerUseActivity';

describe('isComputerUseToolName', () => {
  it('recognizes the current server name (codemux-control) in every spelling', () => {
    expect(isComputerUseToolName('mcp__codemux-control__computer_click')).toBe(true);
    expect(isComputerUseToolName('mcp__codemux-control__computer_screenshot')).toBe(true);
    expect(isComputerUseToolName('mcp__codemux-control__computer_set_value')).toBe(true);
    expect(isComputerUseToolName('codemux-control_computer_launch')).toBe(true);
    expect(isComputerUseToolName('codemux_control_computer_type')).toBe(true);
  });

  it('still recognizes the pre-rename server name (historical transcripts)', () => {
    expect(isComputerUseToolName('mcp__codemux-browser__computer_click')).toBe(true);
    expect(isComputerUseToolName('codemux-browser_computer_launch')).toBe(true);
    expect(isComputerUseToolName('codemux_browser_computer_type')).toBe(true);
  });

  it('recognizes the bare names daemon approval frames use', () => {
    expect(isComputerUseToolName('computer_elements')).toBe(true);
    expect(isComputerUseToolName('computer_wait')).toBe(true);
  });

  it('is case and whitespace tolerant', () => {
    expect(isComputerUseToolName('  MCP__CODEMUX-CONTROL__COMPUTER_CLICK ')).toBe(true);
    expect(isComputerUseToolName('  MCP__CODEMUX-BROWSER__COMPUTER_CLICK ')).toBe(true);
  });

  it('never counts browser tools or other mcp servers', () => {
    expect(isComputerUseToolName('browser_click')).toBe(false);
    expect(isComputerUseToolName('mcp__codemux-control__browser_click')).toBe(false);
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

describe('turnHasComputerUseCall', () => {
  it('is true while a computer tool call waits for its result', () => {
    const [turn] = turnsOf([
      user('看一下这个窗口'),
      assistant([{ type: 'tool_use', id: 'call-1', name: 'mcp__codemux-browser__computer_click', input: {} }]),
    ], true);
    expect(turn && turnHasComputerUseCall(turn)).toBe(true);
  });

  it('stays true once the result lands (this episode is not over)', () => {
    const [turn] = turnsOf([
      user('看一下这个窗口'),
      assistant([{ type: 'tool_use', id: 'call-1', name: 'mcp__codemux-browser__computer_click', input: {} }]),
      toolResult('call-1'),
    ], true);
    expect(turn && turnHasComputerUseCall(turn)).toBe(true);
  });

  it('stays true across the thinking gap between two desktop steps', () => {
    const [turn] = turnsOf([
      user('打开记事本输入测试123'),
      assistant([{ type: 'tool_use', id: 'call-1', name: 'mcp__codemux-browser__computer_click', input: {} }]),
      toolResult('call-1'),
      assistant([{ type: 'text', text: '我再看一下窗口里的内容' }]),
    ], true);
    expect(turn && turnHasComputerUseCall(turn)).toBe(true);
  });

  it('ignores browser tools (in-app browser is not desktop control)', () => {
    const [turn] = turnsOf([
      user('点一下页面'),
      assistant([{ type: 'tool_use', id: 'call-2', name: 'mcp__codemux-browser__browser_click', input: {} }]),
    ], true);
    expect(turn && turnHasComputerUseCall(turn)).toBe(false);
  });

  it('is false without computer-use tools', () => {
    const [turn] = turnsOf([
      user('你好'),
      assistant([{ type: 'text', text: '你好，有什么可以帮你？' }]),
    ], true);
    expect(turn && turnHasComputerUseCall(turn)).toBe(false);
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
    expect(turn && turnHasComputerUseCall(turn)).toBe(true);
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

describe('subagentTimelineHasComputerUse', () => {
  it('is true while a subagent computer call has no finished frame', () => {
    expect(subagentTimelineHasComputerUse([
      { type: 'tool_started', tool_use_id: 'sub-call-1', name: 'mcp__codemux-browser__computer_key', input: {} },
    ])).toBe(true);
  });

  it('stays true after the matching tool_finished (the subagent is still working)', () => {
    expect(subagentTimelineHasComputerUse([
      { type: 'tool_started', tool_use_id: 'sub-call-1', name: 'mcp__codemux-browser__computer_key', input: {} },
      { type: 'tool_finished', tool_use_id: 'sub-call-1', name: 'mcp__codemux-browser__computer_key' },
    ])).toBe(true);
  });

  it('ignores browser tools and frames without a tool name', () => {
    expect(subagentTimelineHasComputerUse([
      { type: 'tool_started', tool_use_id: 'sub-call-2', name: 'mcp__codemux-browser__browser_click', input: {} },
      { type: 'tool_finished', tool_use_id: 'other' },
    ])).toBe(false);
  });

  it('sees the call across input refresh frames', () => {
    expect(subagentTimelineHasComputerUse([
      { type: 'tool_started', tool_use_id: 'sub-call-3', name: 'codemux-browser_computer_click', input: {} },
      { type: 'tool_started', tool_use_id: 'sub-call-3', name: 'codemux-browser_computer_click', input: { count: 2 } },
    ])).toBe(true);
  });
});
