import type { AgentKind } from '../types/session';

export type AgentExecutionMode = 'confirm_before_edit' | 'auto_edit' | 'plan' | 'full_access';
export type AgentPlanMode = 'off' | 'on';
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never';

export type ClaudePermissionConfig = {
  kind: 'claude_code';
  permissionMode: ClaudePermissionMode;
};

export type CodexPermissionConfig = {
  kind: 'codex';
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  networkAccessEnabled: boolean;
};

export type AgentPermissionConfig = ClaudePermissionConfig | CodexPermissionConfig;

const CLAUDE_PERMISSION_MODES: ClaudePermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
];

const CODEX_SANDBOX_MODES: CodexSandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];
const CODEX_APPROVAL_POLICIES: CodexApprovalPolicy[] = ['untrusted', 'on-request', 'never'];

// Shared default triplets — keep in sync with src-tauri/sidecar/src/agentPermissions.ts
const CODEX_DEFAULT_PERMISSIONS: Omit<CodexPermissionConfig, 'kind'> = {
  sandboxMode: 'danger-full-access',
  approvalPolicy: 'never',
  networkAccessEnabled: true,
};

const CODEX_PLAN_MODE_PERMISSIONS: Omit<CodexPermissionConfig, 'kind'> = {
  sandboxMode: 'read-only',
  approvalPolicy: 'never',
  networkAccessEnabled: false,
};

export function buildDefaultPermissionConfig(agentKind: AgentKind): AgentPermissionConfig {
  if (agentKind === 'codex') {
    return { kind: 'codex', ...CODEX_DEFAULT_PERMISSIONS };
  }

  return {
    kind: 'claude_code',
    permissionMode: 'default',
  };
}

export function mapExecutionModeToPermissionConfig(
  agentKind: AgentKind,
  executionMode: AgentExecutionMode,
): AgentPermissionConfig {
  if (agentKind === 'codex') {
    switch (executionMode) {
      case 'plan':
        return { kind: 'codex', ...CODEX_PLAN_MODE_PERMISSIONS };
      case 'full_access':
        return { kind: 'codex', ...CODEX_DEFAULT_PERMISSIONS };
      default:
        // auto_edit, confirm_before_edit, and any future modes fall back to defaults.
        // The Codex UI only exposes 'plan' and 'full_access'.
        return { kind: 'codex', ...CODEX_DEFAULT_PERMISSIONS };
    }
  }

  switch (executionMode) {
    case 'auto_edit':
      return { kind: 'claude_code', permissionMode: 'acceptEdits' };
    case 'plan':
      return { kind: 'claude_code', permissionMode: 'plan' };
    case 'full_access':
      return { kind: 'claude_code', permissionMode: 'bypassPermissions' };
    case 'confirm_before_edit':
    default:
      return buildDefaultPermissionConfig('claude_code');
  }
}

export function resolveEffectivePermissionConfig(
  agentKind: AgentKind,
  config: unknown,
  planMode: AgentPlanMode,
): AgentPermissionConfig {
  const normalized = serializePermissionConfig(agentKind, config);
  if (agentKind === 'codex' && planMode === 'on') {
    return { kind: 'codex', ...CODEX_PLAN_MODE_PERMISSIONS };
  }
  if (agentKind === 'claude_code' && planMode === 'on') {
    return {
      kind: 'claude_code',
      permissionMode: 'plan',
    };
  }
  return normalized;
}

export function serializePermissionConfig(agentKind: AgentKind, value: unknown): AgentPermissionConfig {
  const fallback = buildDefaultPermissionConfig(agentKind);
  if (!value || typeof value !== 'object') {
    return fallback;
  }

  const raw = value as Record<string, unknown>;
  if (agentKind === 'codex') {
    return {
      kind: 'codex',
      sandboxMode: isCodexSandboxMode(raw.sandboxMode) ? raw.sandboxMode : CODEX_DEFAULT_PERMISSIONS.sandboxMode,
      approvalPolicy: isCodexApprovalPolicy(raw.approvalPolicy) ? raw.approvalPolicy : CODEX_DEFAULT_PERMISSIONS.approvalPolicy,
      networkAccessEnabled: typeof raw.networkAccessEnabled === 'boolean' ? raw.networkAccessEnabled : CODEX_DEFAULT_PERMISSIONS.networkAccessEnabled,
    };
  }

  return {
    kind: 'claude_code',
    permissionMode: isClaudePermissionMode(raw.permissionMode) ? raw.permissionMode : 'default',
  };
}

function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return typeof value === 'string' && CLAUDE_PERMISSION_MODES.includes(value as ClaudePermissionMode);
}

function isCodexSandboxMode(value: unknown): value is CodexSandboxMode {
  return typeof value === 'string' && CODEX_SANDBOX_MODES.includes(value as CodexSandboxMode);
}

function isCodexApprovalPolicy(value: unknown): value is CodexApprovalPolicy {
  return typeof value === 'string' && CODEX_APPROVAL_POLICIES.includes(value as CodexApprovalPolicy);
}
