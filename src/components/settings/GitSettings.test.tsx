// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsStore } from '../../stores/settingsStore';
import { useDaemonConnectionStore } from '../../stores/daemonConnectionStore';
import type { AppConfig } from '../../types/provider';
import { GitSettings } from './GitSettings';

const setGitSettingsMock = vi.fn();
const gitFacadeMock = vi.hoisted(() => ({
  getGiteeCredentialStatus: vi.fn(),
  setGiteeToken: vi.fn(),
  clearGiteeToken: vi.fn(),
}));
const gitEnvMock = vi.hoisted(() => ({ checkGitEnvironment: vi.fn() }));

vi.mock('../../lib/facades/daemon-facade', () => ({
  daemonFacade: {
    git: gitFacadeMock,
  },
}));

vi.mock('../../lib/facades/shell-facade', () => ({
  shellFacade: {
    checkGitEnvironment: gitEnvMock.checkGitEnvironment,
  },
}));

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
    useDaemonConnectionStore.setState({ hostForm: 'browser' });
    useSettingsStore.setState({
      config: structuredClone(baseConfig),
      setGitSettings: setGitSettingsMock,
    } as Partial<ReturnType<typeof useSettingsStore.getState>>);
    gitFacadeMock.getGiteeCredentialStatus.mockResolvedValue(false);
    gitFacadeMock.setGiteeToken.mockResolvedValue(undefined);
    gitFacadeMock.clearGiteeToken.mockResolvedValue(undefined);
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

    expect(screen.getByText('追加到提交信息的生成提示里')).toBeTruthy();
    expect(screen.getByText('追加到 PR 标题与描述的生成提示里')).toBeTruthy();
  });

  it('stores the Gitee token without displaying an existing token', async () => {
    render(<GitSettings />);

    const tokenInput = screen.getByTestId('gitee-token') as HTMLInputElement;
    fireEvent.change(tokenInput, { target: { value: 'gitee-secret' } });
    fireEvent.click(screen.getByTestId('gitee-token-save'));

    expect(gitFacadeMock.setGiteeToken).toHaveBeenCalledWith('gitee-secret');
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

  it('shows the local Git executable status in desktop form', async () => {
    useDaemonConnectionStore.setState({ hostForm: 'desktop' });
    gitEnvMock.checkGitEnvironment.mockResolvedValue({
      checkedAt: '2026-06-27T00:00:00Z',
      git: {
        name: 'Git',
        command: 'git',
        status: 'ok',
        version: '2.34.1',
        path: 'C:/Program Files/Git/cmd/git.exe',
        message: 'Git 可用。',
      },
    });

    render(<GitSettings />);

    expect(await screen.findByText('正常')).toBeTruthy();
    expect(screen.getByText('版本')).toBeTruthy();
    expect(screen.getByText('2.34.1')).toBeTruthy();
    expect(screen.getByText('位置')).toBeTruthy();
    expect(screen.getByText('C:/Program Files/Git/cmd/git.exe')).toBeTruthy();
  });

  it('shows the missing-Git message when git is not found', async () => {
    useDaemonConnectionStore.setState({ hostForm: 'desktop' });
    gitEnvMock.checkGitEnvironment.mockResolvedValue({
      checkedAt: '2026-06-27T00:00:00Z',
      git: {
        name: 'Git',
        command: 'git',
        status: 'missing',
        version: null,
        path: null,
        message: '未找到 Git，请安装 Git 并确认 PATH 已生效。',
      },
    });

    render(<GitSettings />);

    expect(await screen.findByText('未找到')).toBeTruthy();
    expect(screen.getByText('未找到 Git，请安装 Git 并确认 PATH 已生效。')).toBeTruthy();
  });

  it('hides the Git executable row off the desktop shell', () => {
    useDaemonConnectionStore.setState({ hostForm: 'browser' });
    render(<GitSettings />);

    expect(screen.queryByText('本机 Git')).toBeNull();
    expect(gitEnvMock.checkGitEnvironment).not.toHaveBeenCalled();
  });
});
