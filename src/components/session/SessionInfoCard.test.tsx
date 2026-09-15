// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const branchState = vi.hoisted(() => ({ value: null as string | null }));

vi.mock('../../hooks/useRepoBranch', () => ({
  useRepoBranch: () => ({ branch: branchState.value, loading: false }),
}));

import { SessionInfoCard } from './SessionInfoCard';
import type { Session } from '../../types/session';

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 'session-1',
    title: '排查思考消息随文本输出后消失的问题',
    agent_kind: 'opencode',
    provider_id: null,
    model: 'glm-5.3-flash',
    reasoning_effort: null,
    mode: 'agent',
    permission_config: null,
    plan_mode: null,
    project_id: null,
    is_archived: false,
    is_pinned: false,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

describe('SessionInfoCard', () => {
  afterEach(() => {
    cleanup();
    branchState.value = null;
  });

  it('shows the title, agent/model, branch and working path', () => {
    branchState.value = 'feature/hover-card';

    render(
      <SessionInfoCard
        session={makeSession({})}
        workingPath="D:/project/my-project/codeMUX"
      />,
    );

    expect(screen.getByText('排查思考消息随文本输出后消失的问题')).toBeTruthy();
    expect(screen.getByText('OpenCode · glm-5.3-flash')).toBeTruthy();
    expect(screen.getByText('feature/hover-card')).toBeTruthy();
    expect(screen.getByText('D:/project/my-project/codeMUX')).toBeTruthy();
  });

  it('hides the branch row when the path is not a repository', () => {
    branchState.value = null;

    render(
      <SessionInfoCard session={makeSession({})} workingPath="D:/project/my-project/codeMUX" />,
    );

    expect(screen.queryByText('feature/hover-card')).toBeNull();
    expect(screen.getByText('D:/project/my-project/codeMUX')).toBeTruthy();
  });

  it('renders only the header when no path or branch is available', () => {
    branchState.value = null;

    render(<SessionInfoCard session={makeSession({ model: null })} workingPath={null} />);

    expect(screen.getByText('排查思考消息随文本输出后消失的问题')).toBeTruthy();
    expect(screen.getByText('OpenCode')).toBeTruthy();
  });
});
