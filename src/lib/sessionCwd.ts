import type { Project } from '../types/project';

export const DEFAULT_AGENT_CWD = '.';

export function getStoredAgentCwd(
  storage: Pick<Storage, 'getItem'> | null | undefined = globalThis.localStorage,
): string {
  return storage?.getItem('agent-user-cwd') || DEFAULT_AGENT_CWD;
}

export function resolveSessionCwd(
  projects: Project[],
  draftProjectId: string | null | undefined,
  fallbackCwd: string,
): string {
  if (draftProjectId) {
    const project = projects.find((entry) => entry.id === draftProjectId);
    if (project?.path) {
      return project.path;
    }
  }

  return fallbackCwd;
}
