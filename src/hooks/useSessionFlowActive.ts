import { useAgentStore } from '../stores/agentStore';
import { useSubagentStore } from '../stores/subagentStore';
import { useWorkTaskStore } from '../stores/workTaskStore';
import type { WorkTaskStatus } from '../types/workTask';

/** 看板任务仍在跑的状态:启动中 / 执行中 / 合并中都算「进行中」。 */
const ACTIVE_WORK_TASK_STATUSES: ReadonlySet<WorkTaskStatus> = new Set([
  'queued',
  'preparing',
  'running',
  'merging',
]);

/**
 * 用户视角下的"会话仍在进行":父回合运行中,后台子智能体流未收尾
 * (有 running 的子智能体,或刚全部结束、等待父进程汇总回合),
 * 或该会话绑定的看板任务仍在跑。
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
  // 看板启动的任务:会话由 daemon 侧创建、渲染端从未 startQuery,agent 事件流
  // 也没订阅,isRunning 永远是 false——只靠它会让新会话一出现就落成「未读」绿点。
  // 改以任务状态为准,执行中显示「进行中」(黄),执行完(含 done/失败)才回落到未读。
  const taskActive = useWorkTaskStore((state) => state.tasks.some(
    (task) => task.sessionId === sessionId
      && !task.archivedAt
      && ACTIVE_WORK_TASK_STATUSES.has(task.status),
  ));
  return isRunning || flowBusy || taskActive;
}
