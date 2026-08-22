import { describe, expect, it } from 'vitest';

import {
  buildClaudePermissionOptions,
  buildCodexThreadPermissionOptions,
  describeCodexPermissionOptions,
  type SidecarPermissionConfig,
} from './agentPermissions.js';

describe('sidecar agent permissions', () => {
  it('does not force Claude bypass permissions by default', () => {
    expect(buildClaudePermissionOptions(undefined, 'off')).toEqual({
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
    });
  });

  it('maps Claude plan mode to the native plan permission mode', () => {
    expect(
      buildClaudePermissionOptions(
        { kind: 'claude_code', permissionMode: 'bypassPermissions' },
        'on',
      ),
    ).toEqual({
      permissionMode: 'plan',
      allowDangerouslySkipPermissions: false,
    });
  });

  it('only enables dangerous Claude skip flag for bypass permissions', () => {
    expect(
      buildClaudePermissionOptions(
        { kind: 'claude_code', permissionMode: 'bypassPermissions' },
        'off',
      ),
    ).toEqual({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
  });

  it('uses full-access Codex defaults when no config is provided', () => {
    expect(buildCodexThreadPermissionOptions(undefined)).toEqual({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
    });
  });

  it('maps the read-only workflow tier to a read-only sandbox with approvals', () => {
    const config: SidecarPermissionConfig = {
      kind: 'codex',
      workflowMode: 'read-only',
      networkAccessEnabled: false,
    };

    expect(buildCodexThreadPermissionOptions(config)).toEqual({
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
    });
  });

  it('maps the auto workflow tier to workspace-write with on-request approvals', () => {
    const config: SidecarPermissionConfig = {
      kind: 'codex',
      workflowMode: 'auto',
      networkAccessEnabled: true,
    };

    expect(buildCodexThreadPermissionOptions(config)).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      networkAccessEnabled: true,
    });
  });

  it('maps the auto-review workflow tier to workspace-write with the auto_review reviewer', () => {
    const config: SidecarPermissionConfig = {
      kind: 'codex',
      workflowMode: 'auto-review',
      networkAccessEnabled: true,
    };

    expect(buildCodexThreadPermissionOptions(config)).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      networkAccessEnabled: true,
    });
  });

  it('maps the full-access workflow tier to no approvals and full sandbox', () => {
    const config: SidecarPermissionConfig = {
      kind: 'codex',
      workflowMode: 'full-access',
      networkAccessEnabled: true,
    };

    expect(buildCodexThreadPermissionOptions(config)).toEqual({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
    });
  });

  it('migrates legacy sandbox-only snapshots onto workflow tiers', () => {
    expect(buildCodexThreadPermissionOptions({ kind: 'codex', sandboxMode: 'workspace-write' })).toMatchObject({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
    });
    expect(buildCodexThreadPermissionOptions({ kind: 'codex', sandboxMode: 'read-only' })).toMatchObject({
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
    });
    expect(buildCodexThreadPermissionOptions({ kind: 'codex', sandboxMode: 'danger-full-access' })).toMatchObject({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
    });
  });

  it('forces Codex plan mode to read-only approval settings', () => {
    const config: SidecarPermissionConfig = {
      kind: 'codex',
      workflowMode: 'full-access',
      networkAccessEnabled: true,
    };

    expect(buildCodexThreadPermissionOptions(config, 'on')).toEqual({
      workflowMode: 'read-only',
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
    });
  });

  it('describes effective Codex permission options for status logging', () => {
    expect(describeCodexPermissionOptions({
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
    })).toBe('read-only/on-request/network-off');
    expect(describeCodexPermissionOptions({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      networkAccessEnabled: true,
    })).toBe('workspace-write/on-request/auto_review/network-on');
  });
});
