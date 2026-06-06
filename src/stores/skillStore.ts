import { create } from 'zustand';
import type { Skill, RepoSkillEntry, SkillSource } from '../types/skill';
import { skillApi } from '../lib/tauri';

interface SkillStore {
  installedSkills: Skill[];
  browseResults: RepoSkillEntry[];
  skillSources: SkillSource[];
  isLoading: boolean;
  browseLoading: boolean;
  error: string | null;

  fetchInstalled: () => Promise<void>;
  browseRepo: (repo: string, branch?: string, path?: string) => Promise<void>;
  installSkill: (repo: string, branch: string, path: string, name: string) => Promise<void>;
  uninstallSkill: (id: string) => Promise<void>;
  toggleSkill: (id: string, enabled: boolean) => Promise<void>;
  getSkillContent: (id: string) => Promise<string>;
  syncBuiltins: () => Promise<void>;
  fetchSources: () => Promise<void>;
  registerFromDisk: (name: string) => Promise<void>;
}

export const useSkillStore = create<SkillStore>((set, get) => ({
  installedSkills: [],
  browseResults: [],
  skillSources: [],
  isLoading: false,
  browseLoading: false,
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

  browseRepo: async (repo: string, branch?: string, path?: string) => {
    set({ browseLoading: true, error: null });
    try {
      const results = await skillApi.browseRepo(repo, branch, path);
      set({ browseResults: results, browseLoading: false });
    } catch (error) {
      set({ error: String(error), browseLoading: false });
    }
  },

  installSkill: async (repo: string, branch: string, path: string, name: string) => {
    try {
      const skill = await skillApi.install(repo, branch, path, name);
      set((state) => {
        const exists = state.installedSkills.some((s) => s.id === skill.id);
        const installedSkills = exists
          ? state.installedSkills.map((s) => (s.id === skill.id ? skill : s))
          : [...state.installedSkills, skill];
        const browseResults = state.browseResults.map((r) =>
          r.name === name ? { ...r, installed: true } : r
        );
        return { installedSkills, browseResults };
      });
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  uninstallSkill: async (id: string) => {
    try {
      await skillApi.uninstall(id);
      set((state) => {
        const skill = state.installedSkills.find((s) => s.id === id);
        const installedSkills = state.installedSkills.filter((s) => s.id !== id);
        const browseResults = skill
          ? state.browseResults.map((r) =>
              r.name === skill.name ? { ...r, installed: false } : r
            )
          : state.browseResults;
        return { installedSkills, browseResults };
      });
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

  fetchSources: async () => {
    try {
      const sources = await skillApi.getSources();
      set({ skillSources: sources });
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
