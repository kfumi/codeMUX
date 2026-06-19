// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNewSessionStore } from '../../stores/newSessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { NewSessionPanel } from './NewSessionPanel';

describe('NewSessionPanel', () => {
  beforeEach(() => {
    useNewSessionStore.setState({
      selectedAgentKind: 'claude_code',
      selectedModel: null,
    });
    useSettingsStore.setState((state) => ({
      ...state,
      config: {
        providers: [{
          id: 'provider-1',
          name: 'Provider',
          api_key: 'key',
          anthropic_base_url: 'https://api.anthropic.com',
          openai_base_url: 'https://api.openai.com/v1',
          default_model: 'claude-sonnet-4-20250514',
          models: ['claude-sonnet-4-20250514', 'claude-opus-4-1'],
        }],
        active_provider_id: 'provider-1',
        agent_defaults: { default_agent_kind: 'claude_code' },
        agent_configs: {
          claude_code: { executable_mode: 'auto', resume_sessions: true },
          codex: { sdk_mode: 'responses' },
          gemini_cli: {},
          opencode: {},
        },
        theme: 'System',
      },
    }));
  });

  afterEach(() => {
    cleanup();
  });

  it('shows Claude Code as the default placeholder target', () => {
    render(<NewSessionPanel onSubmit={vi.fn()} />);

    expect(screen.getByPlaceholderText('给 Claude Code 发送第一条任务指令...')).toBeTruthy();
  });

  it('switches the placeholder when Codex is selected', () => {
    render(<NewSessionPanel onSubmit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }));
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));

    expect(screen.getByPlaceholderText('给 Codex 发送第一条任务指令...')).toBeTruthy();
  });

  it('lets the draft choose a provider model', () => {
    render(<NewSessionPanel onSubmit={vi.fn()} />);

    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: /claude-opus-4-1/ }));

    expect(useNewSessionStore.getState().selectedModel).toBe('claude-opus-4-1');
  });

  it('submits the typed message', () => {
    const onSubmit = vi.fn();

    render(<NewSessionPanel onSubmit={onSubmit} />);

    fireEvent.change(screen.getByPlaceholderText('给 Claude Code 发送第一条任务指令...'), {
      target: { value: 'Ship the feature' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));

    expect(onSubmit).toHaveBeenCalledWith('Ship the feature');
  });
});
