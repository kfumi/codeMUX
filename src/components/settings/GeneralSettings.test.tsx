// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsStore } from '../../stores/settingsStore';
import { useDaemonConnectionStore } from '../../stores/daemonConnectionStore';
import type { AppConfig } from '../../types/provider';
import { GeneralSettings } from './GeneralSettings';

const setDefaultOpenTargetMock = vi.fn();
const setImmediateRunModeMock = vi.fn();

const shellFacadeMock = vi.hoisted(() => ({
  getAppDataDirectory: vi.fn(async () => 'D:\\CodeMUX'),
  openInExplorer: vi.fn(async () => undefined),
}));

vi.mock('../../lib/facades/shell-facade', () => ({ shellFacade: shellFacadeMock }));

vi.mock('./NotificationSettingsSection', () => ({
  NotificationSettingsSection: () => <div>通知设置</div>,
}));

const baseConfig: AppConfig = {
  model_providers: [],
  active_provider_id: null,
  agent_defaults: { default_agent_kind: 'claude_code' },
  agent_configs: {
    claude_code: { executable_mode: 'auto', resume_sessions: true },
    gemini_cli: {},
    opencode: {},
  },
  compact_ai_output: false,
  default_open_target: 'git_bash',
  notifications: {
    system_enabled: true,
    sound_enabled: false,
    sound: 'ding',
  },
  theme: 'System',
};

describe('GeneralSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDaemonConnectionStore.setState({ hostForm: 'desktop' });
    useSettingsStore.setState({
      config: structuredClone(baseConfig),
      setDefaultOpenTarget: setDefaultOpenTargetMock,
      setImmediateRunMode: setImmediateRunModeMock,
      setCompactAiOutput: vi.fn(),
    } as Partial<ReturnType<typeof useSettingsStore.getState>>);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders and updates the default file open target setting', () => {
    render(<GeneralSettings />);

    expect(screen.getByText('默认文件打开目标')).toBeTruthy();
    expect(screen.getByText('Git Bash')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('默认文件打开目标'));
    fireEvent.click(screen.getByText('Cursor'));

    expect(setDefaultOpenTargetMock).toHaveBeenCalledWith('cursor');
  });

  it('renders and updates the immediate-run preference', () => {
    render(<GeneralSettings />);

    expect(screen.getByText('「立即」的行为')).toBeTruthy();
    expect(screen.getByText('引导')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('立即的行为'));
    fireEvent.click(screen.getByText('中断'));

    expect(setImmediateRunModeMock).toHaveBeenCalledWith('interrupt');
  });

  it('桌面壳形态展示配置文件路径(壳桥提供应用数据目录)', async () => {
    render(<GeneralSettings />);

    expect(await screen.findByText('D:\\CodeMUX\\config.json')).toBeTruthy();
    expect(screen.getByRole('button', { name: /打开配置目录/ })).toBeTruthy();
    expect(shellFacadeMock.getAppDataDirectory).toHaveBeenCalled();
  });

  it('浏览器形态隐藏配置文件区块,不再调用壳桥', () => {
    // 回归:壳门面曾同步抛错,浏览器形态打开设置会整块渲染成「渲染错误」。
    useDaemonConnectionStore.setState({ hostForm: 'browser' });

    render(<GeneralSettings />);

    expect(screen.queryByText('配置文件')).toBeNull();
    expect(screen.queryByRole('button', { name: /打开配置目录/ })).toBeNull();
    expect(shellFacadeMock.getAppDataDirectory).not.toHaveBeenCalled();
  });
});
