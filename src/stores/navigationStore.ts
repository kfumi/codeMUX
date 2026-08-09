import { create } from 'zustand';

import type { SettingsTab } from '../components/settings/SettingsDialog';

export interface NavigationLocation {
  view: 'app' | 'settings';
  settingsTab: SettingsTab;
  activeSessionId: string | null;
  activeProjectId: string | null;
  draftProjectId: string | null;
  isDraftOpen: boolean;
  sidePanel: {
    scopeId: string;
    isOpen: boolean;
    activeTabId: string | null;
  };
}

export interface SidePanelNavigationState {
  scopeId: string;
  isOpen: boolean;
  activeTabId: string | null;
}

interface NavigationState {
  current: NavigationLocation;
  backStack: NavigationLocation[];
  forwardStack: NavigationLocation[];
  isRestoring: boolean;
  navigate: (location: NavigationLocation) => void;
  recordSidePanelNavigation: (sidePanel: SidePanelNavigationState) => void;
  goBack: () => NavigationLocation | null;
  goForward: () => NavigationLocation | null;
  setRestoring: (isRestoring: boolean) => void;
  reset: () => void;
}

const initialLocation: NavigationLocation = {
  view: 'app',
  settingsTab: 'general',
  activeSessionId: null,
  activeProjectId: null,
  draftProjectId: null,
  isDraftOpen: false,
  sidePanel: {
    scopeId: 'home',
    isOpen: false,
    activeTabId: null,
  },
};

function areLocationsEqual(left: NavigationLocation, right: NavigationLocation): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export const useNavigationStore = create<NavigationState>((set, get) => ({
  current: initialLocation,
  backStack: [],
  forwardStack: [],
  isRestoring: false,

  navigate: (location) => {
    set((state) => {
      if (areLocationsEqual(state.current, location)) return state;

      return {
        current: location,
        backStack: [...state.backStack, state.current],
        forwardStack: [],
      };
    });
  },

  recordSidePanelNavigation: (sidePanel) => {
    set((state) => {
      const location = {
        ...state.current,
        sidePanel,
      };

      if (areLocationsEqual(state.current, location)) return state;

      return {
        current: location,
        backStack: [...state.backStack, state.current],
        forwardStack: [],
      };
    });
  },

  goBack: () => {
    const state = get();
    const previous = state.backStack.at(-1);
    if (!previous) return null;

    set({
      current: previous,
      backStack: state.backStack.slice(0, -1),
      forwardStack: [state.current, ...state.forwardStack],
    });
    return previous;
  },

  goForward: () => {
    const state = get();
    const next = state.forwardStack[0];
    if (!next) return null;

    set({
      current: next,
      backStack: [...state.backStack, state.current],
      forwardStack: state.forwardStack.slice(1),
    });
    return next;
  },

  setRestoring: (isRestoring) => set({ isRestoring }),

  reset: () => set({
    current: initialLocation,
    backStack: [],
    forwardStack: [],
    isRestoring: false,
  }),
}));
