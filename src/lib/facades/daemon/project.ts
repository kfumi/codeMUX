import type { Project } from '../../../types/project';
import { ensureDaemonClient } from './lifecycle';

/** 项目(多根)生命周期与排序。 */
export const project = {
  list: async (): Promise<Project[]> => {
    const client = await ensureDaemonClient();
    return client.listProjects() as Promise<Project[]>;
  },
  create: async (name: string, roots: string[], primaryRoot?: string): Promise<Project> => {
    const client = await ensureDaemonClient();
    return client.createProject(name, roots, primaryRoot) as Promise<Project>;
  },
  delete: async (projectId: string): Promise<void> => {
    await (await ensureDaemonClient()).deleteProject(projectId);
  },
  rename: async (projectId: string, name: string): Promise<void> => {
    await (await ensureDaemonClient()).renameProject(projectId, name);
  },
  update: async (
    projectId: string,
    patch: { name?: string; roots?: string[]; primaryRoot?: string },
  ): Promise<Project> => {
    const client = await ensureDaemonClient();
    return client.updateProject(projectId, patch) as Promise<Project>;
  },
  reorder: async (ids: string[]): Promise<void> => {
    await (await ensureDaemonClient()).reorderProjects(ids);
  },
};

export type ProjectDomain = typeof project;
