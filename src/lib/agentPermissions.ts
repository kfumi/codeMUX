import type { AgentKind } from '../types/session';

export type AgentExecutionMode = 'confirm_before_edit' | 'auto_edit' | 'plan' | 'full_access' | 'read_only' | 'auto_review';
export type AgentPlanMode = 'off' | 'on';
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
export type CodexWorkflowMode = 'read-only' | 'auto' | 'auto-review' | 'full-access';
export type OpenCodePermissionMode = 'full_access' | 'plan';

export type ClaudePermissionConfig = {
  kind: 'claude_code';
  permissionMode: ClaudePermissionMode;
};

export type CodexPermissionConfig = {
  kind: 'codex';
  workflowMode: CodexWorkflowMode;
  networkAccessEnabled: boolean;
};

export type OpenCodePermissionConfig = {
  kind: 'opencode';
  permissionMode: OpenCodePermissionMode;
};

export type AgentPermissionConfig = ClaudePermissionConfig | CodexPermissionConfig | OpenCodePermissionConfig;

const CLAUDE_PERMISSION_MODES: ClaudePermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
];

const CODEX_WORKFLOW_MODES: CodexWorkflowMode[] = ['read-only', 'auto', 'auto-review', 'full-access'];

// Shared defaults — keep in sync with src-tauri/sidecar/src/agentPermissions.ts.
// Default tier mirrors the official ChatGPT Codex App's conservative
// 「请求批准」selector entry (workspace-write + on-request).
const CODEX_DEFAULT_PERMISSIONS: Omit<CodexPermissionConfig, 'kind'> = {
  workflowMode: 'auto',
  networkAccessEnabled: true,
};

export function buildDefaultPermissionConfig(agentKind: AgentKind): AgentPermissionConfig {
  if (agentKind === 'opencode') {
    return { kind: 'opencode', permissionMode: 'full_access' };
  }

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
  if (agentKind === 'opencode') {
    switch (executionMode) {
      case 'plan':
        return { kind: 'opencode', permissionMode: 'plan' };
      case 'full_access':
      default:
        return { kind: 'opencode', permissionMode: 'full_access' };
    }
  }

  if (agentKind === 'codex') {
    switch (executionMode) {
      case 'read_only':
        return { kind: 'codex', workflowMode: 'read-only', networkAccessEnabled: false };
      case 'auto_edit':
        return { kind: 'codex', workflowMode: 'auto', networkAccessEnabled: true };
      case 'auto_review':
        return { kind: 'codex', workflowMode: 'auto-review', networkAccessEnabled: true };
      case 'full_access':
      default:
        // Explicit tier — do NOT spread CODEX_DEFAULT_PERMISSIONS here: the
        // default is the conservative 「请求批准」tier, not 完全访问. 'plan'
        // never reaches this branch either — Codex Plan Mode is an orthogonal
        // toggle (ADR 0010) and callers flip it without touching the tier.
        return { kind: 'codex', workflowMode: 'full-access', networkAccessEnabled: true };
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

/**
 * Maps a Codex Workflow Mode tier onto the shared execution-mode enum.
 * Inverse of the Codex branch in {@link mapExecutionModeToPermissionConfig};
 * plan mode stays orthogonal (ADR 0010) and is applied by callers.
 */
export function codexWorkflowModeToExecutionMode(workflowMode: CodexWorkflowMode): AgentExecutionMode {
  switch (workflowMode) {
    case 'read-only':
      return 'read_only';
    case 'auto':
      return 'auto_edit';
    case 'auto-review':
      return 'auto_review';
    case 'full-access':
    default:
      return 'full_access';
  }
}

/** Permission types that carry an implementation plan awaiting user approval (Claude ExitPlanMode / Codex plan_approval). */
const PLAN_APPROVAL_PERMISSION_TYPES = new Set(['plan_approval', 'ExitPlanMode']);

/**
 * Shared plan-approval predicate for permission_requested events.
 * Recognizes the Codex `plan_approval` permission type, Claude Code's
 * `ExitPlanMode`, and the `plan-approval` presentation marker on metadata.
 */
export function isPlanApprovalPermission(
  permissionType: string | undefined | null,
  metadata?: Record<string, unknown> | null,
): boolean {
  return Boolean(permissionType && PLAN_APPROVAL_PERMISSION_TYPES.has(permissionType))
    || metadata?.presentation === 'plan-approval';
}

export function resolveEffectivePermissionConfig(
  agentKind: AgentKind,
  config: unknown,
  planMode: AgentPlanMode,
): AgentPermissionConfig {
  const normalized = serializePermissionConfig(agentKind, config);
  if (agentKind === 'opencode') {
    if (planMode === 'on') {
      return { kind: 'opencode', permissionMode: 'plan' };
    }
    return { kind: 'opencode', permissionMode: 'full_access' };
  }
  if (agentKind === 'claude_code' && planMode === 'on') {
    return {
      kind: 'claude_code',
      permissionMode: 'plan',
    };
  }
  // Codex: plan mode is orthogonal — the Workflow tier snapshot stands.
  return normalized;
}

export function serializePermissionConfig(agentKind: AgentKind, value: unknown): AgentPermissionConfig {
  const fallback = buildDefaultPermissionConfig(agentKind);
  if (!value || typeof value !== 'object') {
    return fallback;
  }

  const raw = value as Record<string, unknown>;
  if (agentKind === 'opencode') {
    return {
      kind: 'opencode',
      permissionMode: isOpenCodePermissionMode(raw.permissionMode) ? raw.permissionMode : 'full_access',
    };
  }
  if (agentKind === 'codex') {
    return {
      kind: 'codex',
      workflowMode: resolveCodexWorkflowMode(raw),
      networkAccessEnabled: typeof raw.networkAccessEnabled === 'boolean'
        ? raw.networkAccessEnabled
        : resolveCodexWorkflowMode(raw) === 'read-only' ? false : true,
    };
  }

  return {
    kind: 'claude_code',
    permissionMode: isClaudePermissionMode(raw.permissionMode) ? raw.permissionMode : 'default',
  };
}

/**
 * Resolves the effective Workflow Mode tier from a stored config.
 * Legacy snapshots that only carry the SDK-era sandbox/approval triple are
 * migrated by sandbox mode: read-only → read-only, workspace-write → auto,
 * danger-full-access → full-access.
 */
export function resolveCodexWorkflowMode(raw: Record<string, unknown>): CodexWorkflowMode {
  if (isCodexWorkflowMode(raw.workflowMode)) {
    return raw.workflowMode;
  }
  const sandboxMode = raw.sandboxMode;
  if (sandboxMode === 'read-only') return 'read-only';
  if (sandboxMode === 'workspace-write') return 'auto';
  if (sandboxMode === 'danger-full-access') return 'full-access';
  return CODEX_DEFAULT_PERMISSIONS.workflowMode;
}

function isOpenCodePermissionMode(value: unknown): value is OpenCodePermissionMode {
  return value === 'full_access' || value === 'plan';
}

function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return typeof value === 'string' && CLAUDE_PERMISSION_MODES.includes(value as ClaudePermissionMode);
}

function isCodexWorkflowMode(value: unknown): value is CodexWorkflowMode {
  return typeof value === 'string' && CODEX_WORKFLOW_MODES.includes(value as CodexWorkflowMode);
}
