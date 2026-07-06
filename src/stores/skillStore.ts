import { create } from 'zustand';
import type { ImportableSkill, Skill, SkillApps } from '../types/skill';
import { skillApi } from '../lib/tauri';

interface SkillStore {
  installedSkills: Skill[];
  isLoading: boolean;
  error: string | null;

  fetchInstalled: () => Promise<void>;
  listImportable: () => Promise<ImportableSkill[]>;
  uninstallSkill: (id: string) => Promise<void>;
  toggleApp: (id: string, app: keyof SkillApps, enabled: boolean) => Promise<void>;
  importFromApps: (selected?: string[] | null) => Promise<number>;
  getSkillContent: (id: string) => Promise<string>;
  syncBuiltins: () => Promise<void>;
  registerFromDisk: (name: string) => Promise<void>;
}

export const useSkillStore = create<SkillStore>((set, get) => ({
  installedSkills: [],
  isLoading: false,
  error: null,

  fetchInstalled: async () => {
    set({ isLoading: true, error: null });
    try {
      const skills = await skillApi.listInstalled();
      set({ installedSkills: skills, isLoading: false });
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },

  listImportable: async () => {
    return skillApi.listImportable();
  },

  uninstallSkill: async (id: string) => {
    try {
      await skillApi.uninstall(id);
      set((state) => ({
        installedSkills: state.installedSkills.filter((s) => s.id !== id),
      }));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  toggleApp: async (id: string, app: keyof SkillApps, enabled: boolean) => {
    try {
      await skillApi.toggleApp(id, app, enabled);
      set((state) => ({
        installedSkills: state.installedSkills.map((s) =>
          s.id === id ? { ...s, apps: { ...s.apps, [app]: enabled } } : s
        ),
      }));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  importFromApps: async (selected?: string[] | null) => {
    try {
      const result = await skillApi.importFromApps(selected);
      if (result.total > 0) {
        await get().fetchInstalled();
      }
      return result.total;
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  getSkillContent: async (id: string) => {
    return skillApi.getContent(id);
  },

  syncBuiltins: async () => {
    try {
      await skillApi.syncBuiltins();
      await get().fetchInstalled();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  registerFromDisk: async (name: string) => {
    try {
      const skill = await skillApi.registerFromDisk(name);
      set((state) => {
        const exists = state.installedSkills.some((s) => s.id === skill.id);
        const installedSkills = exists
          ? state.installedSkills.map((s) => (s.id === skill.id ? skill : s))
          : [...state.installedSkills, skill];
        return { installedSkills };
      });
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },
}));
