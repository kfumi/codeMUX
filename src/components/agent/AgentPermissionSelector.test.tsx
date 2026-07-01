// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentPermissionSelector } from './AgentPermissionSelector';

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

    fireEvent.click(screen.getByTitle('变更前确认'));

    expect(screen.getAllByText('变更前确认')).toHaveLength(2);
    expect(screen.getByText('自动编辑')).toBeTruthy();
    expect(screen.getByText('计划模式')).toBeTruthy();
    expect(screen.getByText('完全访问')).toBeTruthy();

    fireEvent.click(screen.getByText('计划模式'));

    expect(onPermissionConfigChange).toHaveBeenCalledWith({ kind: 'claude_code', permissionMode: 'plan' });
    expect(onPlanModeChange).toHaveBeenCalledWith('on');
  });

  it('shows only Codex plan and full-access modes', () => {
    const onPermissionConfigChange = vi.fn();
    const onPlanModeChange = vi.fn();

    render(
      <AgentPermissionSelector
        agentKind="codex"
        permissionConfig={{
          kind: 'codex',
          sandboxMode: 'danger-full-access',
          approvalPolicy: 'never',
          networkAccessEnabled: true,
        }}
        planMode="on"
        onPermissionConfigChange={onPermissionConfigChange}
        onPlanModeChange={onPlanModeChange}
      />,
    );

    const triggerLabel = screen.getByText('计划模式');
    const triggerButton = triggerLabel.closest('button');

    expect(triggerButton).toBeTruthy();
    expect(triggerButton?.getAttribute('title')).toBe('计划模式');

    fireEvent.click(screen.getByTitle('计划模式'));

    expect(triggerButton?.textContent).toContain('计划模式');
    expect(screen.getAllByText('计划模式')).toHaveLength(2);
    expect(screen.getByText('完全访问')).toBeTruthy();
    expect(screen.queryByText('Codex 操作审批')).toBeNull();
    expect(screen.queryByText('请求批准')).toBeNull();
    expect(screen.queryByText('自动编辑')).toBeNull();

    const activeOption = screen.getAllByRole('menuitemradio').find((item) => item.getAttribute('aria-checked') === 'true');

    expect(activeOption).toBeTruthy();
    expect(activeOption?.textContent).toContain('计划模式');

    fireEvent.click(screen.getByText('完全访问'));

    expect(onPermissionConfigChange).toHaveBeenCalledWith({
      kind: 'codex',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
    });
    expect(onPlanModeChange).toHaveBeenCalledWith('off');
  });

  it('switches Codex to plan mode from full access', () => {
    const onPermissionConfigChange = vi.fn();
    const onPlanModeChange = vi.fn();

    render(
      <AgentPermissionSelector
        agentKind="codex"
        permissionConfig={{
          kind: 'codex',
          sandboxMode: 'danger-full-access',
          approvalPolicy: 'never',
          networkAccessEnabled: true,
        }}
        planMode="off"
        onPermissionConfigChange={onPermissionConfigChange}
        onPlanModeChange={onPlanModeChange}
      />,
    );

    fireEvent.click(screen.getByTitle('完全访问'));
    fireEvent.click(screen.getByText('计划模式'));

    expect(onPermissionConfigChange).toHaveBeenCalledWith({
      kind: 'codex',
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
    });
    expect(onPlanModeChange).toHaveBeenCalledWith('on');
  });

  it('prefers onModeChange over separate callbacks when switching Codex modes', () => {
    const onPermissionConfigChange = vi.fn();
    const onPlanModeChange = vi.fn();
    const onModeChange = vi.fn();

    render(
      <AgentPermissionSelector
        agentKind="codex"
        permissionConfig={{
          kind: 'codex',
          sandboxMode: 'danger-full-access',
          approvalPolicy: 'never',
          networkAccessEnabled: true,
        }}
        planMode="off"
        onPermissionConfigChange={onPermissionConfigChange}
        onPlanModeChange={onPlanModeChange}
        onModeChange={onModeChange}
      />,
    );

    fireEvent.click(screen.getByTitle('完全访问'));
    fireEvent.click(screen.getByText('计划模式'));

    expect(onModeChange).toHaveBeenCalledWith(
      { kind: 'codex', sandboxMode: 'read-only', approvalPolicy: 'on-request', networkAccessEnabled: false },
      'on',
    );
    expect(onPermissionConfigChange).not.toHaveBeenCalled();
    expect(onPlanModeChange).not.toHaveBeenCalled();
  });

  it('calls onLegacyConfigMigrate for legacy workspace-write Codex config', () => {
    const onLegacyConfigMigrate = vi.fn();

    render(
      <AgentPermissionSelector
        agentKind="codex"
        permissionConfig={{
          kind: 'codex',
          sandboxMode: 'workspace-write',
          approvalPolicy: 'on-request',
          networkAccessEnabled: false,
        }}
        planMode="off"
        onPermissionConfigChange={vi.fn()}
        onPlanModeChange={vi.fn()}
        onLegacyConfigMigrate={onLegacyConfigMigrate}
      />,
    );

    expect(onLegacyConfigMigrate).toHaveBeenCalledWith({
      kind: 'codex',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
    });
  });

  it('does not call onLegacyConfigMigrate when plan mode is active', () => {
    const onLegacyConfigMigrate = vi.fn();

    render(
      <AgentPermissionSelector
        agentKind="codex"
        permissionConfig={{
          kind: 'codex',
          sandboxMode: 'workspace-write',
          approvalPolicy: 'on-request',
          networkAccessEnabled: false,
        }}
        planMode="on"
        onPermissionConfigChange={vi.fn()}
        onPlanModeChange={vi.fn()}
        onLegacyConfigMigrate={onLegacyConfigMigrate}
      />,
    );

    expect(onLegacyConfigMigrate).not.toHaveBeenCalled();
  });
});
