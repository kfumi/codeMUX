import {
  deriveWorktreeBranchName,
  getDraftWorktreePath,
  resolveWorktreeBaseRef,
  type DraftWorkspaceSelection,
} from './draftWorkspacePicker';
import { requireDesktopBridge } from './desktop-bridge';
import { daemonFacade } from './facades/daemon-facade';
import type { AgentMessage } from '../stores/agentStore';
import type { Project } from '../types/project';
import type { Session } from '../types/session';

export const DEFAULT_AGENT_CWD = '.';
export const DEFAULT_NON_PROJECT_FOLDER = 'CodemuxProject';

function joinPathSegments(base: string, segment: string): string {
  const separator = base.includes('\\') ? '\\' : '/';
  const trimmedBase = base.replace(/[/\\]+$/, '');
  return `${trimmedBase}${separator}${segment}`;
}

export function isDefaultWorkingDirectoryRequest(cwd: string | null | undefined): boolean {
  const normalized = cwd?.trim();
  return !normalized || normalized === DEFAULT_AGENT_CWD;
}

export function resolveDefaultWorkingDirectory(homeDir: string): string {
  return joinPathSegments(homeDir, DEFAULT_NON_PROJECT_FOLDER);
}

export function normalizeSessionWorkingDirectory(cwd: string, homeDir: string): string {
  if (isDefaultWorkingDirectoryRequest(cwd)) {
    return resolveDefaultWorkingDirectory(homeDir);
  }
  return cwd.trim();
}

export async function ensureDraftSessionWorkingPath(cwd: string): Promise<string> {
  if (!isDefaultWorkingDirectoryRequest(cwd)) {
    return cwd.trim();
  }
  const homeDir = await requireDesktopBridge().getUserHomeDirectory();
  return resolveDefaultWorkingDirectory(homeDir);
}

export function isValidWorkingPath(path: string | null | undefined): path is string {
  const trimmed = path?.trim();
  if (!trimmed || trimmed === DEFAULT_AGENT_CWD || trimmed === '..') {
    return false;
  }

  return (
    /^[a-zA-Z]:[/\\]/.test(trimmed)
    || trimmed.startsWith('\\\\')
    || trimmed.startsWith('/')
  );
}

export function getStoredAgentCwd(
  storage: Pick<Storage, 'getItem'> | null | undefined = globalThis.localStorage,
): string {
  return storage?.getItem('agent-user-cwd') || DEFAULT_AGENT_CWD;
}

function getBoundProjectPath(
  session: Pick<Session, 'project_id'>,
  projects: Project[],
): string | null {
  if (!session.project_id) {
    return null;
  }
  return projects.find((entry) => entry.id === session.project_id)?.path?.trim() ?? null;
}

function isDistinctWorkingPath(
  candidate: string | null | undefined,
  projectPath: string | null,
): candidate is string {
  const trimmed = candidate?.trim();
  if (!trimmed) {
    return false;
  }
  if (!projectPath) {
    return true;
  }
  return trimmed !== projectPath;
}

export function resolveSessionCwd(
  projects: Project[],
  draftProjectId: string | null | undefined,
  fallbackCwd: string,
  draftWorkspace?: DraftWorkspaceSelection,
): string {
  const draftWorktreePath = draftWorkspace ? getDraftWorktreePath(draftWorkspace) : null;
  if (draftWorktreePath) {
    return draftWorktreePath;
  }

  if (draftProjectId) {
    const project = projects.find((entry) => entry.id === draftProjectId);
    if (project?.path) {
      return project.path;
    }
  }

  return fallbackCwd;
}

export function resolveDraftProjectPath(
  projects: Project[],
  draftProjectId: string | null | undefined,
  draftWorkspace?: DraftWorkspaceSelection,
): string | null {
  const draftWorktreePath = draftWorkspace ? getDraftWorktreePath(draftWorkspace) : null;
  if (draftWorktreePath) {
    return draftWorktreePath;
  }
  if (!draftProjectId) {
    return null;
  }
  return projects.find((entry) => entry.id === draftProjectId)?.path ?? null;
}

export function extractSessionWorkingPathFromEvents(events: AgentMessage[]): string | null {
  let latest: string | null = null;

  for (const event of events) {
    if (event.kind === 'system' && event.data.subtype === 'init') {
      const cwd = event.data.cwd?.trim();
      if (cwd) {
        latest = cwd;
      }
      continue;
    }

    if (event.kind === 'raw' && event.data && typeof event.data === 'object') {
      const raw = event.data as Record<string, unknown>;
      const payload = raw.payload;
      if (payload && typeof payload === 'object' && 'cwd' in payload) {
        const cwd = String((payload as { cwd?: unknown }).cwd ?? '').trim();
        if (cwd) {
          latest = cwd;
        }
      }
    }
  }

  return latest;
}

export function resolveSessionWorkingPath(
  session: Pick<Session, 'id' | 'project_id' | 'working_path'>,
  projects: Project[],
  options?: {
    events?: AgentMessage[];
    rememberedPath?: string | null;
  },
): string | null {
  const projectPath = getBoundProjectPath(session, projects);

  const fromSession = session.working_path?.trim();
  if (isValidWorkingPath(fromSession)) {
    return fromSession;
  }

  const remembered = options?.rememberedPath?.trim();
  if (isValidWorkingPath(remembered) && isDistinctWorkingPath(remembered, projectPath)) {
    return remembered;
  }

  const fromEvents = options?.events
    ? extractSessionWorkingPathFromEvents(options.events)
    : null;
  if (isValidWorkingPath(fromEvents) && isDistinctWorkingPath(fromEvents, projectPath)) {
    return fromEvents;
  }

  if (isValidWorkingPath(fromEvents)) {
    return fromEvents;
  }

  if (isValidWorkingPath(projectPath)) {
    return projectPath;
  }

  if (!session.project_id) {
    const stored = getStoredAgentCwd();
    return isValidWorkingPath(stored) ? stored : null;
  }

  return null;
}

export async function resolveDraftSessionCwd(
  projects: Project[],
  draftProjectId: string | null | undefined,
  fallbackCwd: string,
  draftWorkspace: DraftWorkspaceSelection,
): Promise<string> {
  if (draftWorkspace.kind === 'existing') {
    return draftWorkspace.worktreePath;
  }

  if (draftWorkspace.kind === 'worktree' && !draftProjectId) {
    throw new Error('请先选择项目后再使用 Worktree 模式');
  }

  if (draftWorkspace.kind !== 'worktree' || !draftProjectId) {
    return resolveSessionCwd(projects, draftProjectId, fallbackCwd, draftWorkspace);
  }

  const project = projects.find((entry) => entry.id === draftProjectId);
  if (!project?.path) {
    return fallbackCwd;
  }

  const repositoryState = await daemonFacade.git.getRepositoryState(project.path);
  const baseRef = resolveWorktreeBaseRef(draftWorkspace.baseRef, repositoryState);
  const branchName = deriveWorktreeBranchName();
  const created = await daemonFacade.git.createWorktree(project.path, branchName, baseRef);
  return created.path;
}
