// @vitest-environment jsdom
// 全局 Esc 急停的武装窗口(工单 10 及其跟进,口径见工单 15):只在「系统级执行开启 +
// 有回合在跑 + 这个回合里出现过 computer_* 调用」时武装 —— 纯聊天回合不该武装,更不
// 该弹提示条;而一旦进入桌面操作过程,提示条随武装状态常驻到回合结束(不再 1s 收起)。
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeState = vi.hoisted(() => ({ present: true, heartbeat: true }));
/**
 * 把武装 effect 里的 async 链跑到底:setEmergencyStopArmed / heartbeat 都是 Promise,
 * fake timers 不影响微任务,所以这里只推进 Promise 队列。
 */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 5; tick += 1) {
      await Promise.resolve();
    }
  });
}

const { setArmedMock, heartbeatMock, onEmergencyStopMock, unsubscribeMock } = vi.hoisted(() => ({
  setArmedMock: vi.fn(async (armed: boolean) => armed),
  heartbeatMock: vi.fn(async () => true),
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
        ? {
            setEmergencyStopArmed: setArmedMock,
            emergencyStopHeartbeat: bridgeState.heartbeat ? heartbeatMock : undefined,
            onEmergencyStop: onEmergencyStopMock,
          }
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
import { ARMED_HEARTBEAT_INTERVAL_MS, useEmergencyStop } from './useEmergencyStop';

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
    // clearAllMocks 只清调用记录、保留实现:显式恢复默认实现,免得上一个用例留下的
    // mockResolvedValue(false) 悄悄带进来(那些用例就不再跑真实返回值分支了)。
    setArmedMock.mockImplementation(async (armed: boolean) => armed);
    heartbeatMock.mockResolvedValue(true);
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

describe('useEmergencyStop 心跳兜底(工单 18)', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    setArmedMock.mockImplementation(async (armed: boolean) => armed);
    heartbeatMock.mockResolvedValue(true);
    bridgeState.present = true;
    bridgeState.heartbeat = true;
    setComputerUse({ enabled: true, systemExecution: true });
    setApprovals({});
    useSubagentStore.setState({ sessions: {}, continuationPending: {} });
    setRunning({ sessionA: true });
    setTurns({ sessionA: runningTurns([
      userMessage('帮我看下这个窗口'),
      computerCall('call-1'),
    ]) });
  });

  it('keeps the shell watchdog alive while armed', async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useEmergencyStop());
      await flushMicrotasks();

      await act(async () => { vi.advanceTimersByTime(ARMED_HEARTBEAT_INTERVAL_MS); });
      expect(heartbeatMock).toHaveBeenCalledTimes(1);

      await act(async () => { vi.advanceTimersByTime(ARMED_HEARTBEAT_INTERVAL_MS); });
      expect(heartbeatMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops heartbeating once the turn ends', async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useEmergencyStop());
      await flushMicrotasks();
      await act(async () => { vi.advanceTimersByTime(ARMED_HEARTBEAT_INTERVAL_MS); });
      expect(heartbeatMock).toHaveBeenCalledTimes(1);

      await act(async () => { setRunning({ sessionA: false }); });
      await flushMicrotasks();
      expect(setArmedMock).toHaveBeenLastCalledWith(false);

      await act(async () => { vi.advanceTimersByTime(10 * ARMED_HEARTBEAT_INTERVAL_MS); });
      expect(heartbeatMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-asserts the arming when the shell reports it was disarmed', async () => {
    // 渲染层卡顿到心跳丢失 → 壳侧看门狗已解除武装并收起提示条;卡顿恢复后必须重新声明,
    // 否则桌面还在被驱动,而 Esc 与提示条已经消失。
    heartbeatMock.mockResolvedValueOnce(true).mockResolvedValue(false);
    vi.useFakeTimers();
    try {
      renderHook(() => useEmergencyStop());
      await flushMicrotasks();

      await act(async () => { vi.advanceTimersByTime(ARMED_HEARTBEAT_INTERVAL_MS); });
      expect(setArmedMock).toHaveBeenCalledTimes(1);

      await act(async () => { vi.advanceTimersByTime(ARMED_HEARTBEAT_INTERVAL_MS); });
      await flushMicrotasks();

      expect(setArmedMock).toHaveBeenCalledTimes(2);
      expect(setArmedMock).toHaveBeenLastCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fight the shell when the arming never took effect', async () => {
    // 键被别的程序占着:每次心跳都回 false,但从未真正武装过 —— 不该每 5s 重试一次注册。
    setArmedMock.mockResolvedValue(false);
    heartbeatMock.mockResolvedValue(false);
    vi.useFakeTimers();
    try {
      renderHook(() => useEmergencyStop());
      await flushMicrotasks();

      await act(async () => { vi.advanceTimersByTime(10 * ARMED_HEARTBEAT_INTERVAL_MS); });
      await flushMicrotasks();

      expect(setArmedMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still arms when the shell predates the heartbeat channel', async () => {
    bridgeState.heartbeat = false;
    renderHook(() => useEmergencyStop());
    await flushMicrotasks();

    expect(setArmedMock).toHaveBeenCalledWith(true);
    expect(heartbeatMock).not.toHaveBeenCalled();
  });
});
});
