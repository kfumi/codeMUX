import { afterEach, describe, expect, it } from 'vitest';

import {
  applyPermissionElevation,
  buildClaudeModeBlockedEvent,
  buildPermissionElevationResponse,
  clearActivePermissionState,
  getActivePermissionState,
  permissionGateFor,
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

  it('allows Claude to write plan files in plan mode', () => {
    clearActivePermissionState();
    setActivePermissionState({
      sessionId: 'session-1',
      agentKind: 'claude_code',
      permissionConfig: { kind: 'claude_code', permissionMode: 'bypassPermissions' },
      planMode: 'on',
    });

    // Plan files in .claude/plans/ should be allowed
    expect(resolveClaudeToolRuntimeDecision('Write', 'session-1', '.claude/plans/my-plan.md')).toEqual({
      behavior: 'allow',
      effectiveMode: 'plan',
      reasonCode: null,
    });

    // Non-plan files should still be denied
    expect(resolveClaudeToolRuntimeDecision('Write', 'session-1', 'src/index.ts')).toEqual({
      behavior: 'deny',
      effectiveMode: 'plan',
      reasonCode: 'plan_readonly_violation',
    });
  });

  it('builds and applies Claude edit elevation responses', () => {
    setActivePermissionState({
      sessionId: 'session-1',
      agentKind: 'claude_code',
      permissionConfig: { kind: 'claude_code', permissionMode: 'default' },
      planMode: 'off',
      updatedAt: 1,
    });

    const response = buildPermissionElevationResponse('claude_code');

    expect(response).toEqual({
      action: 'allow_and_elevate_permissions',
      permissionConfig: { kind: 'claude_code', permissionMode: 'acceptEdits' },
      planMode: 'off',
    });
    expect(applyPermissionElevation(response, { sessionId: 'session-1', agentKind: 'claude_code' })).toBe(true);
    expect(getActivePermissionState({ sessionId: 'session-1', agentKind: 'claude_code' })).toMatchObject({
      permissionConfig: { kind: 'claude_code', permissionMode: 'acceptEdits' },
      planMode: 'off',
      effectiveMode: 'code',
    });
    // acceptEdits mode is handled by the SDK via permissionMode — sidecar returns 'ask' to let the SDK decide
    expect(resolveClaudeToolRuntimeDecision('Write', 'session-1')).toEqual({
      behavior: 'ask',
      effectiveMode: 'code',
      reasonCode: null,
    });
    expect(resolveClaudeToolRuntimeDecision('Bash', 'session-1')).toEqual({
      behavior: 'ask',
      effectiveMode: 'code',
      reasonCode: null,
    });
  });

  it('builds and applies Codex full access elevation responses', () => {
    setActivePermissionState({
      sessionId: 'session-1',
      agentKind: 'codex',
      permissionConfig: { kind: 'codex', sandboxMode: 'read-only', approvalPolicy: 'on-request', networkAccessEnabled: false },
      planMode: 'on',
      updatedAt: 1,
    });

    const response = buildPermissionElevationResponse('codex');

    expect(response).toEqual({
      action: 'allow_and_elevate_permissions',
      permissionConfig: { kind: 'codex', sandboxMode: 'danger-full-access', approvalPolicy: 'never', networkAccessEnabled: true },
      planMode: 'off',
    });
    expect(applyPermissionElevation(response, { sessionId: 'session-1', agentKind: 'codex' })).toBe(true);
    expect(getActivePermissionState({ sessionId: 'session-1', agentKind: 'codex' })).toMatchObject({
      permissionConfig: { kind: 'codex', sandboxMode: 'danger-full-access', approvalPolicy: 'never', networkAccessEnabled: true },
      planMode: 'off',
      effectiveMode: 'code',
    });
  });
});

describe('permission gate attribution', () => {
  it('names each agent kind', () => {
    expect(permissionGateFor('claude_code').label).toBe('Claude Code 的权限门');
    expect(permissionGateFor('codex').label).toBe('Codex 的权限门');
    expect(permissionGateFor('gemini_cli').label).toBe('Gemini 的权限门');
    expect(permissionGateFor('opencode').label).toBe('OpenCode 的权限门');
    expect(permissionGateFor('pi').label).toBe('pi 的权限门');
  });

  it('falls back to claude for unknown kinds (与运行时回退一致)', () => {
    expect(permissionGateFor(undefined).agentKind).toBe('claude_code');
    expect(permissionGateFor('some-future-agent').agentKind).toBe('claude_code');
  });

  it('carries the attribution into the mode-blocked event', () => {
    const event = buildClaudeModeBlockedEvent({
      toolName: 'mcp__codemux-browser__browser_click',
      toolUseId: 'tool-1',
      effectiveMode: 'plan',
      reasonCode: 'permission_mode_blocked',
      gate: permissionGateFor('codex'),
    });
    expect(event.mode_blocked.gate_label).toBe('Codex 的权限门');
    expect(event.mode_blocked.gate_agent_kind).toBe('codex');
    expect(event.message).toContain('Codex 的权限门');
  });

  it('defaults to the claude gate when the caller passes none', () => {
    const event = buildClaudeModeBlockedEvent({
      toolName: 'Bash',
      effectiveMode: 'plan',
      reasonCode: 'permission_mode_blocked',
    });
    expect(event.mode_blocked.gate_label).toBe('Claude Code 的权限门');
  });
});
