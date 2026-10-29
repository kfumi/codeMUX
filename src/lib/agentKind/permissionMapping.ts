/**
 * 档位 ↔ 原生权限配置的映射 —— 四家原生权限词汇的差异全部关在这里。
 *
 * 调用方（选择器、设置页、store）只讲 `AgentExecutionMode`，不再各自写
 * `if (agentKind === 'codex')`。plan 的正交性由 `kinds.ts` 的 `planMode` 字段驱动，
 * 不在这里按 kind 字符串分支。
 */

import type { AgentKind } from '../../types/session';
import { AGENT_KIND_SPECS } from './kinds';
import {
  type AgentExecutionMode,
  type AgentPermissionConfig,
  type ClaudePermissionMode,
  type CodexWorkflowMode,
  type PiPermissionConfig,
} from './types';

const PI_EXECUTION_MODES: PiPermissionConfig['executionMode'][] = [
  'confirm_before_edit',
  'auto_edit',
  'full_access',
];

const CLAUDE_PERMISSION_MODES: ClaudePermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
];

const CODEX_WORKFLOW_MODES: CodexWorkflowMode[] = ['read-only', 'auto', 'auto-review', 'full-access'];

// Shared defaults — keep in sync with apps/sidecar/src/agentPermissions.ts.
// Default tier mirrors the official ChatGPT Codex App's conservative
// 「请求批准」selector entry (workspace-write + on-request).
const CODEX_DEFAULT_PERMISSIONS: Omit<Extract<AgentPermissionConfig, { kind: 'codex' }>, 'kind'> = {
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

  if (agentKind === 'pi') {
    return { kind: 'pi', executionMode: 'confirm_before_edit' };
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

  if (agentKind === 'pi') {
    switch (executionMode) {
      case 'auto_edit':
        return { kind: 'pi', executionMode: 'auto_edit' };
      case 'full_access':
        return { kind: 'pi', executionMode: 'full_access' };
      // plan 对 pi 不适用（选择器不提供），确认档为缺省。
      case 'confirm_before_edit':
      default:
        return { kind: 'pi', executionMode: 'confirm_before_edit' };
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
 * 选一个档位之后，配置与 plan 一起落地的原子结果。
 *
 * 这是选择器唯一需要的写入路径：它同时给出「原生配置」和「plan_mode 该变成什么」，
 * 免掉调用方自己拼 `if (kind === 'codex')` 的 plan 判断。plan 的正交性从规格表读
 * （ADR 0010），调用方不需要知道 `planModeShape` 这个概念。
 *
 * - `via-tier`：plan 是档位之一 → 选中即 on，选走即 off。
 * - `orthogonal-toggle` / `unsupported`：档位不触碰 plan → 原样保留。
 */
export function applyTier(
  agentKind: AgentKind,
  mode: AgentExecutionMode,
  previousConfig: unknown,
  planMode: 'off' | 'on',
): { config: AgentPermissionConfig; planMode: 'off' | 'on' } {
  const config = mapExecutionModeToPermissionConfig(agentKind, mode, previousConfig);
  const planModeShape = AGENT_KIND_SPECS.find((spec) => spec.kind === agentKind)?.planMode
    ?? 'unsupported';
  const nextPlanMode = planModeShape === 'via-tier'
    ? (mode === 'plan' ? 'on' as const : 'off' as const)
    : planMode;
  return { config: resolveEffectivePermissionConfig(agentKind, config, nextPlanMode), planMode: nextPlanMode };
}

/**
 * 从存下来的快照反推它落在哪个档位 —— 选择器显示当前选中项用。
 *
 * 四家的反推规则不同，全部收在这里；组件不再各自实现一遍。
 */
export function inferExecutionMode(
  agentKind: AgentKind,
  permissionConfig: AgentPermissionConfig,
  planMode: 'off' | 'on',
): AgentExecutionMode {
  if (agentKind === 'opencode') {
    // Plan vs build mirrors the official agent selector and is carried by
    // the orthogonal plan_mode toggle; the snapshot only tracks the shield.
    if (planMode === 'on') return 'plan';
    return 'confirm_before_edit';
  }

  if (agentKind === 'codex' && permissionConfig.kind === 'codex') {
    // Plan Mode is orthogonal (ADR 0010 Decision 4): the selector always
    // reflects the stored Workflow tier, never the plan toggle.
    return codexWorkflowModeToExecutionMode(permissionConfig.workflowMode);
  }

  if (agentKind === 'claude_code' && permissionConfig.kind === 'claude_code') {
    if (planMode === 'on' || permissionConfig.permissionMode === 'plan') return 'plan';
    if (permissionConfig.permissionMode === 'bypassPermissions') return 'full_access';
    if (permissionConfig.permissionMode === 'auto') return 'auto_review';
    if (permissionConfig.permissionMode === 'acceptEdits') return 'auto_edit';
  }

  if (agentKind === 'pi' && permissionConfig.kind === 'pi') {
    return permissionConfig.executionMode;
  }

  return 'confirm_before_edit';
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

/**
 * Claude 的 plan 由 `permissionMode: 'plan'` 承载，因此「plan_mode 开着」必须
 * 覆盖快照里的档位。其余三家的 plan 不走这条快照（Codex 正交、OpenCode 走
 * plan_mode 列、pi 没有 plan）。
 *
 * 内部函数：外部只需要 `applyTier()`，它已经把这一步合并进原子写入。
 */
function resolveEffectivePermissionConfig(
  agentKind: AgentKind,
  config: unknown,
  planMode: 'off' | 'on',
): AgentPermissionConfig {
  const normalized = serializePermissionConfig(agentKind, config);
  if (agentKind === 'claude_code' && planMode === 'on') {
    return {
      kind: 'claude_code',
      permissionMode: 'plan',
    };
  }
  // 其余三家：plan 是正交的，快照照原样留下。
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
  if (agentKind === 'pi') {
    // pi kind 之前 pi 会话误存 claude_code 快照（选择器错位显示），统一迁到默认确认档。
    return {
      kind: 'pi',
      executionMode: isPiExecutionMode(raw.executionMode) ? raw.executionMode : 'confirm_before_edit',
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
function resolveCodexWorkflowMode(raw: Record<string, unknown>): CodexWorkflowMode {
  if (isCodexWorkflowMode(raw.workflowMode)) {
    return raw.workflowMode;
  }
  const sandboxMode = raw.sandboxMode;
  if (sandboxMode === 'read-only') return 'read-only';
  if (sandboxMode === 'workspace-write') return 'auto';
  if (sandboxMode === 'danger-full-access') return 'full-access';
  return CODEX_DEFAULT_PERMISSIONS.workflowMode;
}

function isOpenCodeAutoApproveEnabled(config: unknown): boolean {
  return Boolean(config)
    && typeof config === 'object'
    && (config as Record<string, unknown>).kind === 'opencode'
    && (config as Record<string, unknown>).autoApprovePermissions === true;
}

function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return typeof value === 'string' && CLAUDE_PERMISSION_MODES.includes(value as ClaudePermissionMode);
}

function isPiExecutionMode(value: unknown): value is PiPermissionConfig['executionMode'] {
  return typeof value === 'string' && (PI_EXECUTION_MODES as string[]).includes(value);
}

function isCodexWorkflowMode(value: unknown): value is CodexWorkflowMode {
  return typeof value === 'string' && CODEX_WORKFLOW_MODES.includes(value as CodexWorkflowMode);
}
