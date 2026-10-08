import { useEffect } from 'react';

import { desktopBridge } from '../lib/desktop-bridge';
import { createLogger } from '../lib/logger';
import { useAgentStore } from '../stores/agentStore';
import { useSettingsStore } from '../stores/settingsStore';

const logger = createLogger('EmergencyStop');

/**
 * 全局 Esc 强打断(工单 06/10)的渲染层三件事:
 *
 * 1. 按「有回合在跑 **且** 系统级执行开着」武装壳侧的全局 Esc。
 *    这个窗口是刻意收窄的:开着系统级执行开关就整天占着 Esc,等于替所有软件
 *    决定 Esc 归谁(游戏、vim、Excel、浏览器全都会失灵);而急停要停的就是
 *    正在跑的回合,空闲时 Esc 必须还给系统和别的应用。
 * 2. 壳触发时打断所有在跑的回合:驱动已被 daemon 杀停,这里让模型与界面
 *    都知道「停下来了」。
 * 3. 提示条由壳跟随武装状态显示(见 shell-bridge),渲染层不需要单独管。
 */
export function useEmergencyStop(): void {
  const systemExecutionEnabled = useSettingsStore(
    (state) => state.config?.computer_use?.system_execution_enabled ?? false,
  );
  const anyTurnRunning = useAgentStore((state) =>
    Object.values(state.isRunning).some(Boolean),
  );
  const shouldArm = systemExecutionEnabled && anyTurnRunning;

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
