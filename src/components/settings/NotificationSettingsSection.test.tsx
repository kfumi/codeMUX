// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsStore } from '../../stores/settingsStore';
import type { AppConfig } from '../../types/provider';
import { NotificationSettingsSection } from './NotificationSettingsSection';

const setNotificationSettingsMock = vi.fn();

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
  default_open_target: 'file_explorer',
  notifications: {
    system_enabled: true,
    sound_enabled: false,
    sound: 'ding',
  },
  theme: 'System',
};

describe('NotificationSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      config: structuredClone(baseConfig),
      setNotificationSettings: setNotificationSettingsMock,
    } as Partial<ReturnType<typeof useSettingsStore.getState>>);
    vi.stubGlobal('Audio', vi.fn(() => ({
      volume: 1,
      play: vi.fn(async () => undefined),
    })));
  });

  it('renders notification controls with sound disabled by default', () => {
    render(<NotificationSettingsSection />);

    expect(screen.getByText('通知')).toBeTruthy();
    const systemSwitches = screen.getAllByRole('switch', { name: '系统通知' });
    expect(systemSwitches[0].getAttribute('aria-checked')).toBe('true');
    const soundSwitches = screen.getAllByRole('switch', { name: '提示音' });
    expect(soundSwitches[0].getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('button', { name: '试听' }).hasAttribute('disabled')).toBe(true);
  });

  it('updates settings when enabling sound', () => {
    render(<NotificationSettingsSection />);

    const soundSwitches = screen.getAllByRole('switch', { name: '提示音' });
    fireEvent.click(soundSwitches[0]);

    expect(setNotificationSettingsMock).toHaveBeenCalledWith({
      system_enabled: true,
      sound_enabled: true,
      sound: 'ding',
    });
  });

  it('normalizes legacy sound values before toggling sound', () => {
    useSettingsStore.setState({
      config: {
        ...structuredClone(baseConfig),
        notifications: {
          system_enabled: true,
          sound_enabled: false,
          sound: 'soft' as never,
        },
      },
      setNotificationSettings: setNotificationSettingsMock,
    } as Partial<ReturnType<typeof useSettingsStore.getState>>);

    render(<NotificationSettingsSection />);

    const soundSwitches = screen.getAllByRole('switch', { name: '提示音' });
    fireEvent.click(soundSwitches[0]);

    expect(setNotificationSettingsMock).toHaveBeenCalledWith({
      system_enabled: true,
      sound_enabled: true,
      sound: 'ding',
    });
  });
});
