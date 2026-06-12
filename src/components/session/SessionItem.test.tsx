// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
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
        onDelete={vi.fn()}
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
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText('Claude Session')).toBeTruthy();
    expect(screen.queryByText('Claude Code')).toBeNull();
  });
});
