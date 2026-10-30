import type { Project } from '../types/project';
import type { Session } from '../types/session';

/** 侧栏每个项目默认显示的会话数。 */
export const INITIAL_VISIBLE_PROJECT_SESSIONS = 5;
/** 首次「展开显示」一次放到 15 条。 */
export const FIRST_EXPANDED_PROJECT_SESSIONS = 15;
/** 之后每次再放 10 条。 */
export const PROJECT_SESSION_EXPAND_STEP = 10;

/**
 * 侧栏的全部展开意图。
 *
 * 分区展开、项目折叠与每项目分页曾经是三套独立状态机(两处 localStorage +
 * 组件内 state)；现在只有这一份快照,持久化由 sidebarExpansionStore 独占。
 */
export interface SidebarExpansionState {
  pinnedExpanded: boolean;
  projectsExpanded: boolean;
  conversationsExpanded: boolean;
  collapsedProjects: ReadonlySet<string>;
  visibleSessionLimits: Readonly<Record<string, number>>;
}

export interface ProjectSidebarSection {
  project: Project;
  /** 该项目下未置顶的全部会话(按 store 顺序)。 */
  sessions: Session[];
  /** 按当前分页意图截出的可见行。 */
  visibleSessions: Session[];
  /** 未置顶会话数；用于「暂无对话」与分页判断。 */
  totalSessions: number;
  /** 含归档会话的项目会话数；用于删除确认文案。 */
  sessionCount: number;
  hasHiddenSessions: boolean;
  canCollapseSessions: boolean;
  expanded: boolean;
}

export interface SidebarProjection {
  sections: Pick<
    SidebarExpansionState,
    'pinnedExpanded' | 'projectsExpanded' | 'conversationsExpanded'
  >;
  pinnedSessions: Session[];
  ungroupedSessions: Session[];
  projects: ProjectSidebarSection[];
  allProjectsExpanded: boolean;
}

/** 侧栏一行属于哪个分区：置顶优先，其次项目，最后无项目对话。 */
export function sidebarSessionBucket(
  session: Pick<Session, 'is_pinned' | 'project_id'>,
): 'pinned' | 'ungrouped' | string {
  if (session.is_pinned) return 'pinned';
  return session.project_id ?? 'ungrouped';
}

/** 下一档可见条数；上限是该项目实际会话数。 */
export function nextVisibleProjectSessionLimit(
  current: number,
  total: number,
): number {
  const next = current <= INITIAL_VISIBLE_PROJECT_SESSIONS
    ? FIRST_EXPANDED_PROJECT_SESSIONS
    : current + PROJECT_SESSION_EXPAND_STEP;
  return Math.min(next, total);
}

/**
 * 一次算出侧栏的三块视图：置顶、项目分组(含可见行与计数)、无项目对话。
 *
 * 纯函数；组件只渲染，不再各自过滤 `project_id`/`is_pinned`。
 */
export function buildSidebarProjection(
  sessions: readonly Session[],
  archivedSessions: readonly Session[],
  projects: readonly Project[],
  expansion: SidebarExpansionState,
): SidebarProjection {
  const pinnedSessions: Session[] = [];
  const ungroupedSessions: Session[] = [];
  const byProject = new Map<string, Session[]>();

  for (const session of sessions) {
    const bucket = sidebarSessionBucket(session);
    if (bucket === 'pinned') {
      pinnedSessions.push(session);
    } else if (bucket === 'ungrouped') {
      ungroupedSessions.push(session);
    } else {
      const list = byProject.get(bucket);
      if (list) {
        list.push(session);
      } else {
        byProject.set(bucket, [session]);
      }
    }
  }

  const sessionCounts = new Map<string, number>();
  for (const session of [...sessions, ...archivedSessions]) {
    if (!session.project_id) continue;
    sessionCounts.set(session.project_id, (sessionCounts.get(session.project_id) ?? 0) + 1);
  }

  const projectSections = projects.map((project): ProjectSidebarSection => {
    const projectSessions = byProject.get(project.id) ?? [];
    const limit = expansion.visibleSessionLimits[project.id]
      ?? INITIAL_VISIBLE_PROJECT_SESSIONS;
    const visibleSessions = projectSessions.slice(0, limit);
    return {
      project,
      sessions: projectSessions,
      visibleSessions,
      totalSessions: projectSessions.length,
      sessionCount: sessionCounts.get(project.id) ?? 0,
      hasHiddenSessions: visibleSessions.length < projectSessions.length,
      canCollapseSessions:
        projectSessions.length > INITIAL_VISIBLE_PROJECT_SESSIONS
        && limit > INITIAL_VISIBLE_PROJECT_SESSIONS,
      expanded: !expansion.collapsedProjects.has(project.id),
    };
  });

  return {
    sections: {
      pinnedExpanded: expansion.pinnedExpanded,
      projectsExpanded: expansion.projectsExpanded,
      conversationsExpanded: expansion.conversationsExpanded,
    },
    pinnedSessions,
    ungroupedSessions,
    projects: projectSections,
    allProjectsExpanded: projects.every(
      (project) => !expansion.collapsedProjects.has(project.id),
    ),
  };
}
