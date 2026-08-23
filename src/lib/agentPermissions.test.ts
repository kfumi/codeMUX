import { describe, expect, it } from 'vitest';

import {
  buildDefaultPermissionConfig,
  codexWorkflowModeToExecutionMode,
  isPlanApprovalPermission,
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
      workflowMode: 'auto',
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
    expect(mapExecutionModeToPermissionConfig('claude_code', 'auto_review')).toEqual({
      kind: 'claude_code',
      permissionMode: 'auto',
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

  it('maps OpenCode plan and full-access modes to the runtime contract', () => {
    expect(mapExecutionModeToPermissionConfig('opencode', 'confirm_before_edit')).toEqual({
      kind: 'opencode',
      permissionMode: 'full_access',
    });
    expect(mapExecutionModeToPermissionConfig('opencode', 'plan')).toEqual({
      kind: 'opencode',
      permissionMode: 'plan',
    });
    expect(serializePermissionConfig('opencode', { kind: 'claude_code', permissionMode: 'default' })).toEqual({
      kind: 'opencode',
      permissionMode: 'full_access',
    });
  });

  it('maps the four Codex workflow tiers to distinct permission configs', () => {
    expect(mapExecutionModeToPermissionConfig('codex', 'read_only')).toEqual({
      kind: 'codex',
      workflowMode: 'read-only',
      networkAccessEnabled: false,
    });
    expect(mapExecutionModeToPermissionConfig('codex', 'auto_edit')).toEqual({
      kind: 'codex',
      workflowMode: 'auto',
      networkAccessEnabled: true,
    });
    expect(mapExecutionModeToPermissionConfig('codex', 'auto_review')).toEqual({
      kind: 'codex',
      workflowMode: 'auto-review',
      networkAccessEnabled: true,
    });
    expect(mapExecutionModeToPermissionConfig('codex', 'full_access')).toEqual({
      kind: 'codex',
      workflowMode: 'full-access',
      networkAccessEnabled: true,
    });
  });

  it('keeps the Codex workflow tier when plan mode is on (plan is orthogonal)', () => {
    const configured: AgentPermissionConfig = {
      kind: 'codex',
      workflowMode: 'full-access',
      networkAccessEnabled: true,
    };

    expect(resolveEffectivePermissionConfig('codex', configured, 'on')).toEqual({
      kind: 'codex',
      workflowMode: 'full-access',
      networkAccessEnabled: true,
    });
  });

  it('migrates legacy Codex sandbox snapshots to workflow tiers', () => {
    expect(serializePermissionConfig('codex', { kind: 'codex', sandboxMode: 'read-only' })).toEqual({
      kind: 'codex',
      workflowMode: 'read-only',
      networkAccessEnabled: false,
    });
    expect(serializePermissionConfig('codex', { kind: 'codex', sandboxMode: 'workspace-write' })).toEqual({
      kind: 'codex',
      workflowMode: 'auto',
      networkAccessEnabled: true,
    });
    expect(serializePermissionConfig('codex', { kind: 'codex', sandboxMode: 'danger-full-access' })).toEqual({
      kind: 'codex',
      workflowMode: 'full-access',
      networkAccessEnabled: true,
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

  it('inverts the Codex workflow tiers back onto execution modes', () => {
    expect(codexWorkflowModeToExecutionMode('read-only')).toBe('read_only');
    expect(codexWorkflowModeToExecutionMode('auto')).toBe('auto_edit');
    expect(codexWorkflowModeToExecutionMode('auto-review')).toBe('auto_review');
    expect(codexWorkflowModeToExecutionMode('full-access')).toBe('full_access');
  });

  it('recognizes plan-approval permission requests across markers', () => {
    expect(isPlanApprovalPermission('plan_approval')).toBe(true);
    expect(isPlanApprovalPermission('ExitPlanMode')).toBe(true);
    expect(isPlanApprovalPermission(undefined, { presentation: 'plan-approval' })).toBe(true);
    expect(isPlanApprovalPermission('plan_approval', { presentation: 'plan-approval' })).toBe(true);
    expect(isPlanApprovalPermission('write', { presentation: 'plan-approval' })).toBe(true);

    expect(isPlanApprovalPermission('write')).toBe(false);
    expect(isPlanApprovalPermission(undefined)).toBe(false);
    expect(isPlanApprovalPermission('execute', { presentation: 'card' })).toBe(false);
    expect(isPlanApprovalPermission('write', {})).toBe(false);
  });

  it('serializes malformed or missing values to safe defaults', () => {
    expect(serializePermissionConfig('codex', { kind: 'codex', workflowMode: 'bad' })).toEqual({
      kind: 'codex',
      workflowMode: 'auto',
      networkAccessEnabled: true,
    });
    expect(serializePermissionConfig('claude_code', null)).toEqual({
      kind: 'claude_code',
      permissionMode: 'default',
    });
  });
});
