// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../types/session';

// 静态导入:如果在 it() 内 await import,首次模块图加载会计入测试超时(15s)。
import { ArchivedSessionsPanel } from './ArchivedSessionsPanel';

const unarchiveSession = vi.fn();
const deleteSession = vi.fn();
const fetchArchivedSessions = vi.fn();
const fetchProjects = vi.fn();

const archivedSessions: Session[] = [
  {
    id: 'session-claude',
    title: '研究下这个项目：https://github.com/Che...',
    agent_kind: 'claude_code',
    provider_id: null,
    model: null,
    reasoning_effort: null,
    mode: null,
    permission_config: null,
    plan_mode: null,
    project_id: 'project-1',
    created_at: '2026-08-14T10:00:00.000Z',
    updated_at: '2026-08-14T11:00:00.000Z',
    is_archived: true,
    is_pinned: false,
  },
  {
    id: 'session-codex',
    title: 'Codex 归档会话',
    agent_kind: 'codex',
    provider_id: null,
    model: null,
    reasoning_effort: null,
    mode: null,
    permission_config: null,
    plan_mode: null,
    project_id: 'project-2',
    created_at: '2026-08-14T09:00:00.000Z',
    updated_at: '2026-08-14T09:30:00.000Z',
    is_archived: true,
    is_pinned: false,
  },
];

const updateSessionTitle = vi.fn();

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      archivedSessions,
      fetchArchivedSessions,
      unarchiveSession,
      deleteSession,
      updateSessionTitle,
    }),
}));

vi.mock('../../stores/projectStore', () => ({
  useProjectStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      projects: [
        { id: 'project-1', name: 'Alpha' },
        { id: 'project-2', name: 'Beta' },
      ],
      fetchProjects,
    }),
}));

vi.mock('../../lib/sessionTitle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/sessionTitle')>();
  return {
    ...actual,
    resolveSessionTitle: vi.fn(async (_sessionId: string, _agentKind: string, storedTitle: string) =>
      storedTitle.endsWith('...')
        ? '研究下这个项目：https://github.com/CherryHQ/cherry-studio'
        : actual.getSessionDisplayTitle(storedTitle),
    ),
  };
});

describe('ArchivedSessionsPanel', () => {
  beforeEach(() => {
    unarchiveSession.mockClear();
    deleteSession.mockClear();
    fetchArchivedSessions.mockClear();
    fetchProjects.mockClear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('filters archived sessions by agent and resolves legacy titles before truncating', async () => {
    render(<ArchivedSessionsPanel />);

    expect(fetchArchivedSessions).toHaveBeenCalled();
    expect(fetchProjects).toHaveBeenCalled();
    expect(await screen.findByText('2 个对话')).toBeTruthy();
    expect(screen.getByText('Claude Code')).toBeTruthy();
    expect(screen.getByText('Codex')).toBeTruthy();

    const longTitle = '研究下这个项目：https://github.com/CherryHQ/cherry-studio';
    const titleElement = await screen.findByText(longTitle);
    expect(titleElement.className).toContain('truncate');
    expect(titleElement.getAttribute('title')).toBe(longTitle);
    expect(updateSessionTitle).toHaveBeenCalledWith('session-claude', longTitle);

    fireEvent.click(screen.getAllByRole('combobox')[0]);
    fireEvent.click(screen.getByRole('option', { name: 'Codex' }));
    expect(screen.getByText('1 个对话')).toBeTruthy();
    expect(screen.getByText('Codex 归档会话')).toBeTruthy();
    expect(screen.queryByText(longTitle)).toBeNull();
  });
});
