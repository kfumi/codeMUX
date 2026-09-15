// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const branchState = vi.hoisted(() => ({
  value: null as string | null,
  queriedPaths: [] as Array<string | null | undefined>,
}));

vi.mock('../../hooks/useRepoBranch', () => ({
  useRepoBranch: (path: string | null | undefined) => {
    branchState.queriedPaths.push(path);
    return { branch: path ? branchState.value : null, loading: false };
  },
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
    branchState.queriedPaths = [];
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

  it('prefers the stored start branch and skips the live Git lookup', () => {
    branchState.value = 'someone-else-checked-this-out';

    render(
      <SessionInfoCard
        session={makeSession({ git_branch: 'feature/hover-card' })}
        workingPath="D:/project/my-project/codeMUX"
      />,
    );

    expect(screen.getByText('feature/hover-card')).toBeTruthy();
    expect(screen.queryByText('someone-else-checked-this-out')).toBeNull();
    // 传 null 给 hook 表示不发起实时查询。
    expect(branchState.queriedPaths.at(-1)).toBeNull();
  });

  it('falls back to the live lookup for sessions without a stored branch', () => {
    branchState.value = 'feature/live';

    render(
      <SessionInfoCard
        session={makeSession({ git_branch: null })}
        workingPath="D:/project/my-project/codeMUX"
      />,
    );

    expect(screen.getByText('feature/live')).toBeTruthy();
    expect(branchState.queriedPaths.at(-1)).toBe('D:/project/my-project/codeMUX');
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
