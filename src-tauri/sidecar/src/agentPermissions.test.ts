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

  it('uses safe Codex defaults when no config is provided', () => {
    expect(buildCodexThreadPermissionOptions(undefined)).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
    });
  });

  it('forces Codex plan mode to read-only approval settings', () => {
    const config: SidecarPermissionConfig = {
      kind: 'codex',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
    };

    expect(buildCodexThreadPermissionOptions(config, 'on')).toEqual({
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
  });
});
