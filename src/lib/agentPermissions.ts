import type { AgentKind } from '../types/session';

export type AgentExecutionMode = 'confirm_before_edit' | 'auto_edit' | 'plan' | 'full_access' | 'read_only' | 'auto_review';
export type AgentPlanMode = 'off' | 'on';
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
export type CodexWorkflowMode = 'read-only' | 'auto' | 'auto-review' | 'full-access';

export type OpenCodePermissionConfig = {
  kind: 'opencode';
  /**
   * Mirrors the official OpenCode "auto-approve permissions" toggle: when on,
   * permission rules that would ask are auto-approved (explicit deny rules are
   * still enforced by the server). Plan vs build stays an orthogonal
   * plan_mode toggle, like the official Build/Plan agent selector.
   */
  autoApprovePermissions: boolean;
};

export type ClaudePermissionConfig = {
  kind: 'claude_code';
  permissionMode: ClaudePermissionMode;
};

export type CodexPermissionConfig = {
  kind: 'codex';
  workflowMode: CodexWorkflowMode;
  networkAccessEnabled: boolean;
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
    return { kind: 'opencode', autoApprovePermissions: false };
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
  previousConfig?: unknown,
): AgentPermissionConfig {
  if (agentKind === 'opencode') {
    // Build/Plan only drives the orthogonal plan_mode toggle (official
    // agent selector); the auto-approve shield toggle is preserved.
    return { kind: 'opencode', autoApprovePermissions: isOpenCodeAutoApproveEnabled(previousConfig) };
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
    case 'auto_review':
      return { kind: 'claude_code', permissionMode: 'auto' };
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

export function isOpenCodeAutoApproveEnabled(config: unknown): boolean {
  return Boolean(config)
    && typeof config === 'object'
    && (config as Record<string, unknown>).kind === 'opencode'
    && (config as Record<string, unknown>).autoApprovePermissions === true;
}

export function resolveEffectivePermissionConfig(
  agentKind: AgentKind,
  config: unknown,
  planMode: AgentPlanMode,
): AgentPermissionConfig {
  const normalized = serializePermissionConfig(agentKind, config);
  if (agentKind === 'opencode') {
    // Plan vs build is carried by the orthogonal plan_mode column; the
    // serialized snapshot only tracks the auto-approve toggle.
    return normalized;
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
    // Legacy snapshots carried {permissionMode: 'plan' | 'full_access'};
    // 'plan' now lives in the plan_mode column and 'full_access' was a
    // no-op (the OpenCode server remained authoritative), so both migrate
    // onto the conservative autoApprovePermissions: false default.
    return {
      kind: 'opencode',
      autoApprovePermissions: raw.autoApprovePermissions === true,
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

function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return typeof value === 'string' && CLAUDE_PERMISSION_MODES.includes(value as ClaudePermissionMode);
}

function isCodexWorkflowMode(value: unknown): value is CodexWorkflowMode {
  return typeof value === 'string' && CODEX_WORKFLOW_MODES.includes(value as CodexWorkflowMode);
}
