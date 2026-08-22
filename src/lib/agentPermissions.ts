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

// Shared defaults — keep in sync with src-tauri/sidecar/src/agentPermissions.ts
const CODEX_DEFAULT_PERMISSIONS: Omit<CodexPermissionConfig, 'kind'> = {
  workflowMode: 'full-access',
  networkAccessEnabled: true,
};

const CODEX_PLAN_MODE_PERMISSIONS: Omit<CodexPermissionConfig, 'kind'> = {
  workflowMode: 'read-only',
  networkAccessEnabled: false,
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
      case 'plan':
        return { kind: 'codex', ...CODEX_PLAN_MODE_PERMISSIONS };
      case 'read_only':
        return { kind: 'codex', workflowMode: 'read-only', networkAccessEnabled: false };
      case 'auto_edit':
        return { kind: 'codex', workflowMode: 'auto', networkAccessEnabled: true };
      case 'auto_review':
        return { kind: 'codex', workflowMode: 'auto-review', networkAccessEnabled: true };
      case 'full_access':
      default:
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
  if (agentKind === 'opencode') {
    if (planMode === 'on') {
      return { kind: 'opencode', permissionMode: 'plan' };
    }
    return { kind: 'opencode', permissionMode: 'full_access' };
  }
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
