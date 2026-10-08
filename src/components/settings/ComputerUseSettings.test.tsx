// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const daemonFacadeMock = vi.hoisted(() => ({
  computerUse: {
    driverStatus: vi.fn(),
    diagnostics: vi.fn(),
    startDriver: vi.fn(),
    estopDriver: vi.fn(),
    updateDriver: vi.fn(),
    installDriver: vi.fn(),
    audit: vi.fn(),
  },
  setComputerUse: vi.fn(),
}));

vi.mock('../../lib/facades/daemon-facade', () => ({
  daemonFacade: daemonFacadeMock,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ComputerUseSettings } from './ComputerUseSettings';
import { useSettingsStore } from '../../stores/settingsStore';

describe('ComputerUseSettings', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    daemonFacadeMock.computerUse.driverStatus.mockResolvedValue({
      status: { configured: false, running: false, tools: [] },
      updateCommandConfigured: false,
      builtinDenyList: [],
    });
    useSettingsStore.setState({
      config: {
        computer_use: {
          enabled: false,
          system_execution_enabled: false,
          allowlist: [],
          max_steps: 40,
          driver_command: null,
          driver_args: [],
          driver_update_command: null,
        },
      } as never,
    });
  });

  it('renders the defaults as off with the builtin deny scopes visible', async () => {
    render(<ComputerUseSettings />);

    const master = screen.getByLabelText('开启电脑控制') as HTMLInputElement;
    expect(master.getAttribute('aria-checked')).toBe('false');
    expect((screen.getByLabelText('系统级执行') as HTMLInputElement).getAttribute('aria-checked')).toBe('false');

    // 内置拒绝列表即使 daemon 不可达也要看得见(不可删除这件事得写在界面上)。
    await waitFor(() => expect(screen.getByText('密码管理器')).toBeTruthy());
    expect(screen.getByText('终端')).toBeTruthy();
    expect(screen.getByText('CodeMUX 自身与安装更新器')).toBeTruthy();
  });

  it('persists the allowlist through the settings store', async () => {
    render(<ComputerUseSettings />);

    fireEvent.change(screen.getByLabelText(/允许列表/), {
      target: { value: '记事本\nExcel' },
    });
    fireEvent.click(screen.getByText('保存允许列表'));

    await waitFor(() =>
      expect(daemonFacadeMock.setComputerUse).toHaveBeenCalledWith(
        expect.objectContaining({ allowlist: ['记事本', 'Excel'] }),
      ),
    );
  });

  it('disables the update button until an update command is configured', async () => {
    render(<ComputerUseSettings />);

    const updateButton = screen.getByText('更新驱动').closest('button') as HTMLButtonElement;
    expect(updateButton.disabled).toBe(true);
  });

  it('shows driver diagnostics with repair guidance', async () => {
    daemonFacadeMock.computerUse.diagnostics.mockResolvedValue({
      checks: [
        { id: 'configured', label: '驱动已配置', ok: false, detail: '尚未配置驱动命令', fix: '去设置里填' },
        { id: 'deny-list', label: '内置拒绝列表就位', ok: true, detail: '内置拒绝 22 条' },
      ],
    });
    render(<ComputerUseSettings />);

    fireEvent.click(screen.getByText('一键诊断'));

    await waitFor(() => expect(screen.getByText('待修')).toBeTruthy());
    expect(screen.getByText(/去设置里填/)).toBeTruthy();
    expect(screen.getByText('通过')).toBeTruthy();
  });

  it('requires an explicit confirmation before running the update command', async () => {
    useSettingsStore.setState({
      config: {
        computer_use: {
          enabled: true,
          system_execution_enabled: true,
          allowlist: [],
          max_steps: 40,
          driver_command: 'cua-driver',
          driver_args: [],
          driver_update_command: 'npm i -g cua-driver@latest',
        },
      } as never,
    });
    daemonFacadeMock.computerUse.driverStatus.mockResolvedValue({
      status: { configured: true, running: false, tools: [] },
      updateCommandConfigured: true,
      builtinDenyList: [],
    });

    render(<ComputerUseSettings />);

    const updateButton = await waitFor(() => {
      const button = screen.getByText('更新驱动').closest('button') as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      return button;
    });
    fireEvent.click(updateButton);

    // 只弹出确认对话框,还没有真调用 —— 「升级必须经我确认」不是界面礼貌。
    await waitFor(() => expect(screen.getByText('更新驱动？')).toBeTruthy());
    expect(daemonFacadeMock.computerUse.updateDriver).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('执行更新'));
    await waitFor(() => expect(daemonFacadeMock.computerUse.updateDriver).toHaveBeenCalledTimes(1));
  });

  it('offers one-click install when the daemon reports no driver found', async () => {
    daemonFacadeMock.computerUse.driverStatus.mockResolvedValue({
      status: { configured: false, running: false, tools: [] },
      updateCommandConfigured: false,
      builtinDenyList: [],
      driverResolution: { mode: 'missing', command: null, detectedPath: null },
    });
    render(<ComputerUseSettings />);

    await waitFor(() => expect(screen.getByText('一键安装')).toBeTruthy());
    expect(screen.getAllByText(/未检测到 cua-driver/).length).toBeGreaterThan(0);
  });

  it('requires an explicit confirmation before running the install script', async () => {
    daemonFacadeMock.computerUse.driverStatus.mockResolvedValue({
      status: { configured: false, running: false, tools: [] },
      updateCommandConfigured: false,
      builtinDenyList: [],
      driverResolution: { mode: 'missing', command: null, detectedPath: null },
    });
    render(<ComputerUseSettings />);

    fireEvent.click(await waitFor(() => screen.getByText('一键安装')));
    await waitFor(() => expect(screen.getByText('安装 cua-driver？')).toBeTruthy());
    expect(daemonFacadeMock.computerUse.installDriver).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('下载并安装'));
    await waitFor(() =>
      expect(daemonFacadeMock.computerUse.installDriver).toHaveBeenCalledTimes(1),
    );
  });

  it('labels the auto-detected driver and defaults the placeholder to it', async () => {
    const detected =
      'C:\\Users\\me\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe';
    daemonFacadeMock.computerUse.driverStatus.mockResolvedValue({
      status: { configured: true, running: false, tools: [] },
      updateCommandConfigured: false,
      builtinDenyList: [],
      driverResolution: { mode: 'auto', command: detected, detectedPath: detected },
    });
    render(<ComputerUseSettings />);

    await waitFor(() => expect(screen.getByText('自动检测')).toBeTruthy());
    const commandInput = screen.getByLabelText('驱动命令') as HTMLInputElement;
    expect(commandInput.placeholder).toContain('留空 = 自动:C:\\Users\\me');
    expect(screen.queryByText('一键安装')).toBeNull();
  });
});
