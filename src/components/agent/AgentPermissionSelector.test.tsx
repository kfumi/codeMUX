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

  it('shows Codex approval options without changing plan mode', () => {
    const onPermissionConfigChange = vi.fn();
    const onPlanModeChange = vi.fn();

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
        onPermissionConfigChange={onPermissionConfigChange}
        onPlanModeChange={onPlanModeChange}
      />,
    );

    fireEvent.click(screen.getByTitle('请求批准'));

    expect(screen.getByText('应如何批准 Codex 操作?')).toBeTruthy();
    expect(screen.getAllByText('请求批准')).toHaveLength(2);
    expect(screen.getByText('替我审批')).toBeTruthy();
    expect(screen.getByText('完全访问权限')).toBeTruthy();

    fireEvent.click(screen.getByText('替我审批'));

    expect(onPermissionConfigChange).toHaveBeenCalledWith({
      kind: 'codex',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
    });
    expect(onPlanModeChange).not.toHaveBeenCalled();
  });
});
