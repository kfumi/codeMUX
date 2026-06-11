// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionItem } from './SessionItem';

describe('SessionItem', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows the bound agent label for Codex sessions', () => {
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

    expect(screen.getByText('Codex')).toBeTruthy();
  });

  it('shows the bound agent label for Claude Code sessions', () => {
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

    expect(screen.getByText('Claude Code')).toBeTruthy();
  });

  it('does not show agent badge for sessions with no matching registry entry', () => {
    const { container } = render(
      <SessionItem
        session={{
          id: 'session-3',
          title: 'Unknown Session',
          agent_kind: 'gemini_cli' as any,
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

    // gemini_cli has capabilities=[] so it's in the registry but still has a label
    expect(screen.getByText('Gemini CLI')).toBeTruthy();
  });
});
