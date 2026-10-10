// @vitest-environment jsdom
// 全局 Esc 急停的武装窗口(工单 10 及其跟进,口径见工单 15):只在「系统级执行开启 +
// 有回合在跑 + 这个回合里出现过 computer_* 调用」时武装 —— 纯聊天回合不该武装,更不
// 该弹提示条;而一旦进入桌面操作过程,提示条随武装状态常驻到回合结束(不再 1s 收起)。
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeState = vi.hoisted(() => ({ present: true }));

const { setArmedMock, onEmergencyStopMock, unsubscribeMock } = vi.hoisted(() => ({
  setArmedMock: vi.fn(async (armed: boolean) => armed),
  onEmergencyStopMock: vi.fn(() => unsubscribeMock),
  unsubscribeMock: vi.fn(),
}));

vi.mock('../lib/desktop-bridge', async () => {
  const actual =
    await vi.importActual<typeof import('../lib/desktop-bridge')>('../lib/desktop-bridge');
  return {
    ...actual,
    get desktopBridge() {
      return bridgeState.present
        ? { setEmergencyStopArmed: setArmedMock, onEmergencyStop: onEmergencyStopMock }
        : undefined;
    },
  };
});

import { buildConversationTurns } from '../lib/conversationTurns';
import type { ComputerUseApprovalRequest } from '../lib/computerUseApprovals';
import type { AgentMessage } from '../stores/agentStore';
import { useAgentStore } from '../stores/agentStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useSubagentStore } from '../stores/subagentStore';
import { useEmergencyStop } from './useEmergencyStop';

type Turns = ReturnType<typeof buildConversationTurns>;

function setComputerUse(settings: { enabled?: boolean; systemExecution?: boolean }): void {
  useSettingsStore.setState({
    config: {
      computer_use: {
        enabled: settings.enabled ?? true,
        system_execution_enabled: settings.systemExecution ?? true,
      },
    } as never,
  });
}

function setRunning(sessions: Record<string, boolean>): void {
  useAgentStore.setState({ isRunning: sessions });
}

function setTurns(turns: Record<string, Turns>): void {
  useAgentStore.setState({ turns });
}

function setApprovals(approvals: Record<string, ComputerUseApprovalRequest[]>): void {
  useAgentStore.setState({ pendingComputerUseApprovals: approvals });
}

let assistantCount = 0;

function userMessage(content: string): AgentMessage {
  return {
    kind: 'user',
    data: { content, locator: { providerMessageId: `user-${content}`, role: 'user', textFingerprint: content } },
  };
}

function assistantText(text: string): AgentMessage {
  return assistantBlocks([{ type: 'text', text }]);
}

function computerCall(id: string, name = 'mcp__codemux-control__computer_click'): AgentMessage {
  return assistantBlocks([{ type: 'tool_use', id, name, input: {} }]);
}

function assistantBlocks(content: Array<Record<string, unknown>>): AgentMessage {
  return {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: `assistant-${++assistantCount}`,
      session_id: 'sessionA',
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
      session_id: 'sessionA',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }],
      },
      parent_tool_use_id: null,
    },
  };
}

function runningTurns(events: AgentMessage[]): Turns {
  return buildConversationTurns(events, { isRunning: true, sessionId: 'sessionA' });
}

function approval(tool: string): ComputerUseApprovalRequest {
  return {
    request_id: 'req-1',
    session_id: 'sessionA',
    tool,
    op: 'click',
    summary: '点击窗口里的按钮',
    risk: 'input',
    sensitive: null,
    rememberable: false,
    grant: null,
  };
}

function setSubagentTimeline(events: Record<string, unknown>[], status: 'running' | 'completed'): void {
  useSubagentStore.setState({
    sessions: {
      sessionA: {
        order: ['sub-1'],
        descriptors: {
          'sub-1': { subagentId: 'sub-1', provider: 'claude', status, updatedAt: 0 },
        },
        events: { 'sub-1': events },
        seenEventIds: {},
      },
    },
  });
}

describe('useEmergencyStop 武装窗口(工单 10 跟进)', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    bridgeState.present = true;
    setComputerUse({ enabled: true, systemExecution: false });
    setRunning({});
    setTurns({});
    setApprovals({});
    useSubagentStore.setState({ sessions: {}, continuationPending: {} });
  });

  it('arms while a running turn has a pending computer-use call', async () => {
    setComputerUse({ enabled: true, systemExecution: true });
    setRunning({ sessionA: true });
    setTurns({ sessionA: runningTurns([
      userMessage('帮我看下这个窗口'),
      computerCall('call-1'),
    ]) });

    renderHook(() => useEmergencyStop());

    await waitFor(() => expect(setArmedMock).toHaveBeenCalledWith(true));
  });

  it('does not arm during a plain chat turn', async () => {
    setComputerUse({ enabled: true, systemExecution: true });
    setRunning({ sessionA: true });
    setTurns({ sessionA: runningTurns([
      userMessage('你好'),
      assistantText('你好，有什么可以帮你？'),
    ]) });

    renderHook(() => useEmergencyStop());

    await waitFor(() => expect(setArmedMock).toHaveBeenCalledWith(false));
    expect(setArmedMock).not.toHaveBeenCalledWith(true);
  });

  it('stays disarmed while idle, even with the switches on', async () => {
    setComputerUse({ enabled: true, systemExecution: true });
    setRunning({ sessionA: false });

    renderHook(() => useEmergencyStop());

    await waitFor(() => expect(setArmedMock).toHaveBeenCalledWith(false));
    expect(setArmedMock).not.toHaveBeenCalledWith(true);
  });

  it('never arms while system execution is off', async () => {
    setComputerUse({ enabled: true, systemExecution: false });
    setRunning({ sessionA: true });
    setTurns({ sessionA: runningTurns([
      userMessage('帮我看下这个窗口'),
      computerCall('call-1'),
    ]) });

    renderHook(() => useEmergencyStop());

    await waitFor(() => expect(setArmedMock).toHaveBeenCalledWith(false));
    expect(setArmedMock).not.toHaveBeenCalledWith(true);
  });

  it('never arms while the computer-use master switch is off', async () => {
    setComputerUse({ enabled: false, systemExecution: true });
    setRunning({ sessionA: true });
    setTurns({ sessionA: runningTurns([
      userMessage('帮我看下这个窗口'),
      computerCall('call-1'),
    ]) });

    renderHook(() => useEmergencyStop());

    await waitFor(() => expect(setArmedMock).toHaveBeenCalledWith(false));
    expect(setArmedMock).not.toHaveBeenCalledWith(true);
  });

  it('stays armed after the tool result lands (the operation is not over)', async () => {
    setComputerUse({ enabled: true, systemExecution: true });
    setRunning({ sessionA: true });
    const events = [userMessage('帮我看下这个窗口'), computerCall('call-1')];
    setTurns({ sessionA: runningTurns(events) });
    renderHook(() => useEmergencyStop());
    await waitFor(() => expect(setArmedMock).toHaveBeenCalledWith(true));

    setTurns({ sessionA: runningTurns([...events, toolResult('call-1')]) });
    await act(async () => { await Promise.resolve(); });

    // 工具结果回来 ≠ 操作结束:武装不该在这里解除(提示条会跟着常驻)。
    expect(setArmedMock.mock.calls.map(([armed]) => armed)).toEqual([true]);

    setRunning({ sessionA: false });

    await waitFor(() => expect(setArmedMock).toHaveBeenLastCalledWith(false));
  });

  it('stays armed across the thinking gap between two desktop steps', async () => {
    setComputerUse({ enabled: true, systemExecution: true });
    setRunning({ sessionA: true });
    setTurns({ sessionA: runningTurns([
      userMessage('打开记事本输入测试123'),
      computerCall('call-1'),
      toolResult('call-1'),
      assistantText('我再看一下窗口里的内容'),
    ]) });

    renderHook(() => useEmergencyStop());

    await waitFor(() => expect(setArmedMock).toHaveBeenCalledWith(true));
  });

  it('disarms as soon as the turn ends', async () => {
    setComputerUse({ enabled: true, systemExecution: true });
    setRunning({ sessionA: true });
    setTurns({ sessionA: runningTurns([
      userMessage('帮我看下这个窗口'),
      computerCall('call-1'),
    ]) });
    renderHook(() => useEmergencyStop());
    await waitFor(() => expect(setArmedMock).toHaveBeenCalledWith(true));

    setRunning({ sessionA: false });

    await waitFor(() => expect(setArmedMock).toHaveBeenLastCalledWith(false));
  });

  it('still arms for the pre-rename tool names in historical transcripts', async () => {
    setComputerUse({ enabled: true, systemExecution: true });
    setRunning({ sessionA: true });
    setTurns({ sessionA: runningTurns([
      userMessage('帮我看下这个窗口'),
      computerCall('call-1', 'mcp__codemux-browser__computer_click'),
    ]) });

    renderHook(() => useEmergencyStop());

    await waitFor(() => expect(setArmedMock).toHaveBeenCalledWith(true));
  });

  it('ignores pending browser tools (in-app browser is not desktop control)', async () => {
    setComputerUse({ enabled: true, systemExecution: true });
    setRunning({ sessionA: true });
    setTurns({ sessionA: runningTurns([
      userMessage('点一下页面'),
      computerCall('call-1', 'mcp__codemux-control__browser_click'),
    ]) });

    renderHook(() => useEmergencyStop());

    await waitFor(() => expect(setArmedMock).toHaveBeenCalledWith(false));
    expect(setArmedMock).not.toHaveBeenCalledWith(true);
  });

  it('arms while a computer-use approval is waiting', async () => {
    setComputerUse({ enabled: true, systemExecution: true });
    setRunning({ sessionA: true });
    setTurns({ sessionA: runningTurns([userMessage('帮我点一下')]) });
    setApprovals({ sessionA: [approval('computer_click')] });

    renderHook(() => useEmergencyStop());

    await waitFor(() => expect(setArmedMock).toHaveBeenCalledWith(true));
  });

  it('ignores pending browser approvals', async () => {
    setComputerUse({ enabled: true, systemExecution: true });
    setRunning({ sessionA: true });
    setTurns({ sessionA: runningTurns([userMessage('点一下页面')]) });
    setApprovals({ sessionA: [approval('browser_click')] });

    renderHook(() => useEmergencyStop());

    await waitFor(() => expect(setArmedMock).toHaveBeenCalledWith(false));
    expect(setArmedMock).not.toHaveBeenCalledWith(true);
  });

  it('arms while a subagent has a pending computer-use call', async () => {
    setComputerUse({ enabled: true, systemExecution: true });
    setRunning({ sessionA: true });
    setSubagentTimeline([
      { type: 'tool_started', tool_use_id: 'sub-1', name: 'mcp__codemux-control__computer_type', input: {} },
    ], 'running');

    renderHook(() => useEmergencyStop());

    await waitFor(() => expect(setArmedMock).toHaveBeenCalledWith(true));
  });

  it('ignores computer calls in finished subagent timelines', async () => {
    setComputerUse({ enabled: true, systemExecution: true });
    setRunning({ sessionA: true });
    setSubagentTimeline([
      { type: 'tool_started', tool_use_id: 'sub-1', name: 'mcp__codemux-control__computer_type', input: {} },
    ], 'completed');

    renderHook(() => useEmergencyStop());

    await waitFor(() => expect(setArmedMock).toHaveBeenCalledWith(false));
    expect(setArmedMock).not.toHaveBeenCalledWith(true);
  });

  it('stays armed while a subagent keeps running after its computer call finished', async () => {
    setComputerUse({ enabled: true, systemExecution: true });
    setRunning({ sessionA: true });
    setSubagentTimeline([
      { type: 'tool_started', tool_use_id: 'sub-1', name: 'mcp__codemux-control__computer_type', input: {} },
      { type: 'tool_finished', tool_use_id: 'sub-1', name: 'mcp__codemux-control__computer_type' },
    ], 'running');

    renderHook(() => useEmergencyStop());

    await waitFor(() => expect(setArmedMock).toHaveBeenCalledWith(true));
  });

  it('interrupts every running session when the shell reports the hotkey', async () => {
    const interrupt = vi.fn(async () => {});
    useAgentStore.setState({ interrupt } as never);
    setRunning({ sessionA: true, sessionB: false, sessionC: true });

    renderHook(() => useEmergencyStop());
    await waitFor(() => expect(onEmergencyStopMock).toHaveBeenCalled());

    const onStop = onEmergencyStopMock.mock.calls[0]?.[0] as (() => void) | undefined;
    onStop?.();

    expect(interrupt).toHaveBeenCalledTimes(2);
    expect(interrupt).toHaveBeenCalledWith('sessionA');
    expect(interrupt).toHaveBeenCalledWith('sessionC');
  });

  it('does nothing when the desktop bridge is missing (browser hosts)', () => {
    bridgeState.present = false;
    setComputerUse({ enabled: true, systemExecution: true });
    setRunning({ sessionA: true });

    expect(() => renderHook(() => useEmergencyStop())).not.toThrow();
    expect(setArmedMock).not.toHaveBeenCalled();
  });
});
