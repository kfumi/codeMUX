import type { Project } from '../types/project';

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
