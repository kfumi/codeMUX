// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openInExplorerMock = vi.hoisted(() => vi.fn(async () => undefined));
const narrowState = vi.hoisted(() => ({ value: false }));
const hostCaps = vi.hoisted(() => ({ hasExplorer: true }));

vi.mock('../../lib/facades/shell-facade', () => ({
  shellFacade: {
    openInExplorer: openInExplorerMock,
  },
}));

vi.mock('../../hooks/useIsNarrowViewport', () => ({
  useIsNarrowViewport: () => narrowState.value,
}));

vi.mock('../../hooks/useHostCapabilities', () => ({
  useHostCapabilities: () => ({
    has: (id: string) => (id === 'shell.explorer' ? hostCaps.hasExplorer : true),
  }),
}));

import { SessionItem } from './SessionItem';
import { useAgentStore } from '../../stores/agentStore';
import type { Session } from '../../types/session';

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 'session-1',
    title: 'Codex Session',
    agent_kind: 'codex',
    provider_id: null,
    model: null,
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

describe('SessionItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(() => {});
    narrowState.value = false;
    hostCaps.hasExplorer = true;
    useAgentStore.setState({
      events: {},
      pendingPermissions: {},
      isRunning: {},
      error: {},
      sessionWorkingPaths: {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps the session title visible for Codex sessions', () => {
    render(
      <SessionItem
        session={makeSession({ id: 'session-1', title: 'Codex Session', agent_kind: 'codex' })}
        isActive={false}
        onClick={vi.fn()}
        onTogglePinned={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
      />,
    );

    expect(screen.getByText('Codex Session')).toBeTruthy();
    expect(screen.queryByText('Codex')).toBeNull();
  });

  it('keeps the session title visible for Claude Code sessions', () => {
    render(
      <SessionItem
        session={makeSession({ id: 'session-2', title: 'Claude Session', agent_kind: 'claude_code' })}
        isActive={false}
        onClick={vi.fn()}
        onTogglePinned={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
      />,
    );

    expect(screen.getByText('Claude Session')).toBeTruthy();
    expect(screen.queryByText('Claude Code')).toBeNull();
  });

  it('keeps delete available from the session context menu with confirmation', async () => {
    const onDelete = vi.fn();

    render(
      <SessionItem
        session={makeSession({ id: 'session-3', title: 'Deletable Session', agent_kind: 'codex' })}
        isActive={false}
        onClick={vi.fn()}
        onTogglePinned={vi.fn()}
        onArchive={vi.fn()}
        onDelete={onDelete}
        onRename={vi.fn()}
      />,
    );

    fireEvent.contextMenu(screen.getByText('Deletable Session'));
    await waitFor(() => expect(screen.getByText('删除')).toBeTruthy());
    const menu = screen.getByRole('menu');
    expect(menu.className).toContain('max-h-[calc(100dvh-1rem)]');
    expect(menu.className).not.toMatch(/(^|\s)fixed(\s|$)/);
    fireEvent.click(screen.getByText('删除'));

    await waitFor(() => expect(screen.getByText('删除对话')).toBeTruthy());
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('places the pin action before the archive action and toggles pinned state', () => {
    const onTogglePinned = vi.fn();
    const onArchive = vi.fn();

    render(
      <SessionItem
        session={makeSession({ id: 'session-4', title: 'Pinnable Session' })}
        isActive={false}
        onClick={vi.fn()}
        onTogglePinned={onTogglePinned}
        onArchive={onArchive}
        onDelete={vi.fn()}
        onRename={vi.fn()}
      />,
    );

    const pin = screen.getByRole('button', { name: '置顶对话' });
    const archive = screen.getByRole('button', { name: '归档' });

    expect(pin.compareDocumentPosition(archive) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(pin);

    expect(onTogglePinned).toHaveBeenCalledWith(true);
    expect(onArchive).not.toHaveBeenCalled();
  });

  it('shows a waiting-confirmation badge when ask_user_question is pending', () => {
    useAgentStore.setState({
      events: {
        'session-5': [{
          kind: 'ask_user_question',
          data: {
            tool_use_id: 'q-1',
            questions: [{
              question: '选择一种习惯',
              options: [{ label: '频繁调试' }],
            }],
          },
        }],
      },
    });

    render(
      <SessionItem
        session={makeSession({ id: 'session-5', title: 'Waiting Session', updated_at: '2026-01-01T00:00:00.000Z' })}
        isActive={false}
        onClick={vi.fn()}
        onTogglePinned={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
      />,
    );

    expect(screen.getByText('等待确认')).toBeTruthy();
  });

  it('opens the remembered worktree path from the session context menu', async () => {
    useAgentStore.setState({
      sessionWorkingPaths: {
        'session-6': 'D:/project/codeMUX/.worktrees/brave-otter',
      },
    });

    render(
      <SessionItem
        session={makeSession({ id: 'session-6', title: 'Worktree Session', project_id: 'project-1' })}
        isActive={false}
        onClick={vi.fn()}
        onTogglePinned={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
      />,
    );

    fireEvent.contextMenu(screen.getByText('Worktree Session'));
    await waitFor(() => expect(screen.getByText('在资源管理器中打开')).toBeTruthy());
    fireEvent.click(screen.getByText('在资源管理器中打开'));

    expect(openInExplorerMock).toHaveBeenCalledWith('D:/project/codeMUX/.worktrees/brave-otter');
  });

  it('hides the hover action cluster on narrow viewports (long-press menu is the touch path)', () => {
    narrowState.value = true;

    render(
      <SessionItem
        session={makeSession({ id: 'session-n1', title: 'Narrow Session' })}
        isActive={false}
        onClick={vi.fn()}
        onTogglePinned={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
      />,
    );

    expect(screen.getByText('Narrow Session')).toBeTruthy();
    // opacity-0 但可点击的幽灵触控区必须消失:窄屏不渲染 hover 按钮簇。
    expect(screen.queryByRole('button', { name: '置顶对话' })).toBeNull();
    expect(screen.queryByRole('button', { name: '归档' })).toBeNull();
  });

  it('still opens the context menu on narrow viewports for long-press', async () => {
    narrowState.value = true;

    render(
      <SessionItem
        session={makeSession({ id: 'session-n2', title: 'Narrow Menu Session' })}
        isActive={false}
        onClick={vi.fn()}
        onTogglePinned={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
      />,
    );

    fireEvent.contextMenu(screen.getByText('Narrow Menu Session'));
    await waitFor(() => expect(screen.getByText('置顶')).toBeTruthy());
    expect(screen.getByText('重命名')).toBeTruthy();
  });

  it('reveals the session info card on hover', async () => {
    render(
      <SessionItem
        session={makeSession({ id: 'session-hover', title: 'Hover Session', model: 'gpt-5' })}
        isActive={false}
        onClick={vi.fn()}
        onTogglePinned={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
      />,
    );

    expect(screen.queryByText('Codex · gpt-5')).toBeNull();

    fireEvent.pointerOver(screen.getByText('Hover Session'));

    await waitFor(() => expect(screen.getByText('Codex · gpt-5')).toBeTruthy());
  });

  it('hides the explorer entry outside the desktop shell', async () => {
    hostCaps.hasExplorer = false;
    useAgentStore.setState({
      sessionWorkingPaths: {
        'session-n3': 'D:/project/codeMUX',
      },
    });

    render(
      <SessionItem
        session={makeSession({ id: 'session-n3', title: 'Browser Session', project_id: 'project-1' })}
        isActive={false}
        onClick={vi.fn()}
        onTogglePinned={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
      />,
    );

    fireEvent.contextMenu(screen.getByText('Browser Session'));
    await waitFor(() => expect(screen.getByText('重命名')).toBeTruthy());
    expect(screen.queryByText('在资源管理器中打开')).toBeNull();
  });
});
