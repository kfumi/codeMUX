import { create } from 'zustand';
import type { Skill } from '../types/skill';
import { skillApi } from '../lib/tauri';

interface SkillStore {
  installedSkills: Skill[];
  isLoading: boolean;
  error: string | null;

  fetchInstalled: () => Promise<void>;
  uninstallSkill: (id: string) => Promise<void>;
  toggleSkill: (id: string, enabled: boolean) => Promise<void>;
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

  toggleSkill: async (id: string, enabled: boolean) => {
    try {
      await skillApi.toggle(id, enabled);
      set((state) => ({
        installedSkills: state.installedSkills.map((s) =>
          s.id === id ? { ...s, enabled } : s
        ),
      }));
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
