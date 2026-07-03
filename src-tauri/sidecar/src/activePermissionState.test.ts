import { afterEach, describe, expect, it } from 'vitest';

import {
  clearActivePermissionState,
  resolveClaudeToolRuntimeDecision,
  setActivePermissionState,
} from './activePermissionState.js';

describe('activePermissionState', () => {
  afterEach(() => {
    clearActivePermissionState();
  });

  it('denies Claude write and command tools after switching to plan mode', () => {
    clearActivePermissionState();
    setActivePermissionState({
      sessionId: 'session-1',
      agentKind: 'claude_code',
      permissionConfig: { kind: 'claude_code', permissionMode: 'bypassPermissions' },
      planMode: 'on',
    });

    expect(resolveClaudeToolRuntimeDecision('Write', 'session-1')).toEqual({
      behavior: 'deny',
      effectiveMode: 'plan',
      reasonCode: 'plan_readonly_violation',
    });
    expect(resolveClaudeToolRuntimeDecision('Bash', 'session-1')).toMatchObject({
      behavior: 'deny',
      effectiveMode: 'plan',
    });
  });

  it('auto-allows Claude tools after switching to full access', () => {
    clearActivePermissionState();
    setActivePermissionState({
      sessionId: 'session-1',
      agentKind: 'claude_code',
      permissionConfig: { kind: 'claude_code', permissionMode: 'bypassPermissions' },
      planMode: 'off',
    });

    expect(resolveClaudeToolRuntimeDecision('Write', 'session-1')).toEqual({
      behavior: 'allow',
      effectiveMode: 'code',
      reasonCode: null,
    });
  });

  it('leaves default Claude tools on the existing approval path', () => {
    clearActivePermissionState();
    setActivePermissionState({
      sessionId: 'session-1',
      agentKind: 'claude_code',
      permissionConfig: { kind: 'claude_code', permissionMode: 'default' },
      planMode: 'off',
    });

    expect(resolveClaudeToolRuntimeDecision('Write', 'session-1')).toEqual({
      behavior: 'ask',
      effectiveMode: 'code',
      reasonCode: null,
    });
  });
});
