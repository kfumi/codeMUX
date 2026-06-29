// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

  it('shows Codex plan mode as read-only without changing plan mode from the selector', () => {
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

    const triggerLabel = screen.getByText('计划只读');
    const triggerButton = triggerLabel.closest('button');

    expect(triggerButton).toBeTruthy();
    expect(triggerButton?.getAttribute('title')).toBe('计划只读');

    fireEvent.click(screen.getByTitle('计划只读'));

    expect(triggerButton?.textContent).toContain('计划只读');
    expect(screen.getByText('Codex 操作审批')).toBeTruthy();
    expect(screen.getByText('计划只读')).toBeTruthy();
    expect(screen.getByText('请求批准')).toBeTruthy();
    expect(screen.getByText('自动编辑')).toBeTruthy();
    expect(screen.getByText('完全访问')).toBeTruthy();

    const activeOption = screen.getAllByRole('menuitemradio').find((item) => item.getAttribute('aria-checked') === 'true');

    expect(activeOption).toBeTruthy();
    expect(activeOption?.textContent).toContain('完全访问');

    fireEvent.click(screen.getByText('自动编辑'));

    expect(onPermissionConfigChange).toHaveBeenCalledWith({
      kind: 'codex',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
    });
    expect(onPlanModeChange).not.toHaveBeenCalled();
  });
});
