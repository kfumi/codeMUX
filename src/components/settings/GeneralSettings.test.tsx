// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsStore } from '../../stores/settingsStore';
import type { AppConfig } from '../../types/provider';
import { GeneralSettings } from './GeneralSettings';

const setDefaultOpenTargetMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('../../lib/tauri', () => ({
  appApi: {
    getAppDataDirectory: vi.fn(async () => 'D:\\CodeMUX'),
  },
}));

vi.mock('./NotificationSettingsSection', () => ({
  NotificationSettingsSection: () => <div>通知设置</div>,
}));

const baseConfig: AppConfig = {
  providers: [],
  active_provider_id: null,
  agent_defaults: { default_agent_kind: 'claude_code' },
  agent_configs: {
    claude_code: { executable_mode: 'auto', resume_sessions: true },
    codex: { sdk_mode: 'responses' },
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
    useSettingsStore.setState({
      config: structuredClone(baseConfig),
      setDefaultOpenTarget: setDefaultOpenTargetMock,
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
});
