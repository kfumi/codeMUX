// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentPermissionSelector } from './AgentPermissionSelector';

const CODEX_FULL_ACCESS = {
  kind: 'codex',
  workflowMode: 'full-access',
  networkAccessEnabled: true,
} as const;

describe('AgentPermissionSelector', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows Claude Code options matching native permission modes', () => {
    const onPermissionConfigChange = vi.fn();
    const onPlanModeChange = vi.fn();

    render(
      <AgentPermissionSelector
        agentKind="claude_code"
        permissionConfig={{ kind: 'claude_code', permissionMode: 'default' }}
        planMode="off"
        onPermissionConfigChange={onPermissionConfigChange}
        onPlanModeChange={onPlanModeChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '变更前确认' }));

    expect(screen.getAllByText('变更前确认')).toHaveLength(2);
    expect(screen.getByText('自动编辑')).toBeTruthy();
    expect(screen.getByText('自动模式')).toBeTruthy();
    expect(screen.getByText('计划模式')).toBeTruthy();
    expect(screen.getByText('完全访问')).toBeTruthy();

    fireEvent.click(screen.getByText('计划模式'));

    expect(onPermissionConfigChange).toHaveBeenCalledWith({ kind: 'claude_code', permissionMode: 'plan' });
    expect(onPlanModeChange).toHaveBeenCalledWith('on');
  });

  it('selecting the Claude auto tier writes permissionMode auto', () => {
    const onPermissionConfigChange = vi.fn();
    const onPlanModeChange = vi.fn();

    render(
      <AgentPermissionSelector
        agentKind="claude_code"
        permissionConfig={{ kind: 'claude_code', permissionMode: 'default' }}
        planMode="off"
        onPermissionConfigChange={onPermissionConfigChange}
        onPlanModeChange={onPlanModeChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '变更前确认' }));
    fireEvent.click(screen.getByText('自动模式'));

    expect(onPermissionConfigChange).toHaveBeenCalledWith({ kind: 'claude_code', permissionMode: 'auto' });
  });

  it('reflects a stored auto permission as the selected auto tier', () => {
    render(
      <AgentPermissionSelector
        agentKind="claude_code"
        permissionConfig={{ kind: 'claude_code', permissionMode: 'auto' }}
        planMode="off"
        onPermissionConfigChange={vi.fn()}
        onPlanModeChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /自动模式/ }));

    const items = screen.getAllByRole('menuitemradio');
    const checked = items.find((item) => item.getAttribute('aria-checked') === 'true');
    expect(checked?.textContent).toContain('自动模式');
    expect(checked?.textContent).not.toContain('自动编辑');
  });

  it('shows the official three Codex approval tiers', () => {
    render(
      <AgentPermissionSelector
        agentKind="codex"
        permissionConfig={{ ...CODEX_FULL_ACCESS }}
        planMode="off"
        onPermissionConfigChange={vi.fn()}
        onPlanModeChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '完全访问' }));

    const items = screen.getAllByRole('menuitemradio');
    expect(items).toHaveLength(3);
    expect(screen.getByText('请求批准')).toBeTruthy();
    expect(screen.getByText('帮我批准')).toBeTruthy();
    expect(screen.getAllByText('完全访问')).toHaveLength(2);
    // read-only is no longer a standing entry; Claude/OpenCode-only entries
    // must not leak into Codex either.
    expect(screen.queryByText('只读模式')).toBeNull();
    expect(screen.queryByText('变更前确认')).toBeNull();
    expect(screen.queryByText('自动编辑')).toBeNull();
  });

  it('keeps a read-only exit hatch for sessions stored on the read-only tier', () => {
    const onPermissionConfigChange = vi.fn();

    render(
      <AgentPermissionSelector
        agentKind="codex"
        permissionConfig={{ kind: 'codex', workflowMode: 'read-only', networkAccessEnabled: false }}
        planMode="off"
        onPermissionConfigChange={onPermissionConfigChange}
        onPlanModeChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '只读模式' }));
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(4);
    expect(screen.getByText('请求批准')).toBeTruthy();

    fireEvent.click(screen.getAllByText('只读模式')[1]);
    expect(onPermissionConfigChange).toHaveBeenCalledWith({
      kind: 'codex',
      workflowMode: 'read-only',
      networkAccessEnabled: false,
    });
  });

  it('switches Codex between workflow tiers with distinct configs', () => {
    const onPermissionConfigChange = vi.fn();
    const onPlanModeChange = vi.fn();

    render(
      <AgentPermissionSelector
        agentKind="codex"
        permissionConfig={{ ...CODEX_FULL_ACCESS }}
        planMode="off"
        onPermissionConfigChange={onPermissionConfigChange}
        onPlanModeChange={onPlanModeChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '完全访问' }));
    fireEvent.click(screen.getByText('请求批准'));
    expect(onPermissionConfigChange).toHaveBeenCalledWith({
      kind: 'codex',
      workflowMode: 'auto',
      networkAccessEnabled: true,
    });
    expect(onPlanModeChange).toHaveBeenCalledWith('off');

    // The uncontrolled trigger keeps reflecting the (unchanged) prop config.
    fireEvent.click(screen.getByRole('button', { name: '完全访问' }));
    fireEvent.click(screen.getByText('帮我批准'));
    expect(onPermissionConfigChange).toHaveBeenLastCalledWith({
      kind: 'codex',
      workflowMode: 'auto-review',
      networkAccessEnabled: true,
    });
    expect(onPlanModeChange).toHaveBeenLastCalledWith('off');
  });

  it('keeps showing the stored workflow tier while plan mode is on (orthogonal)', () => {
    const onPermissionConfigChange = vi.fn();
    const onPlanModeChange = vi.fn();

    render(
      <AgentPermissionSelector
        agentKind="codex"
        permissionConfig={{
          kind: 'codex',
          workflowMode: 'read-only',
          networkAccessEnabled: false,
        }}
        planMode="on"
        onPermissionConfigChange={onPermissionConfigChange}
        onPlanModeChange={onPlanModeChange}
      />,
    );

    // The selector mirrors the tier snapshot, never the plan toggle; the plan
    // entry lives in the composer add menu, not here.
    expect(screen.getByRole('button', { name: '只读模式' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '只读模式' }));
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(4);
    expect(screen.queryByText('计划模式')).toBeNull();

    // Switching tiers preserves the orthogonal plan state (ADR 0010).
    fireEvent.click(screen.getByText('请求批准'));
    expect(onPermissionConfigChange).toHaveBeenCalledWith({
      kind: 'codex',
      workflowMode: 'auto',
      networkAccessEnabled: true,
    });
    expect(onPlanModeChange).toHaveBeenCalledWith('on');
  });

  it('shows pi approval tiers without a plan entry and writes pi configs', () => {
    const onPermissionConfigChange = vi.fn();
    const onPlanModeChange = vi.fn();

    render(
      <AgentPermissionSelector
        agentKind="pi"
        permissionConfig={{ kind: 'pi', executionMode: 'confirm_before_edit' }}
        planMode="off"
        onPermissionConfigChange={onPermissionConfigChange}
        onPlanModeChange={onPlanModeChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '变更前确认' }));

    expect(screen.getByText('自动编辑')).toBeTruthy();
    expect(screen.getByText('完全访问')).toBeTruthy();
    // pi 无原生 plan 档，不出现计划模式入口。
    expect(screen.queryByText('计划模式')).toBeNull();

    fireEvent.click(screen.getByText('完全访问'));
    expect(onPermissionConfigChange).toHaveBeenCalledWith({ kind: 'pi', executionMode: 'full_access' });
  });

  it('migrates legacy claude snapshots stored for pi sessions onto the safe default', () => {
    render(
      <AgentPermissionSelector
        agentKind="pi"
        permissionConfig={{ kind: 'claude_code', permissionMode: 'bypassPermissions' } as never}
        planMode="off"
        onPermissionConfigChange={vi.fn()}
        onPlanModeChange={vi.fn()}
      />,
    );

    // 序列化迁移后选中态是确认档（defaultSelected 变更前确认）。
    expect(screen.getAllByText('变更前确认').length).toBeGreaterThan(0);
  });

  it('prefers onModeChange over separate callbacks when switching Codex modes', () => {
    const onPermissionConfigChange = vi.fn();
    const onPlanModeChange = vi.fn();
    const onModeChange = vi.fn();

    render(
      <AgentPermissionSelector
        agentKind="codex"
        permissionConfig={{ ...CODEX_FULL_ACCESS }}
        planMode="off"
        onPermissionConfigChange={onPermissionConfigChange}
        onPlanModeChange={onPlanModeChange}
        onModeChange={onModeChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '完全访问' }));
    fireEvent.click(screen.getByText('请求批准'));

    expect(onModeChange).toHaveBeenCalledWith(
      { kind: 'codex', workflowMode: 'auto', networkAccessEnabled: true },
      'off',
    );
    expect(onPermissionConfigChange).not.toHaveBeenCalled();
    expect(onPlanModeChange).not.toHaveBeenCalled();
  });

  it('migrates legacy sandbox-mode Codex configs onto workflow tiers', () => {
    render(
      <AgentPermissionSelector
        agentKind="codex"
        // Legacy snapshot shape persisted by the SDK-era UI.
        permissionConfig={{
          kind: 'codex',
          sandboxMode: 'workspace-write',
          approvalPolicy: 'on-request',
          networkAccessEnabled: false,
        } as never}
        planMode="off"
        onPermissionConfigChange={vi.fn()}
        onPlanModeChange={vi.fn()}
      />,
    );

    // workspace-write migrates to the auto workflow tier.
    expect(screen.getByRole('button', { name: '请求批准' })).toBeTruthy();
  });

  it('shows OpenCode build and plan agent modes without exposing Claude modes', () => {
    const onPermissionConfigChange = vi.fn();
    const onPlanModeChange = vi.fn();

    render(
      <AgentPermissionSelector
        agentKind="opencode"
        permissionConfig={{ kind: 'opencode', autoApprovePermissions: false }}
        planMode="off"
        onPermissionConfigChange={onPermissionConfigChange}
        onPlanModeChange={onPlanModeChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '构建模式' }));

    expect(screen.getAllByText('构建模式')).toHaveLength(2);
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(2);
    expect(screen.getByText('计划模式')).toBeTruthy();
    expect(screen.queryByText('完全访问')).toBeNull();
    expect(screen.queryByText('自动编辑')).toBeNull();
    expect(screen.queryByText('变更前确认')).toBeNull();

    fireEvent.click(screen.getByText('计划模式'));
    // Build/Plan only flips plan_mode; the shield snapshot is preserved.
    expect(onPermissionConfigChange).toHaveBeenCalledWith({ kind: 'opencode', autoApprovePermissions: false });
    expect(onPlanModeChange).toHaveBeenCalledWith('on');
  });

  it('migrates legacy OpenCode full-access snapshots onto the build mode', () => {
    render(
      <AgentPermissionSelector
        agentKind="opencode"
        permissionConfig={{ kind: 'opencode', permissionMode: 'full_access' } as never}
        planMode="off"
        onPermissionConfigChange={vi.fn()}
        onPlanModeChange={vi.fn()}
      />,
    );

    // Legacy snapshots serialize onto the conservative default (shield off)
    // and the chip reflects the official build/plan selector instead.
    expect(screen.getByRole('button', { name: '构建模式' })).toBeTruthy();
  });

  it('toggles the OpenCode auto-approve shield without touching plan mode', () => {
    const onPermissionConfigChange = vi.fn();
    const onPlanModeChange = vi.fn();
    const onModeChange = vi.fn();

    const { rerender } = render(
      <AgentPermissionSelector
        agentKind="opencode"
        permissionConfig={{ kind: 'opencode', autoApprovePermissions: false }}
        planMode="off"
        onPermissionConfigChange={onPermissionConfigChange}
        onPlanModeChange={onPlanModeChange}
        onModeChange={onModeChange}
      />,
    );

    fireEvent.click(screen.getByTestId('opencode-auto-approve-toggle'));
    expect(onModeChange).toHaveBeenCalledWith({ kind: 'opencode', autoApprovePermissions: true }, 'off');
    expect(onPermissionConfigChange).not.toHaveBeenCalled();

    rerender(
      <AgentPermissionSelector
        agentKind="opencode"
        permissionConfig={{ kind: 'opencode', autoApprovePermissions: true }}
        planMode="off"
        onPermissionConfigChange={onPermissionConfigChange}
        onPlanModeChange={onPlanModeChange}
        onModeChange={onModeChange}
      />,
    );
    fireEvent.click(screen.getByTestId('opencode-auto-approve-toggle'));
    expect(onModeChange).toHaveBeenLastCalledWith({ kind: 'opencode', autoApprovePermissions: false }, 'off');
  });

  it('shows unknown native permission type and description without rewriting the raw values', () => {
    render(
      <AgentPermissionSelector
        agentKind="opencode"
        permissionConfig={{ kind: 'claude_code', permissionMode: 'default' }}
        planMode="off"
        rawPermissionType="external_device_access"
        rawPermissionDescription="OpenCode requests access to an external device."
        onPermissionConfigChange={vi.fn()}
        onPlanModeChange={vi.fn()}
      />,
    );

    expect(screen.getByText('external_device_access')).toBeTruthy();
    expect(screen.getByText('OpenCode requests access to an external device.')).toBeTruthy();
  });
});
