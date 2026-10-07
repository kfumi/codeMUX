import { useEffect } from 'react';

import { desktopBridge } from '../lib/desktop-bridge';
import { createLogger } from '../lib/logger';
import { useAgentStore } from '../stores/agentStore';
import { useSettingsStore } from '../stores/settingsStore';

const logger = createLogger('EmergencyStop');

/**
 * 全局 Esc 强打断(工单 06)的渲染层两件事:
 *
 * 1. 按配置武装/解除壳侧的全局 Esc —— 只在「系统级执行」开启期间武装,
 *    避免平时抢走所有应用的 Esc;
 * 2. 壳触发时打断所有在跑的回合:驱动已被 daemon 杀停,这里让模型与界面
 *    都知道「停下来了」。
 */
export function useEmergencyStop(): void {
  const systemExecutionEnabled = useSettingsStore(
    (state) => state.config?.computer_use?.system_execution_enabled ?? false,
  );

  useEffect(() => {
    if (!desktopBridge) return;
    void Promise.resolve(desktopBridge.setEmergencyStopArmed(systemExecutionEnabled)).catch((error) => {
      logger.warn('Failed to sync emergency stop arming', { systemExecutionEnabled }, error as Error);
    });
  }, [systemExecutionEnabled]);

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
