import type { AgentPlanMode, SidecarPermissionConfig } from './agentPermissions.js';

export type RuntimeEffectiveMode = 'code' | 'plan';
export type RuntimeToolDecision = {
  behavior: 'allow' | 'ask' | 'deny';
  effectiveMode: RuntimeEffectiveMode;
  reasonCode: string | null;
};

export type ActivePermissionState = {
  sessionId?: string;
  agentKind?: string;
  permissionConfig?: SidecarPermissionConfig;
  planMode: AgentPlanMode;
  effectiveMode: RuntimeEffectiveMode;
  updatedAt: number;
};

let activePermissionState: ActivePermissionState | null = null;

export function setActivePermissionState(input: {
  sessionId?: string;
  agentKind?: string;
  permissionConfig?: SidecarPermissionConfig;
  planMode?: AgentPlanMode;
  updatedAt?: number;
}): ActivePermissionState {
  const planMode = input.planMode === 'on' ? 'on' : 'off';
  const state: ActivePermissionState = {
    sessionId: input.sessionId,
    agentKind: input.agentKind,
    permissionConfig: input.permissionConfig,
    planMode,
    effectiveMode: resolveEffectiveMode(input.permissionConfig, planMode),
    updatedAt: input.updatedAt ?? Date.now(),
  };
  activePermissionState = state;
  return state;
}

export function getActivePermissionState(input?: {
  sessionId?: string | null;
  agentKind?: string | null;
}): ActivePermissionState | null {
  if (!activePermissionState) return null;
  if (
    input?.sessionId &&
    activePermissionState.sessionId &&
    activePermissionState.sessionId !== input.sessionId
  ) {
    return null;
  }
  if (
    input?.agentKind &&
    activePermissionState.agentKind &&
    activePermissionState.agentKind !== input.agentKind
  ) {
    return null;
  }
  return activePermissionState;
}

export function clearActivePermissionState(): void {
  activePermissionState = null;
}

export function resolveEffectiveMode(
  permissionConfig: SidecarPermissionConfig | undefined,
  planMode: AgentPlanMode,
): RuntimeEffectiveMode {
  if (planMode === 'on') return 'plan';
  if (permissionConfig?.kind === 'claude_code' && permissionConfig.permissionMode === 'plan') return 'plan';
  if (permissionConfig?.kind === 'codex' && permissionConfig.sandboxMode === 'read-only') return 'plan';
  return 'code';
}

export function resolveActiveCodexPlanMode(sessionId?: string | null): AgentPlanMode | null {
  const state = getActivePermissionState({ sessionId, agentKind: 'codex' });
  if (!state) return null;
  return state.effectiveMode === 'plan' ? 'on' : 'off';
}

export function resolveClaudeToolRuntimeDecision(
  toolName: string,
  sessionId?: string | null,
): RuntimeToolDecision {
  const state = getActivePermissionState({ sessionId, agentKind: 'claude_code' });
  if (!state) {
    return { behavior: 'ask', effectiveMode: 'code', reasonCode: null };
  }

  if (state.effectiveMode === 'plan' && isClaudeMutatingTool(toolName)) {
    return {
      behavior: 'deny',
      effectiveMode: 'plan',
      reasonCode: 'plan_readonly_violation',
    };
  }

  if (isClaudeFullAccess(state) && toolName !== 'AskUserQuestion') {
    return { behavior: 'allow', effectiveMode: 'code', reasonCode: null };
  }

  return {
    behavior: 'ask',
    effectiveMode: state.effectiveMode,
    reasonCode: null,
  };
}

export function buildClaudeModeBlockedEvent(input: {
  toolName: string;
  toolUseId?: string | null;
  effectiveMode: RuntimeEffectiveMode;
  reasonCode: string;
}): {
  type: 'sidecar_stream_status';
  message: string;
  is_reconnecting: false;
  mode_blocked: {
    blocked_method: string;
    effective_mode: RuntimeEffectiveMode;
    reason_code: string;
    reason: string;
    suggestion: string;
    request_id: string | null;
  };
} {
  const blockedMethod = `item/tool/${input.toolName}`;
  return {
    type: 'sidecar_stream_status',
    message: `Claude permission mode blocked ${blockedMethod}: ${input.reasonCode}. This operation is blocked while effective_mode=${input.effectiveMode}.`,
    is_reconnecting: false,
    mode_blocked: {
      blocked_method: blockedMethod,
      effective_mode: input.effectiveMode,
      reason_code: input.reasonCode,
      reason: `This operation is blocked while effective_mode=${input.effectiveMode}.`,
      suggestion: input.effectiveMode === 'plan'
        ? 'Switch to full access mode and retry the write operation.'
        : 'Switch modes and retry the operation.',
      request_id: input.toolUseId ?? null,
    },
  };
}

function isClaudeFullAccess(state: ActivePermissionState): boolean {
  return state.planMode !== 'on'
    && state.permissionConfig?.kind === 'claude_code'
    && state.permissionConfig.permissionMode === 'bypassPermissions';
}

function isClaudeMutatingTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase().replace(/[-_\s]/g, '');
  return normalized === 'write'
    || normalized === 'edit'
    || normalized === 'multiedit'
    || normalized === 'notebookedit'
    || normalized === 'createfile'
    || normalized === 'createdirectory'
    || normalized === 'delete'
    || normalized === 'deletefile'
    || normalized === 'remove'
    || normalized === 'removefile'
    || normalized === 'rewrite'
    || normalized.includes('bash')
    || normalized.includes('exec')
    || normalized.includes('command')
    || normalized.includes('shell')
    || normalized.includes('terminal')
    || normalized === 'run';
}
