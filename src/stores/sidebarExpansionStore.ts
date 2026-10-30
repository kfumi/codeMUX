import { create } from 'zustand';

import {
  INITIAL_VISIBLE_PROJECT_SESSIONS,
  nextVisibleProjectSessionLimit,
  type SidebarExpansionState,
} from '../lib/sidebarProjection';

const STORAGE_KEY = 'codemux-sidebar-expansion';

/** 旧的三处键：首次加载时迁进新快照，之后只写一个键。 */
const LEGACY_SECTION_KEYS = {
  pinnedExpanded: 'codemux-pinned-section-expanded',
  projectsExpanded: 'codemux-projects-section-expanded',
  conversationsExpanded: 'codemux-conversations-section-expanded',
} as const;
const LEGACY_COLLAPSED_KEY = 'codemux-collapsed-projects';

type SectionKey = keyof typeof LEGACY_SECTION_KEYS;

interface SidebarExpansionActions {
  toggleSection: (section: SectionKey) => void;
  setSectionExpanded: (section: SectionKey, expanded: boolean) => void;
  toggleProject: (projectId: string) => void;
  setProjectExpanded: (projectId: string, expanded: boolean) => void;
  setAllProjectsExpanded: (expanded: boolean, projectIds: readonly string[]) => void;
  showMoreProjectSessions: (projectId: string, total: number) => void;
  collapseProjectSessions: (projectId: string) => void;
}

export type SidebarExpansionStore = SidebarExpansionState & SidebarExpansionActions;

function readBoolean(key: string): boolean {
  try {
    return localStorage.getItem(key) !== 'false';
  } catch {
    return true;
  }
}

function readLegacyCollapsed(): string[] {
  try {
    const raw = localStorage.getItem(LEGACY_COLLAPSED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function loadState(): SidebarExpansionState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<{
        pinnedExpanded: boolean;
        projectsExpanded: boolean;
        conversationsExpanded: boolean;
        collapsedProjects: string[];
        visibleSessionLimits: Record<string, number>;
      }>;
      return {
        pinnedExpanded: parsed.pinnedExpanded !== false,
        projectsExpanded: parsed.projectsExpanded !== false,
        conversationsExpanded: parsed.conversationsExpanded !== false,
        collapsedProjects: new Set(
          Array.isArray(parsed.collapsedProjects) ? parsed.collapsedProjects : [],
        ),
        visibleSessionLimits:
          parsed.visibleSessionLimits && typeof parsed.visibleSessionLimits === 'object'
            ? parsed.visibleSessionLimits
            : {},
      };
    }
  } catch {
    // 损坏的快照按默认值处理。
  }

  const migrated: SidebarExpansionState = {
    pinnedExpanded: readBoolean(LEGACY_SECTION_KEYS.pinnedExpanded),
    projectsExpanded: readBoolean(LEGACY_SECTION_KEYS.projectsExpanded),
    conversationsExpanded: readBoolean(LEGACY_SECTION_KEYS.conversationsExpanded),
    collapsedProjects: new Set(readLegacyCollapsed()),
    visibleSessionLimits: {},
  };
  persist(migrated);
  return migrated;
}

function persist(state: SidebarExpansionState): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        pinnedExpanded: state.pinnedExpanded,
        projectsExpanded: state.projectsExpanded,
        conversationsExpanded: state.conversationsExpanded,
        collapsedProjects: [...state.collapsedProjects],
        visibleSessionLimits: state.visibleSessionLimits,
      }),
    );
  } catch {
    // 存储不可用时保持内存状态。
  }
}

function snapshot(state: SidebarExpansionStore): SidebarExpansionState {
  return {
    pinnedExpanded: state.pinnedExpanded,
    projectsExpanded: state.projectsExpanded,
    conversationsExpanded: state.conversationsExpanded,
    collapsedProjects: state.collapsedProjects,
    visibleSessionLimits: state.visibleSessionLimits,
  };
}

export const useSidebarExpansionStore = create<SidebarExpansionStore>((set, get) => ({
  ...loadState(),
  toggleSection: (section) => {
    set((state) => {
      const next = { ...snapshot(state), [section]: !state[section] };
      persist(next);
      return { [section]: next[section] };
    });
  },
  setSectionExpanded: (section, expanded) => {
    set((state) => {
      const next = { ...snapshot(state), [section]: expanded };
      persist(next);
      return { [section]: expanded };
    });
  },
  toggleProject: (projectId) => {
    const collapsed = new Set(get().collapsedProjects);
    if (collapsed.has(projectId)) {
      collapsed.delete(projectId);
    } else {
      collapsed.add(projectId);
    }
    const next = { ...snapshot(get()), collapsedProjects: collapsed };
    persist(next);
    set({ collapsedProjects: collapsed });
  },
  setProjectExpanded: (projectId, expanded) => {
    const collapsed = new Set(get().collapsedProjects);
    if (expanded) {
      collapsed.delete(projectId);
    } else {
      collapsed.add(projectId);
    }
    const next = { ...snapshot(get()), collapsedProjects: collapsed };
    persist(next);
    set({ collapsedProjects: collapsed });
  },
  setAllProjectsExpanded: (expanded, projectIds) => {
    // 展开时清空整张表；收起时只收当前列表里的项目。
    const collapsed = expanded ? new Set<string>() : new Set(projectIds);
    const next = { ...snapshot(get()), collapsedProjects: collapsed };
    persist(next);
    set({ collapsedProjects: collapsed });
  },
  showMoreProjectSessions: (projectId, total) => {
    const state = get();
    const current = state.visibleSessionLimits[projectId]
      ?? INITIAL_VISIBLE_PROJECT_SESSIONS;
    const visibleSessionLimits = {
      ...state.visibleSessionLimits,
      [projectId]: nextVisibleProjectSessionLimit(current, total),
    };
    persist({ ...snapshot(state), visibleSessionLimits });
    set({ visibleSessionLimits });
  },
  collapseProjectSessions: (projectId) => {
    const state = get();
    const visibleSessionLimits = {
      ...state.visibleSessionLimits,
      [projectId]: INITIAL_VISIBLE_PROJECT_SESSIONS,
    };
    persist({ ...snapshot(state), visibleSessionLimits });
    set({ visibleSessionLimits });
  },
}));
