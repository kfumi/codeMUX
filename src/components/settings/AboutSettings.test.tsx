// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getNameMock = vi.fn(async () => 'codeMUX');
const getVersionMock = vi.fn(async () => '1.0.0');
const getTauriVersionMock = vi.fn(async () => '2.0.0');

type MockUpdaterContext = {
  stage: 'idle' | 'checking' | 'available' | 'latest' | 'downloading' | 'installing' | 'restarting' | 'error';
  checkForUpdates: ReturnType<typeof vi.fn>;
};

let mockUpdaterContext: MockUpdaterContext;

vi.mock('@tauri-apps/api/app', () => ({
  getName: getNameMock,
  getVersion: getVersionMock,
  getTauriVersion: getTauriVersionMock,
}));

vi.mock('../../features/update/UpdaterProvider', () => ({
  useUpdaterContext: () => mockUpdaterContext,
}));

describe('AboutSettings', () => {
  beforeEach(() => {
    mockUpdaterContext = {
      stage: 'idle',
      checkForUpdates: vi.fn(),
    };
  });

  afterEach(() => {
    cleanup();
  });

  it('点击检查更新时调用交互式更新检查', async () => {
    const { AboutSettings } = await import('./AboutSettings');

    render(<AboutSettings />);

    await screen.findByText('codeMUX');

    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));

    expect(mockUpdaterContext.checkForUpdates).toHaveBeenCalledWith({
      interactive: true,
      announceNoUpdate: true,
    });
  });

  it('检查中展示加载态并禁用按钮', async () => {
    mockUpdaterContext.stage = 'checking';

    const { AboutSettings } = await import('./AboutSettings');

    render(<AboutSettings />);

    const button = await screen.findByRole('button', { name: '检查中...' });
    expect(button).toHaveProperty('disabled', true);
    fireEvent.click(button);
    expect(mockUpdaterContext.checkForUpdates).not.toHaveBeenCalled();
  });

  it.each([
    ['downloading'],
    ['installing'],
    ['restarting'],
  ] as const)('更新处于 %s 阶段时禁用检查更新按钮且不允许再次触发', async (stage) => {
    mockUpdaterContext.stage = stage;

    const { AboutSettings } = await import('./AboutSettings');

    render(<AboutSettings />);

    const button = await screen.findByRole('button', { name: '检查更新' });
    expect(button).toHaveProperty('disabled', true);

    fireEvent.click(button);

    expect(mockUpdaterContext.checkForUpdates).not.toHaveBeenCalled();
  });
});
