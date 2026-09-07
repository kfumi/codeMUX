import { beforeEach, describe, expect, it } from 'vitest';

import { useNavigationStore, type NavigationLocation } from './navigationStore';

const home: NavigationLocation = {
  view: 'app',
  settingsTab: 'general',
  activeSessionId: null,
  activeProjectId: null,
  automationTaskId: null,
  draftProjectId: null,
  isDraftOpen: false,
  sidePanel: {
    scopeId: 'home',
    isOpen: false,
    activeTabId: null,
  },
};

function sessionLocation(sessionId: string): NavigationLocation {
  return {
    ...home,
    activeSessionId: sessionId,
    sidePanel: {
      scopeId: sessionId,
      isOpen: false,
      activeTabId: null,
    },
  };
}

describe('navigation store', () => {
  beforeEach(() => {
    useNavigationStore.getState().reset();
  });

  it('starts without back or forward history', () => {
    const state = useNavigationStore.getState();

    expect(state.current).toEqual(home);
    expect(state.backStack).toEqual([]);
    expect(state.forwardStack).toEqual([]);
  });

  it('navigates back and forward without duplicating history', () => {
    const store = useNavigationStore.getState();
    const sessionA = sessionLocation('session-a');
    const sessionB = sessionLocation('session-b');

    store.navigate(sessionA);
    store.navigate(sessionA);
    store.navigate(sessionB);

    expect(useNavigationStore.getState().backStack).toEqual([home, sessionA]);
    expect(store.goBack()).toEqual(sessionA);
    expect(useNavigationStore.getState().forwardStack).toEqual([sessionB]);
    expect(store.goForward()).toEqual(sessionB);
    expect(useNavigationStore.getState().backStack).toEqual([home, sessionA]);
  });

  it('clears forward history after a new navigation', () => {
    const store = useNavigationStore.getState();
    const sessionA = sessionLocation('session-a');
    const sessionB = sessionLocation('session-b');
    const sessionC = sessionLocation('session-c');

    store.navigate(sessionA);
    store.navigate(sessionB);
    store.goBack();
    store.navigate(sessionC);

    expect(useNavigationStore.getState().current).toEqual(sessionC);
    expect(useNavigationStore.getState().forwardStack).toEqual([]);
  });

  it('records side panel changes as locations', () => {
    const store = useNavigationStore.getState();

    store.recordSidePanelNavigation({
      scopeId: 'home',
      isOpen: true,
      activeTabId: 'home:review:project',
    });

    expect(useNavigationStore.getState().current.sidePanel).toEqual({
      scopeId: 'home',
      isOpen: true,
      activeTabId: 'home:review:project',
    });
    expect(useNavigationStore.getState().backStack).toHaveLength(1);
  });
});
