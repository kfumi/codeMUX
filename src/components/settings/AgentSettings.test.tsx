// @vitest-environment jsdom

import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';

import { AgentSettingsPanel, RuntimeCard } from './AgentSettings';
import { useSettingsStore } from '../../stores/settingsStore';
import type { AgentInstallationReport, AgentRuntimeCheck } from '../../lib/tauri';

const checkAgentRuntimesMock = vi.fn();
const upgradeAgentRuntimeMock = vi.fn();
const probeAgentInstallationsMock = vi.fn();

vi.mock('../../lib/tauri', () => ({
  appApi: {
    checkAgentRuntimes: (...args: unknown[]) => checkAgentRuntimesMock(...args),
    upgradeAgentRuntime: (...args: unknown[]) => upgradeAgentRuntimeMock(...args),
    probeAgentInstallations: (...args: unknown[]) => probeAgentInstallationsMock(...args),
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('sonner', () => ({
  toast: {
    loading: vi.fn(() => 'toast-id'),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

const baseConfig = {
  providers: [
    {
      id: 'provider-active',
      name: 'Active Provider',
      api_key: 'key-1',
      anthropic_base_url: 'https://api.anthropic.com',
      openai_base_url: 'https://api.openai.com',
      default_model: 'claude-sonnet-4-20250514',
    },
  ],
  active_provider_id: 'provider-active',
  agent_defaults: {
    default_agent_kind: 'codex' as const,
  },
  agent_configs: {
    claude_code: {
      executable_mode: 'auto' as const,
      resume_sessions: true,
      permission_config: { kind: 'claude_code' as const, permissionMode: 'default' },
    },
    codex: {
      sdk_mode: 'responses',
    },
    gemini_cli: {},
    opencode: {},
  },
  theme: 'System' as const,
  compact_ai_output: false,
  default_open_target: 'file_explorer' as const,
};

// 升级流程测试共用的运行时/安装报告 fixture
const outdatedCodexRuntime: AgentRuntimeCheck = {
  agentKind: 'codex',
  label: 'Codex',
  command: 'codex',
  status: 'outdated',
  currentVersion: '0.139.0',
  latestVersion: '0.140.0',
  executablePath: '/usr/local/bin/codex',
  configPath: '/home/user/.codex/config.toml',
  npmPackage: '@openai/codex',
  message: 'Codex 已安装(0.139.0),最新版本为 0.140.0,可一键升级。',
  installedButBroken: false,
};

const singleInstallReport: AgentInstallationReport = {
  agentKind: 'codex',
  installs: [
    { path: '/usr/local/bin/codex', real: '/usr/local/bin/codex', version: '0.139.0', runnable: true, error: null, source: 'nvm', isPathDefault: true },
  ],
  isConflict: false,
  needsConfirmation: false,
  anchored: true,
  command: 'npm install -g @openai/codex@latest',
};

const multiInstallReport: AgentInstallationReport = {
  agentKind: 'codex',
  installs: [
    { path: '/usr/local/bin/codex', real: '/usr/local/bin/codex', version: '0.139.0', runnable: true, error: null, source: 'nvm', isPathDefault: true },
    { path: '/opt/homebrew/bin/codex', real: '/opt/homebrew/bin/codex', version: '0.140.0', runnable: true, error: null, source: 'homebrew', isPathDefault: false },
  ],
  isConflict: true,
  needsConfirmation: true,
  anchored: true,
  command: 'npm install -g @openai/codex@latest',
};

describe('AgentSettingsPanel', () => {
  beforeAll(() => {
    // Radix 组件在 jsdom 中调用 scrollIntoView / pointer capture，需提供占位实现
    Element.prototype.scrollIntoView = () => {};
    if (!HTMLElement.prototype.hasPointerCapture) {
      HTMLElement.prototype.hasPointerCapture = () => false;
    }
    if (!HTMLElement.prototype.releasePointerCapture) {
      HTMLElement.prototype.releasePointerCapture = () => {};
    }
    if (!HTMLElement.prototype.setPointerCapture) {
      HTMLElement.prototype.setPointerCapture = () => {};
    }
  });

  beforeEach(() => {
    useSettingsStore.setState((state) => ({
      ...state,
      config: baseConfig,
      setDefaultAgentKind: vi.fn(),
      getDefaultAgentKind: () => 'codex',
      updateAgentConfig: vi.fn(async () => {}),
    }));
    checkAgentRuntimesMock.mockReset();
    upgradeAgentRuntimeMock.mockReset();
    probeAgentInstallationsMock.mockReset();
    // 默认返回单处安装、无需确认,使旧的"直接升级"测试路径不变
    probeAgentInstallationsMock.mockResolvedValue({
      agentKind: '',
      installs: [],
      isConflict: false,
      needsConfirmation: false,
      anchored: true,
      command: null,
    });
    // 清除 toast 调用历史(保留 vi.mock 工厂设定的实现)
    toast.loading.mockClear();
    toast.success.mockClear();
    toast.error.mockClear();
    toast.warning.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('一键检测运行时并展示卡片（含路径/配置文件/版本，不含命令行）', async () => {
    checkAgentRuntimesMock.mockResolvedValue({
      checkedAt: '2026-07-25T10:00:00Z',
      runtimes: [
        {
          agentKind: 'claude_code',
          label: 'Claude Code',
          command: 'claude',
          status: 'ok',
          currentVersion: '1.0.16',
          latestVersion: '1.0.16',
          executablePath: '/usr/local/bin/claude',
          configPath: '/home/user/.claude/settings.json',
          npmPackage: '@anthropic-ai/claude-code',
          message: 'Claude Code 已是最新版本（1.0.16）。',
        },
        {
          agentKind: 'codex',
          label: 'Codex',
          command: 'codex',
          status: 'outdated',
          currentVersion: '0.139.0',
          latestVersion: '0.140.0',
          executablePath: '/usr/local/bin/codex',
          configPath: '/home/user/.codex/config.toml',
          npmPackage: '@openai/codex',
          message: 'Codex 已安装（0.139.0），最新版本为 0.140.0，可一键升级。',
        },
        {
          agentKind: 'opencode',
          label: 'OpenCode',
          command: 'opencode',
          status: 'missing',
          currentVersion: null,
          latestVersion: null,
          executablePath: null,
          configPath: null,
          npmPackage: 'opencode-ai',
          message: '未在 PATH 中找到 OpenCode CLI。',
        },
      ],
    });

    render(<AgentSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText('Claude Code')).toBeTruthy();
      expect(screen.getByText('Codex')).toBeTruthy();
      expect(screen.getByText('OpenCode')).toBeTruthy();
    });

    // 状态徽标
    expect(screen.getByText('已就绪')).toBeTruthy();
    expect(screen.getByText('可升级')).toBeTruthy();
    expect(screen.getByText('未安装')).toBeTruthy();

    // 配置文件路径展示
    expect(screen.getByText('/home/user/.claude/settings.json')).toBeTruthy();
    expect(screen.getByText('/home/user/.codex/config.toml')).toBeTruthy();

    // 不再展示独立的"命令"行
    expect(screen.queryByText('命令')).toBeNull();

    // 仅 outdated 的卡片显示升级按钮
    const upgradeButtons = screen.getAllByRole('button', { name: /升级到/ });
    expect(upgradeButtons).toHaveLength(1);
    expect(upgradeButtons[0].textContent).toContain('0.140.0');
  });

  it('检测失败时显示错误信息', async () => {
    checkAgentRuntimesMock.mockRejectedValue(new Error('network down'));

    render(<AgentSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText(/环境检测失败：network down/)).toBeTruthy();
    });
  });

  it('点击升级按钮触发 upgradeAgentRuntime 并刷新', async () => {
    checkAgentRuntimesMock.mockResolvedValue({
      checkedAt: '2026-07-25T10:00:00Z',
      runtimes: [
        {
          agentKind: 'codex',
          label: 'Codex',
          command: 'codex',
          status: 'outdated',
          currentVersion: '0.139.0',
          latestVersion: '0.140.0',
          executablePath: '/usr/local/bin/codex',
          configPath: '/home/user/.codex/config.toml',
          npmPackage: '@openai/codex',
          message: 'Codex 已安装（0.139.0），最新版本为 0.140.0，可一键升级。',
        },
      ],
    });
    upgradeAgentRuntimeMock.mockResolvedValue({
      agentKind: 'codex',
      success: true,
      outcome: 'success',
      message: 'Codex 升级完成。',
      newVersion: '0.140.0',
    });

    render(<AgentSettingsPanel />);

    const upgradeButton = await screen.findByRole('button', { name: /升级到 0\.140\.0/ });
    fireEvent.click(upgradeButton);

    await waitFor(() => {
      expect(upgradeAgentRuntimeMock).toHaveBeenCalledWith('codex');
    });

    // 升级完成后应再次调用 checkAgentRuntimes 刷新
    await waitFor(() => {
      expect(checkAgentRuntimesMock).toHaveBeenCalledTimes(2);
    });
  });

  it('点击"设为默认"将对应智能体设为默认引擎', async () => {
    const setDefaultAgentKind = vi.fn();
    useSettingsStore.setState((state) => ({
      ...state,
      setDefaultAgentKind,
    }));

    checkAgentRuntimesMock.mockResolvedValue({
      checkedAt: '',
      runtimes: [
        {
          agentKind: 'claude_code',
          label: 'Claude Code',
          command: 'claude',
          status: 'ok',
          currentVersion: '1.0.16',
          latestVersion: '1.0.16',
          executablePath: '/usr/local/bin/claude',
          configPath: '/home/user/.claude/settings.json',
          npmPackage: '@anthropic-ai/claude-code',
          message: 'Claude Code 已是最新版本（1.0.16）。',
        },
      ],
    });

    render(<AgentSettingsPanel />);

    const setDefaultBtn = await screen.findByRole('button', { name: '设为默认' });
    fireEvent.click(setDefaultBtn);

    expect(setDefaultAgentKind).toHaveBeenCalledWith('claude_code');
  });

  it('当前默认智能体卡片显示默认徽标且不显示"设为默认"按钮', async () => {
    // 默认配置中 default_agent_kind 为 'codex'
    checkAgentRuntimesMock.mockResolvedValue({
      checkedAt: '',
      runtimes: [
        {
          agentKind: 'codex',
          label: 'Codex',
          command: 'codex',
          status: 'ok',
          currentVersion: '0.139.0',
          latestVersion: '0.139.0',
          executablePath: '/usr/local/bin/codex',
          configPath: '/home/user/.codex/config.toml',
          npmPackage: '@openai/codex',
          message: 'Codex 已是最新版本（0.139.0）。',
        },
        {
          agentKind: 'claude_code',
          label: 'Claude Code',
          command: 'claude',
          status: 'ok',
          currentVersion: '1.0.16',
          latestVersion: '1.0.16',
          executablePath: '/usr/local/bin/claude',
          configPath: '/home/user/.claude/settings.json',
          npmPackage: '@anthropic-ai/claude-code',
          message: 'Claude Code 已是最新版本（1.0.16）。',
        },
      ],
    });

    render(<AgentSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText('Codex')).toBeTruthy();
    });

    // Codex 是默认，显示默认徽标
    expect(screen.getByText('默认')).toBeTruthy();
    // 只有 Claude Code 卡片显示"设为默认"
    expect(screen.getAllByRole('button', { name: '设为默认' })).toHaveLength(1);
  });

  it('本地代理路由作为独立区块展示', async () => {
    checkAgentRuntimesMock.mockResolvedValue({ checkedAt: '', runtimes: [] });

    render(<AgentSettingsPanel />);

    await waitFor(() => expect(checkAgentRuntimesMock).toHaveBeenCalled());

    // 本地代理路由独立 section
    const headings = screen.getAllByRole('heading', { level: 3 });
    const proxyHeading = headings.find((h) => h.textContent === '本地代理路由');
    expect(proxyHeading).toBeTruthy();
    expect(screen.getByText('由档案配置在启动 Codex 会话时自动管理。')).toBeTruthy();
    // "按需启动"在未运行时既出现在标题也出现在徽标
    expect(screen.getAllByText('按需启动').length).toBeGreaterThanOrEqual(1);
  });

  it('Claude Code 默认权限展示与发送框一致的 4 个选项', async () => {
    checkAgentRuntimesMock.mockResolvedValue({ checkedAt: '', runtimes: [] });

    render(<AgentSettingsPanel />);

    await waitFor(() => expect(checkAgentRuntimesMock).toHaveBeenCalled());

    // 4 个权限选项卡片
    expect(screen.getByText('变更前确认')).toBeTruthy();
    expect(screen.getByText('自动编辑')).toBeTruthy();
    expect(screen.getByText('计划模式')).toBeTruthy();
    expect(screen.getByText('完全访问')).toBeTruthy();

    // 不再展示原 Select 下拉的额外模式
    expect(screen.queryByText('自动执行')).toBeNull();
    expect(screen.queryByText('不再询问')).toBeNull();
    expect(screen.queryByText('完全放行')).toBeNull();
  });

  it('点击权限选项卡片触发 updateAgentConfig 写入对应 permissionMode', async () => {
    const updateAgentConfig = vi.fn(async () => {});
    useSettingsStore.setState((state) => ({
      ...state,
      updateAgentConfig,
    }));

    checkAgentRuntimesMock.mockResolvedValue({ checkedAt: '', runtimes: [] });

    render(<AgentSettingsPanel />);

    await waitFor(() => expect(checkAgentRuntimesMock).toHaveBeenCalled());

    // 点击"完全访问"（应映射为 bypassPermissions）
    fireEvent.click(screen.getByText('完全访问'));

    await waitFor(() => {
      expect(updateAgentConfig).toHaveBeenCalledWith('claude_code', {
        permission_config: { kind: 'claude_code', permissionMode: 'bypassPermissions' },
      });
    });
  });

  it('当前 permissionMode=default 时高亮"变更前确认"卡片', async () => {
    checkAgentRuntimesMock.mockResolvedValue({ checkedAt: '', runtimes: [] });

    render(<AgentSettingsPanel />);

    await waitFor(() => expect(checkAgentRuntimesMock).toHaveBeenCalled());

    const confirmCard = screen.getByText('变更前确认').closest('button');
    expect(confirmCard?.className).toContain('border-[hsl(var(--primary)');
  });

  it('installedButBroken=true 时渲染"已安装但无法运行"文案', async () => {
    checkAgentRuntimesMock.mockResolvedValue({
      checkedAt: '',
      runtimes: [
        {
          agentKind: 'claude_code',
          label: 'Claude Code',
          command: 'claude',
          status: 'error',
          currentVersion: null,
          latestVersion: null,
          executablePath: '/usr/local/bin/claude',
          configPath: '/home/user/.claude/settings.json',
          npmPackage: '@anthropic-ai/claude-code',
          message: 'Node 版本过低，请升级到 18 以上再使用。',
          installedButBroken: true,
        },
      ],
    });

    render(<AgentSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText(/已安装但无法运行：Node 版本过低/)).toBeTruthy();
    });
    // 状态徽标仍为"异常"
    expect(screen.getByText('异常')).toBeTruthy();
  });

  it('installedButBroken=true 且 message 超过 120 字符时截断加省略号', async () => {
    const longMessage = 'A'.repeat(121);
    checkAgentRuntimesMock.mockResolvedValue({
      checkedAt: '',
      runtimes: [
        {
          agentKind: 'claude_code',
          label: 'Claude Code',
          command: 'claude',
          status: 'error',
          currentVersion: null,
          latestVersion: null,
          executablePath: '/usr/local/bin/claude',
          configPath: '/home/user/.claude/settings.json',
          npmPackage: '@anthropic-ai/claude-code',
          message: longMessage,
          installedButBroken: true,
        },
      ],
    });

    render(<AgentSettingsPanel />);

    const expected = `已安装但无法运行：${'A'.repeat(120)}…`;
    await waitFor(() => {
      expect(screen.getByText(expected)).toBeTruthy();
    });
  });

  it('installedButBroken=false 的 error 状态保持原有描述显示逻辑', async () => {
    checkAgentRuntimesMock.mockResolvedValue({
      checkedAt: '',
      runtimes: [
        {
          agentKind: 'claude_code',
          label: 'Claude Code',
          command: 'claude',
          status: 'error',
          currentVersion: null,
          latestVersion: null,
          executablePath: '/usr/local/bin/claude',
          configPath: null,
          npmPackage: '@anthropic-ai/claude-code',
          message: '检测过程中发生未知错误。',
          installedButBroken: false,
        },
      ],
    });

    render(<AgentSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText('Claude Code')).toBeTruthy();
    });
    // 不应出现"已安装但无法运行"前缀(保持原有 description ?? message 逻辑)
    expect(screen.queryByText(/已安装但无法运行/)).toBeNull();
  });

  it('installationReport 传入 ≥2 处安装时渲染安装列表与冲突标记', () => {
    const runtime: AgentRuntimeCheck = {
      agentKind: 'claude_code',
      label: 'Claude Code',
      command: 'claude',
      status: 'ok',
      currentVersion: '1.0.16',
      latestVersion: '1.0.16',
      executablePath: '/usr/local/bin/claude',
      configPath: '/home/user/.claude/settings.json',
      npmPackage: '@anthropic-ai/claude-code',
      message: 'Claude Code 已是最新版本（1.0.16）。',
      installedButBroken: false,
    };
    const report: AgentInstallationReport = {
      agentKind: 'claude_code',
      installs: [
        {
          path: '/usr/local/bin/claude',
          real: '/usr/local/bin/claude',
          version: '1.0.0',
          runnable: true,
          error: null,
          source: 'nvm',
          isPathDefault: true,
        },
        {
          path: '/opt/homebrew/bin/claude',
          real: '/opt/homebrew/bin/claude',
          version: '1.0.16',
          runnable: true,
          error: null,
          source: 'homebrew',
          isPathDefault: false,
        },
      ],
      isConflict: true,
      needsConfirmation: true,
      anchored: true,
      command: 'npm install -g @anthropic-ai/claude-code@latest',
    };

    render(
      <RuntimeCard
        runtime={runtime}
        isDefault={false}
        onSelectDefault={() => {}}
        onUpgrade={() => {}}
        upgrading={false}
        installationReport={report}
      />,
    );

    expect(screen.getByText('检测到 2 处安装')).toBeTruthy();
    // 冲突标记
    expect(screen.getByText(/版本冲突/)).toBeTruthy();
    // AgentInstallRow 列表:每行带一个"复制路径"按钮
    expect(screen.getAllByRole('button', { name: '复制路径' })).toHaveLength(2);
  });

  it('installationReport 为 undefined 时不渲染冲突占位', async () => {
    checkAgentRuntimesMock.mockResolvedValue({
      checkedAt: '',
      runtimes: [
        {
          agentKind: 'claude_code',
          label: 'Claude Code',
          command: 'claude',
          status: 'ok',
          currentVersion: '1.0.16',
          latestVersion: '1.0.16',
          executablePath: '/usr/local/bin/claude',
          configPath: '/home/user/.claude/settings.json',
          npmPackage: '@anthropic-ai/claude-code',
          message: 'Claude Code 已是最新版本（1.0.16）。',
          installedButBroken: false,
        },
      ],
    });

    render(<AgentSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText('Claude Code')).toBeTruthy();
    });

    expect(screen.queryByText(/检测到 \d+ 处安装/)).toBeNull();
  });

  it('加载时显示所有智能体骨架卡片', async () => {
    // checkAgentRuntimes 永不 resolve,保持加载态
    checkAgentRuntimesMock.mockReturnValue(new Promise(() => {}));

    render(<AgentSettingsPanel />);

    // 三个骨架卡片都显示"检测中"徽标
    await waitFor(() => {
      const skeletons = screen.getAllByText('检测中');
      expect(skeletons).toHaveLength(3);
    });
    // 骨架卡片显示智能体名称
    expect(screen.getByText('Claude Code')).toBeTruthy();
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.getByText('OpenCode')).toBeTruthy();
  });

  it('未安装时显示"安装"按钮', async () => {
    checkAgentRuntimesMock.mockResolvedValue({
      checkedAt: '',
      runtimes: [
        {
          agentKind: 'opencode',
          label: 'OpenCode',
          command: 'opencode',
          status: 'missing',
          currentVersion: null,
          latestVersion: null,
          executablePath: null,
          configPath: null,
          npmPackage: 'opencode-ai',
          message: '未在 PATH 中找到 OpenCode CLI。',
          installedButBroken: false,
        },
      ],
    });

    render(<AgentSettingsPanel />);

    const installButton = await screen.findByRole('button', { name: '安装' });
    expect(installButton).toBeTruthy();
    // 不应显示升级按钮
    expect(screen.queryByRole('button', { name: /升级到/ })).toBeNull();
  });

  it('点击"安装"按钮调用 upgradeAgentRuntime', async () => {
    checkAgentRuntimesMock.mockResolvedValue({
      checkedAt: '',
      runtimes: [
        {
          agentKind: 'opencode',
          label: 'OpenCode',
          command: 'opencode',
          status: 'missing',
          currentVersion: null,
          latestVersion: null,
          executablePath: null,
          configPath: null,
          npmPackage: 'opencode-ai',
          message: '未在 PATH 中找到 OpenCode CLI。',
          installedButBroken: false,
        },
      ],
    });
    upgradeAgentRuntimeMock.mockResolvedValue({
      agentKind: 'opencode',
      success: true,
      outcome: 'success',
      message: 'OpenCode 安装完成。',
      newVersion: '1.18.3',
    });

    render(<AgentSettingsPanel />);

    const installButton = await screen.findByRole('button', { name: '安装' });
    fireEvent.click(installButton);

    await waitFor(() => {
      expect(upgradeAgentRuntimeMock).toHaveBeenCalledWith('opencode');
    });
  });

  it('路径标签显示为"命令路径"且无复制/打开按钮', async () => {
    checkAgentRuntimesMock.mockResolvedValue({
      checkedAt: '',
      runtimes: [
        {
          agentKind: 'claude_code',
          label: 'Claude Code',
          command: 'claude',
          status: 'ok',
          currentVersion: '1.0.16',
          latestVersion: '1.0.16',
          executablePath: '/usr/local/bin/claude',
          configPath: '/home/user/.claude/settings.json',
          npmPackage: '@anthropic-ai/claude-code',
          message: 'Claude Code 已是最新版本（1.0.16）。',
          installedButBroken: false,
        },
      ],
    });

    render(<AgentSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText('命令路径')).toBeTruthy();
    });
    // 不应有复制/打开按钮(RuntimeInfoRow 已移除)
    expect(screen.queryByRole('button', { name: '复制' })).toBeNull();
    expect(screen.queryByRole('button', { name: '打开文件所在目录' })).toBeNull();
  });

  it('底部按钮:设为默认在左,升级在右', async () => {
    // Claude Code 可升级,非默认
    checkAgentRuntimesMock.mockResolvedValue({
      checkedAt: '',
      runtimes: [
        {
          agentKind: 'claude_code',
          label: 'Claude Code',
          command: 'claude',
          status: 'outdated',
          currentVersion: '1.0.0',
          latestVersion: '1.0.16',
          executablePath: '/usr/local/bin/claude',
          configPath: '/home/user/.claude/settings.json',
          npmPackage: '@anthropic-ai/claude-code',
          message: 'Claude Code 可升级。',
          installedButBroken: false,
        },
      ],
    });

    render(<AgentSettingsPanel />);

    const setDefaultBtn = await screen.findByRole('button', { name: '设为默认' });
    const upgradeBtn = await screen.findByRole('button', { name: /升级到/ });

    // 两个按钮在同一个 flex 容器内,设为默认在前(左),升级在后(右)
    const container = setDefaultBtn.parentElement?.parentElement;
    expect(container).toBeTruthy();
    const buttons = Array.from(container?.querySelectorAll('button') ?? []);
    expect(buttons[0]).toBe(setDefaultBtn);
    expect(buttons[buttons.length - 1]).toBe(upgradeBtn);
  });

  it('Claude Code 默认权限区块在本地代理路由区块之前', async () => {
    checkAgentRuntimesMock.mockResolvedValue({ checkedAt: '', runtimes: [] });

    render(<AgentSettingsPanel />);

    await waitFor(() => expect(checkAgentRuntimesMock).toHaveBeenCalled());

    const headings = screen.getAllByRole('heading', { level: 3 });
    const claudePermissionIdx = headings.findIndex((h) => h.textContent === 'Claude Code 默认权限');
    const proxyRouteIdx = headings.findIndex((h) => h.textContent === '本地代理路由');

    expect(claudePermissionIdx).toBeGreaterThanOrEqual(0);
    expect(proxyRouteIdx).toBeGreaterThanOrEqual(0);
    expect(claudePermissionIdx).toBeLessThan(proxyRouteIdx);
  });

  // ---- Task 10: 升级流程接入确认对话框与补诊 ----

  it('升级时检测到多处安装(needsConfirmation=true)弹出确认对话框', async () => {
    checkAgentRuntimesMock.mockResolvedValue({ checkedAt: '', runtimes: [outdatedCodexRuntime] });
    probeAgentInstallationsMock.mockResolvedValue(multiInstallReport);

    render(<AgentSettingsPanel />);

    const upgradeButton = await screen.findByRole('button', { name: /升级到 0\.140\.0/ });
    fireEvent.click(upgradeButton);

    // 确认对话框渲染,含"确认升级"按钮
    expect(await screen.findByRole('button', { name: '确认升级' })).toBeTruthy();
    // 不应直接调用 upgradeAgentRuntime
    expect(upgradeAgentRuntimeMock).not.toHaveBeenCalled();
  });

  it('点击"确认升级"后调用 upgradeAgentRuntime', async () => {
    checkAgentRuntimesMock.mockResolvedValue({ checkedAt: '', runtimes: [outdatedCodexRuntime] });
    probeAgentInstallationsMock.mockResolvedValue(multiInstallReport);
    upgradeAgentRuntimeMock.mockResolvedValue({
      agentKind: 'codex',
      success: true,
      outcome: 'success',
      message: 'Codex 升级完成。',
      newVersion: '0.140.0',
    });

    render(<AgentSettingsPanel />);

    const upgradeButton = await screen.findByRole('button', { name: /升级到 0\.140\.0/ });
    fireEvent.click(upgradeButton);

    const confirmButton = await screen.findByRole('button', { name: '确认升级' });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(upgradeAgentRuntimeMock).toHaveBeenCalledWith('codex');
    });
  });

  it('点击"取消"不调用 upgradeAgentRuntime 并清除升级锁定', async () => {
    checkAgentRuntimesMock.mockResolvedValue({ checkedAt: '', runtimes: [outdatedCodexRuntime] });
    probeAgentInstallationsMock.mockResolvedValue(multiInstallReport);

    render(<AgentSettingsPanel />);

    const upgradeButton = await screen.findByRole('button', { name: /升级到 0\.140\.0/ });
    fireEvent.click(upgradeButton);

    const cancelButton = await screen.findByRole('button', { name: '取消' });
    fireEvent.click(cancelButton);

    // 不调用 upgradeAgentRuntime
    expect(upgradeAgentRuntimeMock).not.toHaveBeenCalled();
    // 对话框关闭
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '确认升级' })).toBeNull();
    });
    // 升级锁定解除:升级按钮重新可用
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /升级到 0\.140\.0/ }).disabled).toBe(false);
    });
  });

  it('needsConfirmation=false 时直接调用 upgradeAgentRuntime 不弹窗', async () => {
    checkAgentRuntimesMock.mockResolvedValue({ checkedAt: '', runtimes: [outdatedCodexRuntime] });
    probeAgentInstallationsMock.mockResolvedValue(singleInstallReport);
    upgradeAgentRuntimeMock.mockResolvedValue({
      agentKind: 'codex',
      success: true,
      outcome: 'success',
      message: 'Codex 升级完成。',
      newVersion: '0.140.0',
    });

    render(<AgentSettingsPanel />);

    const upgradeButton = await screen.findByRole('button', { name: /升级到 0\.140\.0/ });
    fireEvent.click(upgradeButton);

    await waitFor(() => {
      expect(upgradeAgentRuntimeMock).toHaveBeenCalledWith('codex');
    });
    // 不弹确认对话框
    expect(screen.queryByRole('button', { name: '确认升级' })).toBeNull();
  });

  it('升级完成后自动调用 probeAgentInstallations 补诊', async () => {
    checkAgentRuntimesMock.mockResolvedValue({ checkedAt: '', runtimes: [outdatedCodexRuntime] });
    probeAgentInstallationsMock.mockResolvedValue(singleInstallReport);
    upgradeAgentRuntimeMock.mockResolvedValue({
      agentKind: 'codex',
      success: true,
      outcome: 'success',
      message: 'Codex 升级完成。',
      newVersion: '0.140.0',
    });

    render(<AgentSettingsPanel />);

    const upgradeButton = await screen.findByRole('button', { name: /升级到 0\.140\.0/ });
    fireEvent.click(upgradeButton);

    // probeAgentInstallations 调用 2 次:1x 升级前检测 + 1x 升级后补诊
    await waitFor(() => {
      expect(probeAgentInstallationsMock).toHaveBeenCalledTimes(2);
    });
  });

  it('补诊结果有冲突时在卡片下方渲染 AgentInstallRow 列表', async () => {
    checkAgentRuntimesMock.mockResolvedValue({ checkedAt: '', runtimes: [outdatedCodexRuntime] });
    // 第一次(升级前):单处安装,无需确认
    // 第二次(补诊):两处安装,有冲突
    probeAgentInstallationsMock
      .mockResolvedValueOnce(singleInstallReport)
      .mockResolvedValueOnce(multiInstallReport);
    upgradeAgentRuntimeMock.mockResolvedValue({
      agentKind: 'codex',
      success: true,
      outcome: 'success',
      message: 'Codex 升级完成。',
      newVersion: '0.140.0',
    });

    render(<AgentSettingsPanel />);

    const upgradeButton = await screen.findByRole('button', { name: /升级到 0\.140\.0/ });
    fireEvent.click(upgradeButton);

    // 补诊后渲染冲突列表
    await waitFor(() => {
      expect(screen.getByText('检测到 2 处安装')).toBeTruthy();
    });
    expect(screen.getByText(/版本冲突/)).toBeTruthy();
    // AgentInstallRow 列表:2 个复制路径按钮
    expect(screen.getAllByRole('button', { name: '复制路径' })).toHaveLength(2);
  });

  // ---- Task 11: toast 分级展示 ----

  it('outcome=success 时展示 success toast 含版本号', async () => {
    checkAgentRuntimesMock.mockResolvedValue({ checkedAt: '', runtimes: [outdatedCodexRuntime] });
    probeAgentInstallationsMock.mockResolvedValue(singleInstallReport);
    upgradeAgentRuntimeMock.mockResolvedValue({
      agentKind: 'codex',
      success: true,
      outcome: 'success',
      message: 'Codex 升级完成。',
      newVersion: '0.140.0',
    });

    render(<AgentSettingsPanel />);

    const upgradeButton = await screen.findByRole('button', { name: /升级到 0\.140\.0/ });
    fireEvent.click(upgradeButton);

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('升级成功,当前版本:0.140.0', { id: 'toast-id' });
    });
  });

  it('outcome=hard_failure 时展示 error toast', async () => {
    checkAgentRuntimesMock.mockResolvedValue({ checkedAt: '', runtimes: [outdatedCodexRuntime] });
    probeAgentInstallationsMock.mockResolvedValue(singleInstallReport);
    upgradeAgentRuntimeMock.mockResolvedValue({
      agentKind: 'codex',
      success: false,
      outcome: 'hard_failure',
      message: '命令执行失败',
      newVersion: null,
    });

    render(<AgentSettingsPanel />);

    const upgradeButton = await screen.findByRole('button', { name: /升级到 0\.140\.0/ });
    fireEvent.click(upgradeButton);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('升级失败:命令执行失败', { id: 'toast-id' });
    });
  });

  it('outcome=soft_version_unchanged 时展示 warning toast', async () => {
    checkAgentRuntimesMock.mockResolvedValue({ checkedAt: '', runtimes: [outdatedCodexRuntime] });
    probeAgentInstallationsMock.mockResolvedValue(singleInstallReport);
    upgradeAgentRuntimeMock.mockResolvedValue({
      agentKind: 'codex',
      success: true,
      outcome: 'soft_version_unchanged',
      message: '版本未变',
      newVersion: '0.139.0',
    });

    render(<AgentSettingsPanel />);

    const upgradeButton = await screen.findByRole('button', { name: /升级到 0\.140\.0/ });
    fireEvent.click(upgradeButton);

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith(
        '命令已执行但版本未变,可能升级写入非默认位置,已自动诊断',
        { id: 'toast-id' },
      );
    });
  });
});
