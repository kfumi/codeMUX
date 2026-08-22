export type AgentPlanMode = 'off' | 'on';
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never';
export type CodexWorkflowMode = 'read-only' | 'auto' | 'auto-review' | 'full-access';

export type SidecarPermissionConfig =
  | { kind: 'claude_code'; permissionMode?: ClaudePermissionMode }
  | { kind: 'opencode'; permissionMode?: 'full_access' | 'plan' }
  | {
    kind: 'codex';
    workflowMode?: CodexWorkflowMode;
    sandboxMode?: CodexSandboxMode;
    approvalPolicy?: CodexApprovalPolicy;
    networkAccessEnabled?: boolean;
  };

export type CodexTurnPolicy = {
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  networkAccessEnabled: boolean;
  /** Present only for the auto-review workflow tier. */
  approvalsReviewer?: 'auto_review';
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
const CODEX_WORKFLOW_MODES: CodexWorkflowMode[] = ['read-only', 'auto', 'auto-review', 'full-access'];

// Shared default triplets — keep in sync with src/lib/agentPermissions.ts
const CODEX_DEFAULT_PERMISSIONS = {
  workflowMode: 'full-access' as CodexWorkflowMode,
  sandboxMode: 'danger-full-access' as CodexSandboxMode,
  approvalPolicy: 'never' as CodexApprovalPolicy,
  networkAccessEnabled: true,
};

/**
 * Workflow Mode four-tier mapping (ADR 0010 / spec Implementation Decisions):
 *
 * | Workflow Mode | approvalPolicy | sandbox             | approvalsReviewer |
 * |---------------|----------------|---------------------|-------------------|
 * | read-only     | on-request     | read-only           | —                 |
 * | auto          | on-request     | workspace-write     | —                 |
 * | auto-review   | on-request     | workspace-write     | auto_review       |
 * | full-access   | never          | danger-full-access  | —                 |
 */
const CODEX_WORKFLOW_TIER_POLICIES: Record<CodexWorkflowMode, Omit<CodexTurnPolicy, 'networkAccessEnabled'>> = {
  'read-only': {
    sandboxMode: 'read-only',
    approvalPolicy: 'on-request',
  },
  auto: {
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-request',
  },
  'auto-review': {
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
  },
  'full-access': {
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
  },
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

/**
 * Resolves the turn policy for a Workflow Mode tier. Plan Mode is orthogonal
 * (ADR 0010 Decision 4): it only swaps the collaborationMode sent with
 * `turn/start`, never the sandbox/approval tier.
 */
export function buildCodexThreadPermissionOptions(config: unknown): CodexTurnPolicy {
  const raw = isRecord(config) ? config : {};
  const workflowMode = resolveCodexWorkflowMode(raw);
  const tier = CODEX_WORKFLOW_TIER_POLICIES[workflowMode];
  return {
    ...tier,
    networkAccessEnabled: typeof raw.networkAccessEnabled === 'boolean'
      ? raw.networkAccessEnabled
      : workflowMode === 'read-only' ? false : true,
  };
}

/**
 * Resolves the effective Workflow Mode tier from a permission config.
 * Prefers the explicit `workflowMode`; legacy snapshots that only carry the
 * raw sandbox/approval triple are migrated by sandbox mode.
 */
export function resolveCodexWorkflowMode(raw: Record<string, unknown>): CodexWorkflowMode {
  if (isCodexWorkflowMode(raw.workflowMode)) {
    return raw.workflowMode;
  }
  if (isCodexSandboxMode(raw.sandboxMode)) {
    if (raw.sandboxMode === 'read-only') return 'read-only';
    if (raw.sandboxMode === 'workspace-write') return 'auto';
    return 'full-access';
  }
  return CODEX_DEFAULT_PERMISSIONS.workflowMode;
}

export function describeCodexPermissionOptions(options: CodexTurnPolicy): string {
  const reviewer = options.approvalsReviewer ? `/${options.approvalsReviewer}` : '';
  return `${options.sandboxMode}/${options.approvalPolicy}${reviewer}/${options.networkAccessEnabled ? 'network-on' : 'network-off'}`;
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

function isCodexWorkflowMode(value: unknown): value is CodexWorkflowMode {
  return typeof value === 'string' && CODEX_WORKFLOW_MODES.includes(value as CodexWorkflowMode);
}
