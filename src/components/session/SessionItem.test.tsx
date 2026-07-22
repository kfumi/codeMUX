// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionItem } from './SessionItem';
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
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(() => {});
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
});
