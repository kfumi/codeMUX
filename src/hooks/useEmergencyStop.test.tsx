// @vitest-environment jsdom
// 全局 Esc 急停的武装窗口(工单 10 及其跟进):只在「系统级执行开启 + 有回合在跑 +
// 真的有 computer_* 工具在飞」时武装 —— 纯聊天回合不该武装,更不该弹提示条。
import { cleanup, renderHook, waitFor } from '@testing-library/react';
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

function computerCall(id: string, name = 'mcp__codemux-browser__computer_click'): AgentMessage {
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

  it('disarms again as soon as the computer call settles', async () => {
    setComputerUse({ enabled: true, systemExecution: true });
    setRunning({ sessionA: true });
    const events = [userMessage('帮我看下这个窗口'), computerCall('call-1')];
    setTurns({ sessionA: runningTurns(events) });
    renderHook(() => useEmergencyStop());
    await waitFor(() => expect(setArmedMock).toHaveBeenCalledWith(true));

    setTurns({ sessionA: runningTurns([...events, toolResult('call-1')]) });

    await waitFor(() => expect(setArmedMock).toHaveBeenLastCalledWith(false));
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

  it('ignores pending browser tools (in-app browser is not desktop control)', async () => {
    setComputerUse({ enabled: true, systemExecution: true });
    setRunning({ sessionA: true });
    setTurns({ sessionA: runningTurns([
      userMessage('点一下页面'),
      computerCall('call-1', 'mcp__codemux-browser__browser_click'),
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
      { type: 'tool_started', tool_use_id: 'sub-1', name: 'mcp__codemux-browser__computer_type', input: {} },
    ], 'running');

    renderHook(() => useEmergencyStop());

    await waitFor(() => expect(setArmedMock).toHaveBeenCalledWith(true));
  });

  it('ignores computer calls in finished subagent timelines', async () => {
    setComputerUse({ enabled: true, systemExecution: true });
    setRunning({ sessionA: true });
    setSubagentTimeline([
      { type: 'tool_started', tool_use_id: 'sub-1', name: 'mcp__codemux-browser__computer_type', input: {} },
    ], 'completed');

    renderHook(() => useEmergencyStop());

    await waitFor(() => expect(setArmedMock).toHaveBeenCalledWith(false));
    expect(setArmedMock).not.toHaveBeenCalledWith(true);
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
