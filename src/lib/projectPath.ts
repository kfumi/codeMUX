import type { Project } from '../types/project';
import { getPrimaryProjectRoot } from '../types/project';

/**
 * 项目 id → 项目主根路径。
 *
 * 摘要面板的环境信息缓存按这个路径键控，因此「面板取缓存」与「回合结束刷新」
 * 两处必须用同一个解析（App 的 `sidePanelProjectPath` 也走这里），否则键会
 * 不一致而让刷新静默落空。刻意不 trim：与面板传入的路径保持逐字一致。
 *
 * 多根项目只把主根交给 Git / worktree / 终端：这些能力这一版不跨根。
 */
export function resolveProjectPath(
  projectId: string | null | undefined,
  projects: Project[],
): string | null {
  if (!projectId) return null;
  return getPrimaryProjectRoot(projects.find((project) => project.id === projectId));
}
