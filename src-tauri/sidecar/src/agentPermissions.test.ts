import { describe, expect, it } from 'vitest';

import {
  buildClaudePermissionOptions,
  buildCodexThreadPermissionOptions,
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

  it('keeps Codex plan mode from changing sandbox or approval settings', () => {
    const config: SidecarPermissionConfig = {
      kind: 'codex',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
    };

    expect(buildCodexThreadPermissionOptions(config, 'on')).toEqual({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
    });
  });
});
