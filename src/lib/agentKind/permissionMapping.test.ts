/** 测试从 module 的公开 interface 取 plan 语义，不硬编码 kind 字符串。 */
import { describe, expect, it } from 'vitest';

import {
  applyTier,
  buildDefaultPermissionConfig,
  codexWorkflowModeToExecutionMode,
  isPlanApprovalPermission,
  mapExecutionModeToPermissionConfig,
  serializePermissionConfig,
  type AgentPermissionConfig,
} from './index';

describe('permission mapping', () => {
  it('uses safe defaults for each agent kind', () => {
    expect(buildDefaultPermissionConfig('pi')).toEqual({
      kind: 'pi',
      executionMode: 'confirm_before_edit',
    });
  });

  it('maps unified execution presets to pi approval tiers and migrates legacy snapshots', () => {
    expect(mapExecutionModeToPermissionConfig('pi', 'confirm_before_edit')).toEqual({
      kind: 'pi',
      executionMode: 'confirm_before_edit',
    });
    expect(mapExecutionModeToPermissionConfig('pi', 'auto_edit')).toEqual({
      kind: 'pi',
      executionMode: 'auto_edit',
    });
    expect(mapExecutionModeToPermissionConfig('pi', 'full_access')).toEqual({
      kind: 'pi',
      executionMode: 'full_access',
    });
    // plan 对 pi 不适用：落到确认档。
    expect(mapExecutionModeToPermissionConfig('pi', 'plan')).toEqual({
      kind: 'pi',
      executionMode: 'confirm_before_edit',
    });
    // pi kind 之前误存 claude_code 快照（选择器错位显示），统一迁移。
    expect(serializePermissionConfig('pi', { kind: 'claude_code', permissionMode: 'bypassPermissions' })).toEqual({
      kind: 'pi',
      executionMode: 'confirm_before_edit',
    });
    expect(serializePermissionConfig('pi', { kind: 'pi', executionMode: 'full_access' })).toEqual({
      kind: 'pi',
      executionMode: 'full_access',
    });
  });

  it('keeps other-kind defaults untouched', () => {
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
      autoApprovePermissions: false,
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

  it('keeps OpenCode build/plan orthogonal to the auto-approve shield', () => {
    // Build/Plan only drives plan_mode; the shield state survives mode switches.
    expect(mapExecutionModeToPermissionConfig('opencode', 'confirm_before_edit')).toEqual({
      kind: 'opencode',
      autoApprovePermissions: false,
    });
    expect(mapExecutionModeToPermissionConfig('opencode', 'plan')).toEqual({
      kind: 'opencode',
      autoApprovePermissions: false,
    });
    expect(mapExecutionModeToPermissionConfig('opencode', 'plan', { kind: 'opencode', autoApprovePermissions: true })).toEqual({
      kind: 'opencode',
      autoApprovePermissions: true,
    });
  });

  it('serializes OpenCode snapshots and migrates legacy permission modes', () => {
    expect(serializePermissionConfig('opencode', { kind: 'claude_code', permissionMode: 'default' })).toEqual({
      kind: 'opencode',
      autoApprovePermissions: false,
    });
    expect(serializePermissionConfig('opencode', { kind: 'opencode', autoApprovePermissions: true })).toEqual({
      kind: 'opencode',
      autoApprovePermissions: true,
    });
    // Legacy 'full_access' was a no-op (the server remained authoritative) and
    // 'plan' moved to the plan_mode column — both land on the safe default.
    expect(serializePermissionConfig('opencode', { kind: 'opencode', permissionMode: 'full_access' })).toEqual({
      kind: 'opencode',
      autoApprovePermissions: false,
    });
    expect(serializePermissionConfig('opencode', { kind: 'opencode', permissionMode: 'plan' })).toEqual({
      kind: 'opencode',
      autoApprovePermissions: false,
    });
    // The snapshot never carries plan; the orthogonal plan_mode column does.
    expect(applyTier(
      'opencode',
      'plan',
      { kind: 'opencode', autoApprovePermissions: true },
      'on',
    ).config).toEqual({ kind: 'opencode', autoApprovePermissions: true });
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

    expect(applyTier('codex', 'full_access', configured, 'on')).toEqual({
      config: {
        kind: 'codex',
        workflowMode: 'full-access',
        networkAccessEnabled: true,
      },
      // 正交：选档位不得把 plan 关掉。
      planMode: 'on',
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
      applyTier(
        'claude_code',
        'plan',
        { kind: 'claude_code', permissionMode: 'bypassPermissions' },
        'off',
      ),
    ).toEqual({
      config: {
        kind: 'claude_code',
        permissionMode: 'plan',
      },
      // Claude 的 plan 由档位承载：选 plan 档必须把 plan_mode 一起打开。
      planMode: 'on',
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
