// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsStore } from '../../stores/settingsStore';
import type { AppConfig } from '../../types/provider';
import { TooltipProvider } from '../ui/tooltip';
import { ProjectOpenTargetButton } from './ProjectOpenTargetButton';

const { openProjectPathMock } = vi.hoisted(() => ({
  openProjectPathMock: vi.fn(async () => undefined),
}));

vi.mock('../../lib/tauri', () => ({
  fileApi: {
    openProjectPath: openProjectPathMock,
  },
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
  default_open_target: 'terminal',
  notifications: {
    system_enabled: true,
    sound_enabled: false,
    sound: 'ding',
  },
  theme: 'System',
};

describe('ProjectOpenTargetButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      config: structuredClone(baseConfig),
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('opens the project with the configured default target', () => {
    render(
      <TooltipProvider>
        <ProjectOpenTargetButton projectPath={'D:\\project\\ai-code\\codeMUX'} />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开项目：Terminal' }));

    expect(openProjectPathMock).toHaveBeenCalledWith('D:\\project\\ai-code\\codeMUX', 'terminal');
  });

  it('lets users choose a different target for this click', () => {
    render(
      <TooltipProvider>
        <ProjectOpenTargetButton projectPath={'D:\\project\\ai-code\\codeMUX'} />
      </TooltipProvider>,
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: '选择打开项目方式' }));
    fireEvent.click(screen.getByText('VS Code'));

    expect(openProjectPathMock).toHaveBeenCalledWith('D:\\project\\ai-code\\codeMUX', 'vscode');
  });

  it('offers Cursor instead of Visual Studio', () => {
    render(
      <TooltipProvider>
        <ProjectOpenTargetButton projectPath={'D:\\project\\ai-code\\codeMUX'} />
      </TooltipProvider>,
    );

    fireEvent.pointerDown(screen.getAllByRole('button')[1]);

    expect(screen.getByText('Cursor')).toBeTruthy();
    expect(screen.queryByText('Visual Studio')).toBeNull();
  });
});
