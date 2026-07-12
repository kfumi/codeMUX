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
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
    });
    expect(buildDefaultPermissionConfig('opencode')).toEqual({
      kind: 'opencode',
      permissionMode: 'full_access',
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

  it('keeps OpenCode on its single full-access compatibility mode', () => {
    expect(mapExecutionModeToPermissionConfig('opencode', 'confirm_before_edit')).toEqual({
      kind: 'opencode',
      permissionMode: 'full_access',
    });
    expect(mapExecutionModeToPermissionConfig('opencode', 'plan')).toEqual({
      kind: 'opencode',
      permissionMode: 'full_access',
    });
    expect(serializePermissionConfig('opencode', { kind: 'claude_code', permissionMode: 'default' })).toEqual({
      kind: 'opencode',
      permissionMode: 'full_access',
    });
  });

  it('maps unified execution presets to native Codex sandbox and approval settings', () => {
    expect(mapExecutionModeToPermissionConfig('codex', 'plan')).toEqual({
      kind: 'codex',
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
    });
    expect(mapExecutionModeToPermissionConfig('codex', 'confirm_before_edit')).toEqual({
      kind: 'codex',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
    });
    expect(mapExecutionModeToPermissionConfig('codex', 'full_access')).toEqual({
      kind: 'codex',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
    });
  });

  it('forces Codex plan mode to read-only approval settings', () => {
    const configured: AgentPermissionConfig = {
      kind: 'codex',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
    };

    expect(resolveEffectivePermissionConfig('codex', configured, 'on')).toEqual({
      kind: 'codex',
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
    });
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
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
    });
    expect(serializePermissionConfig('claude_code', null)).toEqual({
      kind: 'claude_code',
      permissionMode: 'default',
    });
  });
});
