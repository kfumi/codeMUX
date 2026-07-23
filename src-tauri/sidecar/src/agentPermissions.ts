export type AgentPlanMode = 'off' | 'on';
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never';

export type SidecarPermissionConfig =
  | { kind: 'claude_code'; permissionMode?: ClaudePermissionMode }
  | { kind: 'opencode'; permissionMode?: 'full_access' | 'plan' }
  | {
    kind: 'codex';
    sandboxMode?: CodexSandboxMode;
    approvalPolicy?: CodexApprovalPolicy;
    networkAccessEnabled?: boolean;
  };

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

// Shared default triplets — keep in sync with src/lib/agentPermissions.ts
const CODEX_DEFAULT_PERMISSIONS = {
  sandboxMode: 'danger-full-access' as CodexSandboxMode,
  approvalPolicy: 'never' as CodexApprovalPolicy,
  networkAccessEnabled: true,
};

const CODEX_PLAN_MODE_PERMISSIONS = {
  sandboxMode: 'read-only' as CodexSandboxMode,
  approvalPolicy: 'on-request' as CodexApprovalPolicy,
  networkAccessEnabled: false,
};

export function buildClaudePermissionOptions(config: unknown, planMode: AgentPlanMode = 'off'): {
  permissionMode: ClaudePermissionMode;
  allowDangerouslySkipPermissions: boolean;
} {
  const raw = isRecord(config) ? config : {};
  const permissionMode = planMode === 'on'
    ? 'plan'
    : isClaudePermissionMode(raw.permissionMode)
      ? raw.permissionMode
      : 'default';

  return {
    permissionMode,
    allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
  };
}

export function buildCodexThreadPermissionOptions(config: unknown, planMode: AgentPlanMode = 'off'): {
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  networkAccessEnabled: boolean;
} {
  if (planMode === 'on') {
    return { ...CODEX_PLAN_MODE_PERMISSIONS };
  }

  const raw = isRecord(config) ? config : {};
  return {
    sandboxMode: isCodexSandboxMode(raw.sandboxMode) ? raw.sandboxMode : CODEX_DEFAULT_PERMISSIONS.sandboxMode,
    approvalPolicy: isCodexApprovalPolicy(raw.approvalPolicy) ? raw.approvalPolicy : CODEX_DEFAULT_PERMISSIONS.approvalPolicy,
    networkAccessEnabled: typeof raw.networkAccessEnabled === 'boolean' ? raw.networkAccessEnabled : CODEX_DEFAULT_PERMISSIONS.networkAccessEnabled,
  };
}

export function describeCodexPermissionOptions(options: {
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  networkAccessEnabled: boolean;
}): string {
  return `${options.sandboxMode}/${options.approvalPolicy}/${options.networkAccessEnabled ? 'network-on' : 'network-off'}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
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
