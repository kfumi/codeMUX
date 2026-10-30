import { describe, expect, it } from 'vitest';

import {
  FIRST_EXPANDED_PROJECT_SESSIONS,
  INITIAL_VISIBLE_PROJECT_SESSIONS,
  buildSidebarProjection,
  nextVisibleProjectSessionLimit,
  sidebarSessionBucket,
  type SidebarExpansionState,
} from './sidebarProjection';
import type { Project } from '../types/project';
import type { Session } from '../types/session';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: 'Session',
    agent_kind: 'claude_code',
    provider_id: null,
    model: null,
    reasoning_effort: null,
    mode: null,
    permission_config: null,
    plan_mode: null,
    project_id: null,
    working_path: null,
    created_at: '',
    updated_at: '',
    is_archived: false,
    is_pinned: false,
    ...overrides,
  };
}

function project(id: string, name = id): Project {
  return {
    id,
    name,
    roots: [{ path: `D:/work/${id}`, position: 0, isPrimary: true }],
    created_at: '',
    updated_at: '',
  };
}

function expansion(overrides: Partial<SidebarExpansionState> = {}): SidebarExpansionState {
  return {
    pinnedExpanded: true,
    projectsExpanded: true,
    conversationsExpanded: true,
    collapsedProjects: new Set<string>(),
    visibleSessionLimits: {},
    ...overrides,
  };
}

describe('sidebarSessionBucket', () => {
  it('gives pinned sessions priority over their project', () => {
    expect(sidebarSessionBucket({ is_pinned: true, project_id: 'p1' })).toBe('pinned');
    expect(sidebarSessionBucket({ is_pinned: false, project_id: 'p1' })).toBe('p1');
    expect(sidebarSessionBucket({ is_pinned: false, project_id: null })).toBe('ungrouped');
  });
});

describe('buildSidebarProjection', () => {
  const pinned = session({ id: 'pinned', is_pinned: true, project_id: 'p1' });
  const ungrouped = session({ id: 'loose' });
  const projectSessions = Array.from({ length: 8 }, (_, index) => session({
    id: `p1-${index}`,
    project_id: 'p1',
    updated_at: String(index),
  }));
  const archived = [
    session({ id: 'archived-1', project_id: 'p1', is_archived: true, is_pinned: true }),
    session({ id: 'archived-2', project_id: 'p1', is_archived: true }),
  ];

  it('splits pinned, project and ungrouped sessions once', () => {
    const result = buildSidebarProjection(
      [pinned, ungrouped, ...projectSessions],
      archived,
      [project('p1', 'Demo')],
      expansion(),
    );

    expect(result.pinnedSessions.map((entry) => entry.id)).toEqual(['pinned']);
    expect(result.ungroupedSessions.map((entry) => entry.id)).toEqual(['loose']);
    expect(result.projects[0].sessions).toHaveLength(8);
    expect(result.projects[0].visibleSessions).toHaveLength(INITIAL_VISIBLE_PROJECT_SESSIONS);
    expect(result.projects[0].hasHiddenSessions).toBe(true);
    expect(result.projects[0].sessionCount).toBe(11);
  });

  it('drops pinned sessions out of the project group', () => {
    const result = buildSidebarProjection(
      [pinned, ...projectSessions],
      [],
      [project('p1')],
      expansion(),
    );

    expect(result.projects[0].sessions.some((entry) => entry.id === 'pinned')).toBe(false);
  });

  it('uses the persisted per-project visible limit and clamps to the group size', () => {
    const bigGroup = Array.from({ length: 30 }, (_, index) => session({
      id: `big-${index}`,
      project_id: 'p1',
    }));
    const result = buildSidebarProjection(
      bigGroup,
      [],
      [project('p1')],
      expansion({ visibleSessionLimits: { p1: FIRST_EXPANDED_PROJECT_SESSIONS } }),
    );

    expect(result.projects[0].visibleSessions).toHaveLength(FIRST_EXPANDED_PROJECT_SESSIONS);
    expect(result.projects[0].canCollapseSessions).toBe(true);
    expect(result.projects[0].hasHiddenSessions).toBe(true);

    const clamped = buildSidebarProjection(
      projectSessions,
      [],
      [project('p1')],
      expansion({ visibleSessionLimits: { p1: 100 } }),
    );
    expect(clamped.projects[0].visibleSessions).toHaveLength(8);
    expect(clamped.projects[0].hasHiddenSessions).toBe(false);
  });

  it('reports collapse and section expansion from the single expansion snapshot', () => {
    const result = buildSidebarProjection(
      projectSessions,
      [],
      [project('p1')],
      expansion({
        projectsExpanded: false,
        conversationsExpanded: false,
        collapsedProjects: new Set(['p1']),
      }),
    );

    expect(result.sections.projectsExpanded).toBe(false);
    expect(result.sections.conversationsExpanded).toBe(false);
    expect(result.projects[0].expanded).toBe(false);
    expect(result.allProjectsExpanded).toBe(false);
  });
});

describe('nextVisibleProjectSessionLimit', () => {
  it('jumps from the initial 5 to 15, then steps by 10 and clamps to the total', () => {
    expect(nextVisibleProjectSessionLimit(5, 100)).toBe(15);
    expect(nextVisibleProjectSessionLimit(15, 100)).toBe(25);
    expect(nextVisibleProjectSessionLimit(25, 28)).toBe(28);
  });
});
