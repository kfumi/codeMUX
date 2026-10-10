import { useEffect } from 'react';

import {
  isComputerUseToolName,
  subagentTimelineHasComputerUse,
  turnHasComputerUseCall,
  turnIsWaitingOnTool,
} from '../lib/computerUseActivity';
import { desktopBridge } from '../lib/desktop-bridge';
import { createLogger } from '../lib/logger';
import { useAgentStore } from '../stores/agentStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useSubagentStore } from '../stores/subagentStore';

/**
 * 武装期间的心跳周期(工单 18)。
 *
 * 它**不**决定壳侧的超时:窗口被遮挡/最小化时,Chromium 会把渲染层的定时器压到分钟级
 * (见 `apps/desktop/src/main.ts` 里刻意保留默认节流的说明),壳侧看门狗因此取到分钟量级
 * (见 `apps/desktop/src/armed-heartbeat.ts` 的 `ARMED_HEARTBEAT_TIMEOUT_MS`),而不是
 * 「心跳周期的几倍」—— 那样会把还活着的渲染层判成失联。
 */
export const ARMED_HEARTBEAT_INTERVAL_MS = 5_000;

const logger = createLogger('EmergencyStop');

/**
 * 全局 Esc 强打断(工单 06/10;10 跟进再收窄)的渲染层三件事:
 *
 * 1. 按「电脑控制开启 + 系统级执行开着 + 有回合在跑 + **这个回合里出现过
 *    computer_* 调用**(含审批等待与子智能体时间线)」武装壳侧的全局 Esc。
 *    「有回合在跑」过于粗:开着系统级执行时,纯聊天回合也会整天占着 Esc,
 *    还弹出一条「正在控制这台电脑」的假提示(2026-10-08 用户实测)。急停要停的
 *    是真实驱动动作,所以判据必须有活动本身。
 * 2. 壳触发时打断所有在跑的回合:驱动已被 daemon 杀停,这里让模型与界面
 *    都知道「停下来了」。
 * 3. 提示条由壳跟随武装状态显示(见 shell-bridge):**武装多久就显示多久**,不再
 *    有壳侧定时收起(工单 15) —— 操作进行期间常驻,回合结束/解除武装才消失;
 *    但壳侧不再无条件相信这套计算:武装期间按固定周期发心跳(工单 18),壳侧看门狗
 *    收不到就自己收起提示条并解除 Esc(渲染层可能比提示条先死,那时它只会撒谎)。
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
  // 桌面活动:在跑会话的**当前回合**里出现过 computer_* 调用(工单 15 口径),
  // 或有电脑控制审批挂起。判据从「工具在飞」放宽到「本回合出现过」:模型在两次
  // 桌面动作之间思考时工具已经回来,但操作没有结束 —— 按 pending 判定会让提示条
  // 与 Esc 在过程里闪断(用户实测只闪 1 秒)。解除交给「会话不再跑」,外加
  // turnIsWaitingOnTool 挡住被中断旧回合里永不回来的调用。
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
        && turnHasComputerUseCall(lastTurn)
      ) {
        return true;
      }
    }
    return false;
  });
  // 子智能体也会操作桌面,其时间线在 subagentStore,不在父会话事件里 ——
  // 漏掉这段会让子智能体驱动期间没有急停可用。口径相同(时间线里出现过
  // computer_* 调用),子智能体跑完即解除。
  const subagentActivity = useSubagentStore((state) => {
    for (const session of Object.values(state.sessions)) {
      for (const subagentId of session.order) {
        if (session.descriptors[subagentId]?.status !== 'running') continue;
        const timeline = session.events[subagentId];
        if (timeline && subagentTimelineHasComputerUse(timeline)) return true;
      }
    }
    return false;
  });
  const shouldArm =
    computerUseEnabled
    && systemExecutionEnabled
    && anyTurnRunning
    && (desktopActivity || subagentActivity);

  // 壳侧看到的是「最近一次心跳」:渲染层卡死 / 进程没了 / WS 断链时,屏幕上会一直挂着
  // 「按 Esc 急停」而实际按不动 —— 那是骗人。武装期间按固定周期续期,壳侧看门狗收不到
  // 就自己收起提示条并解除 Esc;反过来,壳侧在渲染层仍认为自己该武装时报 false(看门狗
  // 刚收过、或注册失败过),这里重新声明一次,别让 Esc 与提示条就这么消失。
  useEffect(() => {
    if (!desktopBridge) return;
    const bridge = desktopBridge;
    let cancelled = false;
    let lastArmed: boolean | null = null;

    const assertArmed = async (armed: boolean): Promise<void> => {
      try {
        const effective = await bridge.setEmergencyStopArmed(armed);
        if (!cancelled) lastArmed = effective;
      } catch (error) {
        logger.warn('Failed to sync emergency stop arming', { armed }, error as Error);
      }
    };

    void assertArmed(shouldArm);
    if (!shouldArm) return;

    const heartbeat = bridge.emergencyStopHeartbeat;
    if (typeof heartbeat !== 'function') {
      // 旧壳(preload 未升级)没有心跳通道:退回「只在武装状态变化时同步」的老行为,
      // 此时提示条没有壳侧兜底,但也不该整个武装流程失败。
      return;
    }
    const timer = setInterval(() => {
      void (async () => {
        try {
          const armed = await heartbeat();
          if (cancelled) return;
          const wasArmed = lastArmed;
          lastArmed = armed;
          if (!armed && wasArmed === true) {
            logger.warn('Shell disarmed the emergency stop after missed heartbeats; re-asserting');
            await assertArmed(true);
          }
        } catch (error) {
          logger.warn('Emergency stop heartbeat failed', {}, error as Error);
        }
      })();
    }, ARMED_HEARTBEAT_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
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
