// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsStore } from '../../stores/settingsStore';
import type { AppConfig } from '../../types/provider';
import { GitSettings } from './GitSettings';

const setGitSettingsMock = vi.fn();

const baseConfig: AppConfig = {
  providers: [],
  model_providers: [
    {
      id: 'provider-a',
      name: 'Provider A',
      enabled: true,
      api_key: 'key',
      endpoints: [
        { protocol: 'openai_compatible', base_url: 'https://api.a.com' },
      ],
      models: [
        { id: 'model-a1', name: null },
        { id: 'model-a2', name: null },
      ],
      default_model: 'model-a1',
    },
    {
      id: 'provider-b',
      name: 'Provider B',
      enabled: true,
      api_key: 'key',
      endpoints: [
        { protocol: 'anthropic', base_url: 'https://api.b.com' },
      ],
      models: [{ id: 'model-b1', name: null }],
      default_model: 'model-b1',
    },
  ],
  active_provider_id: 'provider-b',
  agent_defaults: { default_agent_kind: 'claude_code' },
  agent_configs: {
    claude_code: { executable_mode: 'auto', resume_sessions: true },
    codex: { sdk_mode: 'responses' },
    gemini_cli: {},
    opencode: {},
  },
  compact_ai_output: false,
  default_open_target: 'file_explorer',
  notifications: {
    system_enabled: true,
    sound_enabled: false,
    sound: 'ding',
  },
  git: {
    commit_instructions: '',
    pull_request_instructions: '',
    provider_id: null,
    model: '',
  },
  theme: 'System',
};

describe('GitSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      config: structuredClone(baseConfig),
      setGitSettings: setGitSettingsMock,
    } as Partial<ReturnType<typeof useSettingsStore.getState>>);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders instruction textareas with placeholders and descriptions', () => {
    render(<GitSettings />);

    const commitTextarea = screen.getByTestId('git-commit-instructions') as HTMLTextAreaElement;
    expect(commitTextarea.getAttribute('placeholder')).toBe('添加提交消息指引...');
    const prTextarea = screen.getByTestId('git-pr-instructions') as HTMLTextAreaElement;
    expect(prTextarea.getAttribute('placeholder')).toBe('添加拉取请求指引...');

    expect(screen.getByText('已添加到提交信息生成提示中')).toBeTruthy();
    expect(screen.getByText('已添加到 PR 标题/描述生成提示中')).toBeTruthy();
  });

  it('saves commit instructions on blur when modified', () => {
    render(<GitSettings />);

    const commitTextarea = screen.getByTestId('git-commit-instructions');
    fireEvent.change(commitTextarea, { target: { value: '提交需包含工单号' } });
    fireEvent.blur(commitTextarea);

    expect(setGitSettingsMock).toHaveBeenCalledWith({
      commit_instructions: '提交需包含工单号',
      pull_request_instructions: '',
      provider_id: null,
      model: '',
    });
  });

  it('does not save when blur without changes', () => {
    render(<GitSettings />);

    const commitTextarea = screen.getByTestId('git-commit-instructions');
    fireEvent.blur(commitTextarea);

    expect(setGitSettingsMock).not.toHaveBeenCalled();
  });

  it('shows existing git instructions from config', () => {
    useSettingsStore.setState({
      config: {
        ...structuredClone(baseConfig),
        git: {
          commit_instructions: '已有提交指引',
          pull_request_instructions: '已有 PR 指引',
          provider_id: 'provider-a',
          model: 'model-a2',
        },
      },
    } as Partial<ReturnType<typeof useSettingsStore.getState>>);

    render(<GitSettings />);

    const commitTextarea = screen.getByTestId('git-commit-instructions') as HTMLTextAreaElement;
    expect(commitTextarea.value).toBe('已有提交指引');
    const prTextarea = screen.getByTestId('git-pr-instructions') as HTMLTextAreaElement;
    expect(prTextarea.value).toBe('已有 PR 指引');
  });
});
