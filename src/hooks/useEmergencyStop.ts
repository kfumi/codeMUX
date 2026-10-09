import { useEffect } from 'react';

import {
  isComputerUseToolName,
  subagentTimelineHasPendingComputerUse,
  turnHasPendingComputerUseCall,
  turnIsWaitingOnTool,
} from '../lib/computerUseActivity';
import { desktopBridge } from '../lib/desktop-bridge';
import { createLogger } from '../lib/logger';
import { useAgentStore } from '../stores/agentStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useSubagentStore } from '../stores/subagentStore';

const logger = createLogger('EmergencyStop');

/**
 * 全局 Esc 强打断(工单 06/10;10 跟进再收窄)的渲染层三件事:
 *
 * 1. 按「电脑控制开启 + 系统级执行开着 + 有回合在跑 + **真的有 computer_*
 *    工具在飞**(含审批等待与子智能体时间线)」武装壳侧的全局 Esc。
 *    「有回合在跑」过于粗:开着系统级执行时,纯聊天回合也会整天占着 Esc,
 *    还弹出一条「正在控制这台电脑」的假提示(2026-10-08 用户实测)。急停要停的
 *    是真实驱动动作,所以判据必须有活动本身。
 * 2. 壳触发时打断所有在跑的回合:驱动已被 daemon 杀停,这里让模型与界面
 *    都知道「停下来了」。
 * 3. 提示条由壳跟随武装状态显示(见 shell-bridge),自动收起由壳侧负责。
 */
export function useEmergencyStop(): void {
  const computerUseEnabled = useSettingsStore(
    (state) => state.config?.computer_use?.enabled ?? false,
  );
  const systemExecutionEnabled = useSettingsStore(
    (state) => state.config?.computer_use?.system_execution_enabled ?? false,
  );
  const anyTurnRunning = useAgentStore((state) =>
    Object.values(state.isRunning).some(Boolean),
  );
  // 桌面活动:在跑会话里有 computer_* 工具在飞(工具调用已发出、结果未回,
  // 覆盖审批等待与驱动执行),或有电脑控制审批挂起。
  const desktopActivity = useAgentStore((state) => {
    for (const [sessionId, running] of Object.entries(state.isRunning)) {
      if (!running) continue;
      const approvals = state.pendingComputerUseApprovals[sessionId] ?? [];
      if (approvals.some((request) => isComputerUseToolName(request.tool))) return true;
      const turns = state.turns[sessionId] ?? [];
      const lastTurn = turns[turns.length - 1];
      if (
        lastTurn
        && turnIsWaitingOnTool(lastTurn)
        && turnHasPendingComputerUseCall(lastTurn)
      ) {
        return true;
      }
    }
    return false;
  });
  // 子智能体也会操作桌面,其时间线在 subagentStore,不在父会话事件里 ——
  // 漏掉这段会让子智能体驱动期间没有急停可用。
  const subagentActivity = useSubagentStore((state) => {
    for (const session of Object.values(state.sessions)) {
      for (const subagentId of session.order) {
        if (session.descriptors[subagentId]?.status !== 'running') continue;
        const timeline = session.events[subagentId];
        if (timeline && subagentTimelineHasPendingComputerUse(timeline)) return true;
      }
    }
    return false;
  });
  const shouldArm =
    computerUseEnabled
    && systemExecutionEnabled
    && anyTurnRunning
    && (desktopActivity || subagentActivity);

  useEffect(() => {
    if (!desktopBridge) return;
    void Promise.resolve(desktopBridge.setEmergencyStopArmed(shouldArm)).catch((error) => {
      logger.warn('Failed to sync emergency stop arming', { shouldArm }, error as Error);
    });
  }, [shouldArm]);

  useEffect(() => {
    if (!desktopBridge) return;
    return desktopBridge.onEmergencyStop(() => {
      const state = useAgentStore.getState();
      const running = Object.entries(state.isRunning)
        .filter(([, active]) => active)
        .map(([sessionId]) => sessionId);
      logger.warn('Emergency stop received from shell', { sessions: running.length });
      for (const sessionId of running) {
        void state.interrupt(sessionId);
      }
    });
  }, []);
}
