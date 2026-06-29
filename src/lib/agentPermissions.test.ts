import { describe, expect, it } from 'vitest';

import {
  buildDefaultPermissionConfig,
  mapExecutionModeToPermissionConfig,
  resolveEffectivePermissionConfig,
  serializePermissionConfig,
  type AgentPermissionConfig,
} from './agentPermissions';

describe('agentPermissions', () => {
  it('uses safe defaults for each agent kind', () => {
    expect(buildDefaultPermissionConfig('claude_code')).toEqual({
      kind: 'claude_code',
      permissionMode: 'default',
    });
    expect(buildDefaultPermissionConfig('codex')).toEqual({
      kind: 'codex',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
    });
  });

  it('maps unified execution presets to native Claude permissions', () => {
    expect(mapExecutionModeToPermissionConfig('claude_code', 'confirm_before_edit')).toEqual({
      kind: 'claude_code',
      permissionMode: 'default',
    });
    expect(mapExecutionModeToPermissionConfig('claude_code', 'auto_edit')).toEqual({
      kind: 'claude_code',
      permissionMode: 'acceptEdits',
    });
    expect(mapExecutionModeToPermissionConfig('claude_code', 'plan')).toEqual({
      kind: 'claude_code',
      permissionMode: 'plan',
    });
    expect(mapExecutionModeToPermissionConfig('claude_code', 'full_access')).toEqual({
      kind: 'claude_code',
      permissionMode: 'bypassPermissions',
    });
  });

  it('maps unified execution presets to native Codex sandbox and approval settings', () => {
    expect(mapExecutionModeToPermissionConfig('codex', 'confirm_before_edit')).toEqual({
      kind: 'codex',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
    });
    expect(mapExecutionModeToPermissionConfig('codex', 'auto_edit')).toEqual({
      kind: 'codex',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
    });
    expect(mapExecutionModeToPermissionConfig('codex', 'full_access')).toEqual({
      kind: 'codex',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
    });
  });

  it('keeps Codex plan mode separate from sandbox and approval', () => {
    const configured: AgentPermissionConfig = {
      kind: 'codex',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
    };

    expect(resolveEffectivePermissionConfig('codex', configured, 'on')).toEqual(configured);
  });

  it('maps Claude plan mode onto the native plan permission mode', () => {
    expect(
      resolveEffectivePermissionConfig(
        'claude_code',
        { kind: 'claude_code', permissionMode: 'bypassPermissions' },
        'on',
      ),
    ).toEqual({
      kind: 'claude_code',
      permissionMode: 'plan',
    });
  });

  it('serializes malformed or missing values to safe defaults', () => {
    expect(serializePermissionConfig('codex', { kind: 'codex', sandboxMode: 'bad' })).toEqual({
      kind: 'codex',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
    });
    expect(serializePermissionConfig('claude_code', null)).toEqual({
      kind: 'claude_code',
      permissionMode: 'default',
    });
  });
});
