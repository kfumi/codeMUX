import { create } from 'zustand';

import { daemonFacade } from '@/lib/facades/daemon-facade';
import type { AgentKind } from '@/types/session';
import type { ProjectSkill } from '@/types/skill';

const CACHE_TTL_MS = 10_000;

export interface ProjectSkillEntry {
  skills: ProjectSkill[];
  isLoading: boolean;
  error: string | null;
  loadedAt: number;
}

interface ProjectSkillState {
  entries: Record<string, ProjectSkillEntry>;
  load: (projectRoot: string | null | undefined, agentKind: AgentKind, force?: boolean) => Promise<void>;
  invalidate: (projectRoot?: string | null, agentKind?: AgentKind) => void;
}

const inFlight = new Map<string, Promise<void>>();

export function projectSkillCacheKey(projectRoot: string, agentKind: AgentKind): string {
  return `${projectRoot}\u0000${agentKind}`;
}

export const useProjectSkillStore = create<ProjectSkillState>((set, get) => ({
  entries: {},

  load: async (projectRoot, agentKind, force = false) => {
    const root = projectRoot?.trim();
    if (!root) return;

    const key = projectSkillCacheKey(root, agentKind);
    const cached = get().entries[key];
    if (!force && cached && !cached.isLoading && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
      return;
    }

    const existing = inFlight.get(key);
    if (existing) {
      await existing;
      return;
    }

    set((state) => ({
      entries: {
        ...state.entries,
        [key]: {
          skills: cached?.skills ?? [],
          isLoading: true,
          error: null,
          loadedAt: cached?.loadedAt ?? 0,
        },
      },
    }));

    const request = daemonFacade.skills.listProject(root, agentKind, force)
      .then((skills) => {
        set((state) => ({
          entries: {
            ...state.entries,
            [key]: {
              skills,
              isLoading: false,
              error: null,
              loadedAt: Date.now(),
            },
          },
        }));
      })
      .catch((error) => {
        set((state) => ({
          entries: {
            ...state.entries,
            [key]: {
              skills: cached?.skills ?? [],
              isLoading: false,
              error: String(error),
              loadedAt: cached?.loadedAt ?? 0,
            },
          },
        }));
      })
      .finally(() => {
        inFlight.delete(key);
      });

    inFlight.set(key, request);
    await request;
  },

  invalidate: (projectRoot, agentKind) => {
    if (!projectRoot) {
      set({ entries: {} });
      return;
    }

    set((state) => {
      const entries = { ...state.entries };
      if (agentKind) {
        delete entries[projectSkillCacheKey(projectRoot, agentKind)];
      } else {
        for (const key of Object.keys(entries)) {
          if (key.startsWith(`${projectRoot}\u0000`)) {
            delete entries[key];
          }
        }
      }
      return { entries };
    });
  },
}));
