// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSidebarExpansionStore } from './sidebarExpansionStore';

const STORAGE_KEY = 'codemux-sidebar-expansion';

function resetStore(): void {
  useSidebarExpansionStore.setState({
    pinnedExpanded: true,
    projectsExpanded: true,
    conversationsExpanded: true,
    collapsedProjects: new Set<string>(),
    visibleSessionLimits: {},
  });
}

function persisted(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>;
}

describe('sidebarExpansionStore', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it('toggles the three section flags independently and persists one snapshot', () => {
    const store = useSidebarExpansionStore.getState();

    store.toggleSection('projectsExpanded');
    useSidebarExpansionStore.getState().toggleSection('conversationsExpanded');

    const state = useSidebarExpansionStore.getState();
    expect(state.pinnedExpanded).toBe(true);
    expect(state.projectsExpanded).toBe(false);
    expect(state.conversationsExpanded).toBe(false);
    expect(persisted()).toMatchObject({
      pinnedExpanded: true,
      projectsExpanded: false,
      conversationsExpanded: false,
    });
  });

  it('collapses one project and expands/collapses all with the current ids', () => {
    useSidebarExpansionStore.getState().toggleProject('p1');
    expect(useSidebarExpansionStore.getState().collapsedProjects).toEqual(new Set(['p1']));

    useSidebarExpansionStore.getState().setAllProjectsExpanded(false, ['p1', 'p2']);
    expect(useSidebarExpansionStore.getState().collapsedProjects).toEqual(new Set(['p1', 'p2']));

    useSidebarExpansionStore.getState().setAllProjectsExpanded(true, ['p1', 'p2']);
    expect(useSidebarExpansionStore.getState().collapsedProjects.size).toBe(0);
  });

  it('pages project sessions from 5 to 15, then by 10, and collapses back to 5', () => {
    useSidebarExpansionStore.getState().showMoreProjectSessions('p1', 100);
    expect(useSidebarExpansionStore.getState().visibleSessionLimits.p1).toBe(15);

    useSidebarExpansionStore.getState().showMoreProjectSessions('p1', 100);
    expect(useSidebarExpansionStore.getState().visibleSessionLimits.p1).toBe(25);

    useSidebarExpansionStore.getState().showMoreProjectSessions('p1', 28);
    expect(useSidebarExpansionStore.getState().visibleSessionLimits.p1).toBe(28);

    useSidebarExpansionStore.getState().collapseProjectSessions('p1');
    expect(useSidebarExpansionStore.getState().visibleSessionLimits.p1).toBe(5);
  });

  it('migrates the three legacy keys into the one snapshot on first load', async () => {
    localStorage.clear();
    localStorage.setItem('codemux-pinned-section-expanded', 'false');
    localStorage.setItem('codemux-projects-section-expanded', 'false');
    localStorage.setItem('codemux-conversations-section-expanded', 'true');
    localStorage.setItem('codemux-collapsed-projects', JSON.stringify(['legacy-project']));

    vi.resetModules();
    const { useSidebarExpansionStore: freshStore } = await import('./sidebarExpansionStore');

    const state = freshStore.getState();
    expect(state.pinnedExpanded).toBe(false);
    expect(state.projectsExpanded).toBe(false);
    expect(state.conversationsExpanded).toBe(true);
    expect(state.collapsedProjects).toEqual(new Set(['legacy-project']));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({
      pinnedExpanded: false,
      projectsExpanded: false,
      collapsedProjects: ['legacy-project'],
    });
  });
});
