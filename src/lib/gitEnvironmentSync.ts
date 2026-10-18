/**
 * 环境信息快照的「回合结束」再同步。
 *
 * 摘要面板的环境信息是缓存值，不会跟着组件挂载走。智能体在一个回合里改动文件后，
 * 需要把这份缓存对账更新。这里订阅 agent store 的 `isRunning` 由 true→false 边沿
 * （回合结束，含后台回合的兜底收尾），解析该会话所属项目并刷新它的缓存。
 *
 * 只在项目已有缓存时才刷新——从未打开过摘要的项目不因回合结束凭空取数。
 * 刻意不做实时更新（回合进行中不刷新），也不引入 TTL / 手动刷新。
 * 见 docs/specs/2026-10-18-git-environment-snapshot-cache.md。
 */
import { useAgentStore } from '../stores/agentStore';
import { useGitEnvironmentStore } from '../stores/gitEnvironmentStore';
import { useProjectStore } from '../stores/projectStore';
import { useSessionStore } from '../stores/sessionStore';
import { resolveProjectPath } from './projectPath';

/** 会话所属项目的工作路径（摘要面板按项目路径键控环境信息）。 */
export function resolveProjectPathForSession(sessionId: string): string | null {
  const { sessions, archivedSessions } = useSessionStore.getState();
  const session = sessions.find((entry) => entry.id === sessionId)
    ?? archivedSessions.find((entry) => entry.id === sessionId);
  return resolveProjectPath(session?.project_id, useProjectStore.getState().projects);
}

function refreshSettledSession(sessionId: string): void {
  const projectPath = resolveProjectPathForSession(sessionId);
  if (!projectPath) return;
  const store = useGitEnvironmentStore.getState();
  if (!store.hasEntry(projectPath)) return;
  void store.refresh(projectPath);
}

export function initGitEnvironmentTurnSync(): () => void {
  let lastIsRunning = useAgentStore.getState().isRunning;
  return useAgentStore.subscribe((state) => {
    if (state.isRunning === lastIsRunning) return;
    const previous = lastIsRunning;
    const current = state.isRunning;
    lastIsRunning = current;
    const sessionIds = new Set([...Object.keys(previous), ...Object.keys(current)]);
    for (const sessionId of sessionIds) {
      if (previous[sessionId] === true && current[sessionId] !== true) {
        refreshSettledSession(sessionId);
      }
    }
  });
}
