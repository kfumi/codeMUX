// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNewSessionStore } from '../../stores/newSessionStore';
import { NewSessionPanel } from './NewSessionPanel';

describe('NewSessionPanel', () => {
  beforeEach(() => {
    useNewSessionStore.setState({
      selectedAgentKind: 'claude_code',
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows Claude Code as the default placeholder target', () => {
    render(<NewSessionPanel onSubmit={vi.fn()} />);

    expect(screen.getByPlaceholderText('给 Claude Code 发送消息...')).toBeTruthy();
  });

  it('switches the placeholder when Codex is selected', () => {
    render(<NewSessionPanel onSubmit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }));
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));

    expect(screen.getByPlaceholderText('给 Codex 发送消息...')).toBeTruthy();
  });

  it('submits the typed message', () => {
    const onSubmit = vi.fn();

    render(<NewSessionPanel onSubmit={onSubmit} />);

    fireEvent.change(screen.getByPlaceholderText('给 Claude Code 发送消息...'), {
      target: { value: 'Ship the feature' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));

    expect(onSubmit).toHaveBeenCalledWith('Ship the feature');
  });
});
