import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const loggerErrorMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  Channel: class {
    onmessage?: (event: string) => void;
  },
}));

vi.mock('./logger', () => ({
  createLogger: () => ({
    error: loggerErrorMock,
    debug: vi.fn(),
  }),
  serializeError: (error: unknown) => error,
}));

describe('invokeLogged error reporting', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    loggerErrorMock.mockReset();
  });

  it('includes the original Tauri error in the log message and rethrows it', async () => {
    const failure = '默认模型必须属于档案的模型列表';
    invokeMock.mockRejectedValue(failure);
    const { configApi } = await import('./tauri');

    await expect(configApi.setTheme('System')).rejects.toBe(failure);

    expect(loggerErrorMock).toHaveBeenCalledWith(
      `Tauri command failed: ${failure}`,
      expect.objectContaining({ command: 'set_theme' }),
    );
  });
});
describe('appApi', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    loggerErrorMock.mockReset();
  });

  it('passes the log file name using Tauri command argument casing', async () => {
    invokeMock.mockResolvedValue('log contents');
    const { appApi } = await import('./tauri');

    await appApi.readLogFile('codemux.log');

    expect(invokeMock).toHaveBeenCalledWith('read_log_file', {
      fileName: 'codemux.log',
    });
  });

  it('checks the development environment without arguments', async () => {
    invokeMock.mockResolvedValue({ checkedAt: '2026-06-27T00:00:00Z', tools: [] });
    const { appApi } = await import('./tauri');

    await appApi.checkDevelopmentEnvironment();

    expect(invokeMock).toHaveBeenCalledWith('check_development_environment', undefined);
  });

  it('checks agent runtimes without arguments', async () => {
    invokeMock.mockResolvedValue({ checkedAt: '2026-07-25T00:00:00Z', runtimes: [] });
    const { appApi } = await import('./tauri');

    await appApi.checkAgentRuntimes();

    expect(invokeMock).toHaveBeenCalledWith('check_agent_runtimes', undefined);
  });

  it('upgrades an agent runtime with the agent kind argument', async () => {
    invokeMock.mockResolvedValue({
      agentKind: 'codex',
      success: true,
      message: 'Codex 升级完成。',
      newVersion: '0.140.0',
    });
    const { appApi } = await import('./tauri');

    await appApi.upgradeAgentRuntime('codex');

    expect(invokeMock).toHaveBeenCalledWith('upgrade_agent_runtime', { agentKind: 'codex' });
  });

  it('exposes installedButBroken on AgentRuntimeCheck results', async () => {
    invokeMock.mockResolvedValue({
      checkedAt: '2026-07-25T00:00:00Z',
      runtimes: [
        {
          agentKind: 'claude_code',
          label: 'Claude Code',
          command: 'claude',
          status: 'error',
          currentVersion: null,
          latestVersion: '1.0.16',
          executablePath: '/usr/local/bin/claude',
          configPath: null,
          npmPackage: '@anthropic-ai/claude-code',
          message: 'Claude Code 已安装但无法运行：error',
          installedButBroken: true,
        },
      ],
    });
    const { appApi } = await import('./tauri');

    const result = await appApi.checkAgentRuntimes();

    expect(invokeMock).toHaveBeenCalledWith('check_agent_runtimes', undefined);
    expect(result.runtimes[0].installedButBroken).toBe(true);
  });

  it('exposes outcome on AgentRuntimeUpgradeResult', async () => {
    invokeMock.mockResolvedValue({
      agentKind: 'codex',
      success: true,
      outcome: 'success',
      message: 'Codex 升级完成。',
      newVersion: '0.140.0',
    });
    const { appApi } = await import('./tauri');

    const result = await appApi.upgradeAgentRuntime('codex');

    expect(invokeMock).toHaveBeenCalledWith('upgrade_agent_runtime', { agentKind: 'codex' });
    expect(result.outcome).toBe('success');
  });

  it('probes agent installations with the agent kind argument', async () => {
    invokeMock.mockResolvedValue({
      agentKind: 'claude_code',
      installs: [],
      isConflict: false,
      needsConfirmation: false,
      anchored: false,
      command: null,
    });
    const { appApi } = await import('./tauri');

    await appApi.probeAgentInstallations('claude_code');

    expect(invokeMock).toHaveBeenCalledWith('probe_agent_installations', { agentKind: 'claude_code' });
  });
});

describe('gitApi', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    loggerErrorMock.mockReset();
  });

  it('requests staged and unstaged status changes with command argument casing', async () => {
    invokeMock.mockResolvedValue([]);
    const { gitApi } = await import('./tauri');

    await gitApi.getStatusChanges('D:/project/app', 'staged');

    expect(invokeMock).toHaveBeenCalledWith('get_git_status_changes', {
      projectPath: 'D:/project/app',
      area: 'staged',
    });
  });

  it('requests status change detail with command argument casing', async () => {
    invokeMock.mockResolvedValue({
      path: 'D:/project/app/src/main.ts',
      status: 'modified',
      originalContent: 'old',
      currentContent: 'new',
      additions: 1,
      deletions: 1,
    });
    const { gitApi } = await import('./tauri');

    await gitApi.getStatusChangeDetail('D:/project/app', 'unstaged', 'D:/project/app/src/main.ts');

    expect(invokeMock).toHaveBeenCalledWith('get_git_status_change_detail', {
      projectPath: 'D:/project/app',
      area: 'unstaged',
      filePath: 'D:/project/app/src/main.ts',
    });
  });

  it('maps branch and commit git commands with command argument casing', async () => {
    invokeMock.mockResolvedValue(undefined);
    const { gitApi } = await import('./tauri');

    await gitApi.getRepositoryState('D:/project/app');
    await gitApi.createBranch('D:/project/app', 'feature/git-panel', true);
    await gitApi.checkoutBranch('D:/project/app', 'feature/git-panel');
    await gitApi.revertStatusChanges('D:/project/app', 'unstaged', 'D:/project/app/src/App.tsx');
    await gitApi.commitChanges('D:/project/app', 'feat: add git panel');
    await gitApi.pushBranch('D:/project/app');
    await gitApi.generateCommitMessage('D:/project/app');

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'get_git_repository_state', {
      projectPath: 'D:/project/app',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'create_git_branch', {
      projectPath: 'D:/project/app',
      branchName: 'feature/git-panel',
      checkout: true,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'checkout_git_branch', {
      projectPath: 'D:/project/app',
      branchName: 'feature/git-panel',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'revert_git_status_changes', {
      projectPath: 'D:/project/app',
      area: 'unstaged',
      filePath: 'D:/project/app/src/App.tsx',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(5, 'commit_git_changes', {
      projectPath: 'D:/project/app',
      message: 'feat: add git panel',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(6, 'push_git_branch', {
      projectPath: 'D:/project/app',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(7, 'generate_git_commit_message', {
      projectPath: 'D:/project/app',
    });
  });
});

describe('terminalApi', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    loggerErrorMock.mockReset();
  });

  it('starts a terminal session with a channel and dimensions', async () => {
    invokeMock.mockResolvedValue('terminal-1');
    const { terminalApi } = await import('./tauri');

    const id = await terminalApi.start('D:/project/app', 120, 30, () => {});

    expect(id).toBe('terminal-1');
    expect(invokeMock).toHaveBeenCalledWith('start_terminal_session', expect.objectContaining({
      projectPath: 'D:/project/app',
      cols: 120,
      rows: 30,
      channel: expect.any(Object),
    }));
  });
});

describe('agentApi', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    loggerErrorMock.mockReset();
  });

  it('does not expose connection configuration through ensure_session', async () => {
    invokeMock.mockResolvedValue(undefined);
    const { agentApi } = await import('./tauri');

    await agentApi.ensureSession('session-1', 'D:/workspace', undefined, 'medium');

    const [, payload] = invokeMock.mock.calls[0];
    expect(payload).toMatchObject({ sessionId: 'session-1', cwd: 'D:/workspace', reasoningEffort: 'medium' });
    expect(payload).not.toHaveProperty('apiKey');
    expect(payload).not.toHaveProperty('baseUrl');
    expect(payload).not.toHaveProperty('model');
    expect(payload).not.toHaveProperty('provider');
    expect(payload).not.toHaveProperty('credentialSource');
    expect(payload).not.toHaveProperty('codexNeedsProxy');
  });

  it('does not expose connection configuration through start_session', async () => {
    invokeMock.mockResolvedValue(undefined);
    const { agentApi } = await import('./tauri');

    await agentApi.startSession('session-1', 'hello', 'D:/workspace', () => {}, 'medium', { text: 'hello' });

    const [, payload] = invokeMock.mock.calls[0];
    expect(payload).toMatchObject({ sessionId: 'session-1', prompt: 'hello', cwd: 'D:/workspace', reasoningEffort: 'medium' });
    expect(payload).not.toHaveProperty('apiKey');
    expect(payload).not.toHaveProperty('baseUrl');
    expect(payload).not.toHaveProperty('model');
    expect(payload).not.toHaveProperty('provider');
    expect(payload).not.toHaveProperty('credentialSource');
    expect(payload).not.toHaveProperty('codexNeedsProxy');
  });
  it('responds to an OpenCode permission with session and request identifiers', async () => {
    invokeMock.mockResolvedValue(undefined);
    const { agentApi } = await import('./tauri');

    await agentApi.respondToAgentPermission('session-1', 'permission-7', 'always');

    expect(invokeMock).toHaveBeenCalledWith('respond_to_agent_permission', {
      sessionId: 'session-1',
      requestId: 'permission-7',
      response: 'always',
    });
  });

  it('rewinds an agent session with app session id and agent kind', async () => {
    invokeMock.mockResolvedValue(undefined);
    const { agentApi } = await import('./tauri');

    await agentApi.rewindSession('session-1', 'codex');

    expect(invokeMock).toHaveBeenCalledWith('rewind_agent_session', {
      appSessionId: 'session-1',
      agentKind: 'codex',
    });
  });
});

describe('historyImportApi', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    loggerErrorMock.mockReset();
  });

  it('wraps import sessions request under the Tauri request argument', async () => {
    invokeMock.mockResolvedValue({
      sessions: [],
      importedCount: 0,
      refreshedCount: 0,
      skippedKeys: [],
      errors: [],
    });
    const { historyImportApi } = await import('./tauri');
    const request = {
      candidateKeys: ['codex:session-1'],
      projectId: null,
      refreshExisting: true,
      agentKind: 'codex' as const,
    };

    await historyImportApi.import(request);

    expect(invokeMock).toHaveBeenCalledWith('import_sessions', { request });
  });
});
