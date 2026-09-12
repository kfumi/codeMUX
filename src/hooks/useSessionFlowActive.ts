import { useAgentStore } from '../stores/agentStore';
import { useSubagentStore } from '../stores/subagentStore';

/**
 * 用户视角下的"会话仍在进行":父回合运行中,或后台子智能体流未收尾
 * (有 running 的子智能体,或刚全部结束、等待父进程汇总回合)。
 * 侧栏 loading、停止按钮等 UI 状态都应以该语义为准——父回合结束不代表
 * 会话结束。
 */
export function useSessionFlowActive(sessionId: string): boolean {
  const isRunning = useAgentStore((state) => state.isRunning[sessionId] ?? false);
  const flowBusy = useSubagentStore((state) => {
    const session = state.sessions[sessionId];
    if (session?.order.some((id) => session.descriptors[id]?.status === 'running')) {
      return true;
    }
    return state.continuationPending[sessionId] ?? false;
  });
  return isRunning || flowBusy;
}
