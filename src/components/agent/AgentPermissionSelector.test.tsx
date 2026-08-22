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
    expect(screen.getByText('计划模式')).toBeTruthy();
    expect(screen.getByText('完全访问')).toBeTruthy();

    fireEvent.click(screen.getByText('计划模式'));

    expect(onPermissionConfigChange).toHaveBeenCalledWith({ kind: 'claude_code', permissionMode: 'plan' });
    expect(onPlanModeChange).toHaveBeenCalledWith('on');
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

    fireEvent.click(screen.getByRole('button', { name: '完全访问权限' }));

    const items = screen.getAllByRole('menuitemradio');
    expect(items).toHaveLength(3);
    expect(screen.getByText('请求批准')).toBeTruthy();
    expect(screen.getByText('帮我批准')).toBeTruthy();
    expect(screen.getAllByText('完全访问权限')).toHaveLength(2);
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

    fireEvent.click(screen.getByRole('button', { name: '完全访问权限' }));
    fireEvent.click(screen.getByText('请求批准'));
    expect(onPermissionConfigChange).toHaveBeenCalledWith({
      kind: 'codex',
      workflowMode: 'auto',
      networkAccessEnabled: true,
    });
    expect(onPlanModeChange).toHaveBeenCalledWith('off');

    // The uncontrolled trigger keeps reflecting the (unchanged) prop config.
    fireEvent.click(screen.getByRole('button', { name: '完全访问权限' }));
    fireEvent.click(screen.getByText('帮我批准'));
    expect(onPermissionConfigChange).toHaveBeenLastCalledWith({
      kind: 'codex',
      workflowMode: 'auto-review',
      networkAccessEnabled: true,
    });
    expect(onPlanModeChange).toHaveBeenLastCalledWith('off');
  });

  it('keeps the plan entry for legacy Codex plan-mode sessions without touching the tier', () => {
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

    const triggerButton = screen.getByRole('button', { name: '计划模式' });
    expect(triggerButton.getAttribute('aria-label')).toBe('计划模式');

    fireEvent.click(triggerButton);
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(5);

    // Issue 07: re-selecting plan only flips the toggle — the Workflow tier
    // snapshot is never rewritten (ADR 0010 orthogonality).
    fireEvent.click(screen.getAllByText('计划模式')[1]);
    expect(onPermissionConfigChange).not.toHaveBeenCalled();
    expect(onPlanModeChange).toHaveBeenCalledWith('on');
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

    fireEvent.click(screen.getByRole('button', { name: '完全访问权限' }));
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

  it('shows OpenCode plan and full-access modes without exposing Claude modes', () => {
    const onPermissionConfigChange = vi.fn();
    const onPlanModeChange = vi.fn();

    render(
      <AgentPermissionSelector
        agentKind="opencode"
        permissionConfig={{ kind: 'opencode', permissionMode: 'full_access' }}
        planMode="off"
        onPermissionConfigChange={onPermissionConfigChange}
        onPlanModeChange={onPlanModeChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '完全访问' }));

    expect(screen.getAllByText('完全访问')).toHaveLength(2);
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(2);
    expect(screen.getByText('计划模式')).toBeTruthy();
    expect(screen.queryByText('自动编辑')).toBeNull();
    expect(screen.queryByText('变更前确认')).toBeNull();

    fireEvent.click(screen.getAllByText('完全访问')[1]);
    expect(onPermissionConfigChange).toHaveBeenCalledWith({ kind: 'opencode', permissionMode: 'full_access' });
    expect(onPlanModeChange).toHaveBeenCalledWith('off');
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
