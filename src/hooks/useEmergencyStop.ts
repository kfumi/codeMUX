import { useEffect } from 'react';

import { desktopBridge } from '../lib/desktop-bridge';
import { createLogger } from '../lib/logger';
import { useAgentStore } from '../stores/agentStore';

const logger = createLogger('EmergencyStop');

/**
 * 全局 Esc 急停的渲染层半边(工单 06/10;工单 04 起只剩这一件事)。
 *
 * 武装窗口与提示条显隐曾在这里计算(工单 10/15/18 的口径:系统级执行开着 + 有回合在跑 +
 * 这个回合里出现过 `computer_*` 调用)。工单 03 把真值搬进 daemon、工单 04 删掉渲染层这条
 * 路径:现在「这台机器正在被驱动」由 daemon 的活动事件说了算,壳据此武装全局 Esc 并显示
 * 提示条(见 `apps/desktop/src/computer-use-arming.ts`)。渲染层算不出来的场景才是常态
 * —— 没人开界面、渲染层从没加载、浏览器/手机客户端在用。
 *
 * 剩下的一件(下面这个 effect):壳按 Esc 后,若走的是**旧 daemon 的兜底路径**(它没有
 * `/api/computer-use/estop`,只能杀驱动子进程),渲染层收到 `emergency-stop` 事件后把在跑
 * 的回合打断 —— 机器停了,模型与界面也要知道。新 daemon 由 daemon 自己打断(驱动 + 限时
 * 授权 + 有活动的回合),这条通知不会发出。
 */
export function useEmergencyStop(): void {
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
