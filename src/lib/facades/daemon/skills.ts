import type { AgentKind } from '../../../types/session';
import type { ImportableSkill, ProjectSkill, Skill } from '../../../types/skill';
import { ensureDaemonClient } from './lifecycle';

/** 技能安装、同步与按项目解析。 */
export const skills = {
  listInstalled: async () => (await ensureDaemonClient()).skillsList() as Promise<Skill[]>,
  listImportable: async () =>
    (await ensureDaemonClient()).skillsListImportable() as Promise<ImportableSkill[]>,
  uninstall: async (id: string) => (await ensureDaemonClient()).skillsUninstall(id),
  toggleApp: async (skillId: string, app: string, enabled: boolean) => {
    await (await ensureDaemonClient()).skillsToggleApp(skillId, app, enabled);
  },
  getContent: async (id: string) => (await ensureDaemonClient()).skillsGetContent(id),
  syncBuiltins: async () => (await ensureDaemonClient()).skillsSync() as Promise<Skill[]>,
  registerFromDisk: async (name: string) =>
    (await ensureDaemonClient()).skillsRegister(name) as Promise<Skill>,
  importFromApps: async (selected?: string[] | null) =>
    (await ensureDaemonClient()).skillsImport(selected),
  listProject: async (projectRoot: string, agentKind: AgentKind, force = false) =>
    (await ensureDaemonClient()).skillsListProject(projectRoot, agentKind, force) as Promise<
      ProjectSkill[]
    >,
};

export type SkillsDomain = typeof skills;
