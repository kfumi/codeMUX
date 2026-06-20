// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionItem } from './SessionItem';

describe('SessionItem', () => {
  afterEach(() => {
    cleanup();
  });

  it('keeps the session title visible for Codex sessions', () => {
    render(
      <SessionItem
        session={{
          id: 'session-1',
          title: 'Codex Session',
          agent_kind: 'codex',
          provider_id: null,
          model: null,
          mode: 'agent',
          project_id: null,
          created_at: '',
          updated_at: '',
        }}
        isActive={false}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        isMenuOpen={false}
        onOpenMenu={vi.fn()}
        onCloseMenu={vi.fn()}
      />,
    );

    expect(screen.getByText('Codex Session')).toBeTruthy();
    expect(screen.queryByText('Codex')).toBeNull();
  });

  it('keeps the session title visible for Claude Code sessions', () => {
    render(
      <SessionItem
        session={{
          id: 'session-2',
          title: 'Claude Session',
          agent_kind: 'claude_code',
          provider_id: null,
          model: null,
          mode: 'agent',
          project_id: null,
          created_at: '',
          updated_at: '',
        }}
        isActive={false}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        isMenuOpen={false}
        onOpenMenu={vi.fn()}
        onCloseMenu={vi.fn()}
      />,
    );

    expect(screen.getByText('Claude Session')).toBeTruthy();
    expect(screen.queryByText('Claude Code')).toBeNull();
  });

  it('keeps delete available from the session context menu with confirmation', () => {
    const onDelete = vi.fn();

    render(
      <SessionItem
        session={{
          id: 'session-3',
          title: 'Deletable Session',
          agent_kind: 'codex',
          provider_id: null,
          model: null,
          mode: 'agent',
          project_id: null,
          created_at: '',
          updated_at: '',
        }}
        isActive={false}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        onDelete={onDelete}
        onRename={vi.fn()}
        isMenuOpen
        onOpenMenu={vi.fn()}
        onCloseMenu={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('删除'));

    expect(screen.getByText('删除对话')).toBeTruthy();
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
