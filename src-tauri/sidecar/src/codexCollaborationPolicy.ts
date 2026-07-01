import type { ThreadItem } from '@openai/codex-sdk';

import type { AgentPlanMode } from './agentPermissions.js';
import type { AgentInputPayload } from './agentInputPayload.js';

export const CODEX_COLLABORATION_POLICY_VERSION = 'codemux-codex-collaboration-policy/v1';

export type CodexCollaborationMode = 'code' | 'plan';
export type CodexCollaborationProfile = 'strict-local';
export type CodexRequestUserInputPolicy = 'allow' | 'block';

export type CodexCollaborationPolicy = {
  selectedMode: CodexCollaborationMode | null;
  effectiveMode: CodexCollaborationMode;
  profile: CodexCollaborationProfile;
  fallbackReason: string | null;
  policyVersion: typeof CODEX_COLLABORATION_POLICY_VERSION;
  requestUserInputPolicy: CodexRequestUserInputPolicy;
  directives: string[];
};

export type CodexModeBlockedEvent = {
  type: 'sidecar_stream_status';
  message: string;
  is_reconnecting: false;
  mode_blocked: {
    blocked_method: string;
    effective_mode: CodexCollaborationMode;
    reason_code: string;
    reason: string;
    suggestion: string;
    request_id: string | null;
  };
};

const POLICY_MARKER_START = '<codemux-codex-collaboration-policy>';
const POLICY_MARKER_END = '</codemux-codex-collaboration-policy>';

let activeCodexCollaborationPolicy = resolveCodexCollaborationPolicy({});

export function setActiveCodexCollaborationPolicy(policy: CodexCollaborationPolicy): void {
  activeCodexCollaborationPolicy = policy;
}

export function getActiveCodexCollaborationPolicy(): CodexCollaborationPolicy {
  return activeCodexCollaborationPolicy;
}

export function normalizeCodexCollaborationMode(value: unknown): CodexCollaborationMode | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'plan') return 'plan';
  if (normalized === 'code' || normalized === 'default') return 'code';
  return null;
}

export function resolveCodexCollaborationPolicy(input: {
  planMode?: AgentPlanMode;
  collaborationMode?: unknown;
  previousMode?: CodexCollaborationMode | null;
}): CodexCollaborationPolicy {
  const explicitMode = normalizeCodexCollaborationMode(input.collaborationMode);
  const selectedMode = explicitMode
    ?? (input.planMode === 'on' ? 'plan' : input.planMode === 'off' ? 'code' : null);
  const fallbackReason = selectedMode
    ? null
    : input.previousMode
      ? 'missing_mode_in_request_using_thread_state'
      : 'missing_mode_in_request_default_code';
  const effectiveMode = selectedMode ?? input.previousMode ?? 'code';
  const requestUserInputPolicy: CodexRequestUserInputPolicy = effectiveMode === 'code' ? 'block' : 'allow';

  return {
    selectedMode,
    effectiveMode,
    profile: 'strict-local',
    fallbackReason,
    policyVersion: CODEX_COLLABORATION_POLICY_VERSION,
    requestUserInputPolicy,
    directives: buildCodexCollaborationDirectives(effectiveMode),
  };
}

export function buildCodexCollaborationDirectives(mode: CodexCollaborationMode): string[] {
  if (mode === 'code') {
    return [
      'Execution policy (default mode): keep execution autonomous. Do not ask the user follow-up questions and avoid requestUserInput / askuserquestion interactions. If details are missing, make minimal reasonable assumptions, proceed, and report assumptions briefly.',
    ];
  }

  return [
    'Execution policy (plan mode): work in planning-only style. You MAY inspect files and run read-only checks, but MUST NOT apply file edits or execute repository-mutating operations.',
    'Execution policy (plan mode): if a blocker appears (missing path/context, ambiguous scope, permission gap, or any prerequisite failure), you MUST immediately stop further work, call requestUserInput / askuserquestion with concrete options, and WAIT for user input before continuing. Do not silently continue with assumptions.',
    'Execution policy (plan mode): when you need extra user information (for example path, credentials, env value, target scope, preference, or any missing input), you MUST ask via requestUserInput / askuserquestion. Plain-text follow-up questions are NOT allowed.',
  ];
}

export function applyCodexCollaborationPolicyToPayload(
  payload: AgentInputPayload,
  policy: CodexCollaborationPolicy,
): AgentInputPayload {
  return {
    ...payload,
    text: injectPolicyText(payload.text, policy),
  };
}

export function applyCodexCollaborationPolicyToInput(
  input: unknown[],
  policy: CodexCollaborationPolicy,
): unknown[] {
  const policyBlock = renderPolicyBlock(policy);
  let injected = false;
  const next = input.map((entry) => {
    if (injected || !isRecord(entry) || entry.type !== 'text' || typeof entry.text !== 'string') {
      return entry;
    }
    injected = true;
    return {
      ...entry,
      text: entry.text.includes(POLICY_MARKER_START)
        ? entry.text
        : `${policyBlock}\n\n${entry.text}`.trim(),
    };
  });
  if (injected) return next;
  return [{ type: 'text', text: policyBlock }, ...input];
}

function injectPolicyText(text: string, policy: CodexCollaborationPolicy): string {
  if (text.includes(POLICY_MARKER_START)) return text;
  return `${renderPolicyBlock(policy)}\n\n${text}`.trim();
}

function renderPolicyBlock(policy: CodexCollaborationPolicy): string {
  return [
    POLICY_MARKER_START,
    `policy_version: ${policy.policyVersion}`,
    `profile: ${policy.profile}`,
    `effective_mode: ${policy.effectiveMode}`,
    `request_user_input_policy: ${policy.requestUserInputPolicy}`,
    ...policy.directives,
    POLICY_MARKER_END,
  ].join('\n');
}

export function detectPlanModeBlockedMethod(item: unknown): string | null {
  if (!isRecord(item)) return null;
  const itemType = String(item.type ?? '').toLowerCase();
  const itemName = String(item.name ?? '').toLowerCase();
  const itemToolType = String(item.toolType ?? item.tool_type ?? '').toLowerCase();
  if (
    itemType === 'file_change'
    || itemType === 'apply_patch'
    || itemName === 'apply_patch'
    || itemToolType === 'filechange'
    || itemToolType === 'apply_patch'
  ) {
    return 'item/tool/apply_patch';
  }

  if (itemType === 'command_execution' || itemToolType === 'commandexecution') {
    const tokens = normalizeCommandTokens(unwrapWindowsPowerShellCommand(item.command));
    if (isRepoMutatingCommandTokens(tokens)) {
      return `item/tool/commandExecution:${tokens.slice(0, 2).join(' ')}`.trim();
    }
  }

  return null;
}

export function shouldBlockPlanModeItem(
  item: ThreadItem,
  policy: CodexCollaborationPolicy,
): string | null {
  if (policy.effectiveMode !== 'plan') return null;
  return detectPlanModeBlockedMethod(item);
}

export function isInteractiveUserInputToolName(name: unknown): boolean {
  return name === 'request_user_input' || name === 'askUserQuestion' || name === 'AskUserQuestion';
}

export function buildCodexModeBlockedEvent(input: {
  blockedMethod: string;
  effectiveMode: CodexCollaborationMode;
  reasonCode: string;
  reason: string;
  suggestion: string;
  requestId?: string | null;
}): CodexModeBlockedEvent {
  const requestId = input.requestId ?? null;
  return {
    type: 'sidecar_stream_status',
    message: `Codex collaboration mode blocked ${input.blockedMethod}: ${input.reasonCode}. ${input.reason}`,
    is_reconnecting: false,
    mode_blocked: {
      blocked_method: input.blockedMethod,
      effective_mode: input.effectiveMode,
      reason_code: input.reasonCode,
      reason: input.reason,
      suggestion: input.suggestion,
      request_id: requestId,
    },
  };
}

export function buildRequestUserInputBlockedEvent(toolUseId: string | null): CodexModeBlockedEvent {
  return buildCodexModeBlockedEvent({
    blockedMethod: 'item/tool/requestUserInput',
    effectiveMode: 'code',
    reasonCode: 'request_user_input_blocked_in_default_mode',
    reason: 'requestUserInput is blocked while effective_mode=code',
    suggestion: 'Switch to Plan mode and resend the prompt when user input is needed.',
    requestId: toolUseId,
  });
}

export function buildPlanMutationBlockedEvent(blockedMethod: string, itemId: string | null): CodexModeBlockedEvent {
  return buildCodexModeBlockedEvent({
    blockedMethod,
    effectiveMode: 'plan',
    reasonCode: 'plan_readonly_violation',
    reason: 'This operation is blocked while effective_mode=plan.',
    suggestion: 'Switch to full access mode and retry the write operation.',
    requestId: itemId,
  });
}

function normalizeCommandTokens(command: unknown): string[] {
  if (typeof command === 'string') {
    return command
      .split(/\s+/)
      .map((token) => token.trim().replace(/^["']|["']$/g, '').toLowerCase())
      .filter(Boolean);
  }
  if (Array.isArray(command)) {
    return command
      .filter((token): token is string => typeof token === 'string')
      .map((token) => token.trim().replace(/^["']|["']$/g, '').toLowerCase())
      .filter(Boolean);
  }
  return [];
}

function unwrapWindowsPowerShellCommand(command: unknown): unknown {
  if (typeof command !== 'string') {
    return command;
  }

  const shellMatch = command.match(/^(?:"[^"]*powershell(?:\.exe)?"|[^"\s]*powershell(?:\.exe)?)(?:\s+|$)/i);
  if (!shellMatch) {
    return command;
  }

  const afterExecutable = command.slice(shellMatch[0].length).trim();
  const commandFlagMatch = afterExecutable.match(/(?:^|\s)-(?:Command|c)\s+([\s\S]+)$/i);
  if (!commandFlagMatch) {
    return command;
  }

  const rawInnerCommand = commandFlagMatch[1].trim();
  if (
    (rawInnerCommand.startsWith('"') && rawInnerCommand.endsWith('"'))
    || (rawInnerCommand.startsWith("'") && rawInnerCommand.endsWith("'"))
  ) {
    return rawInnerCommand.slice(1, -1);
  }

  return rawInnerCommand;
}

function isRepoMutatingCommandTokens(tokens: string[]): boolean {
  if (tokens[0] !== 'git') return false;
  return new Set([
    'add',
    'commit',
    'push',
    'pull',
    'merge',
    'rebase',
    'cherry-pick',
    'revert',
    'reset',
    'stash',
    'am',
    'apply',
    'rm',
    'mv',
    'checkout',
    'switch',
    'restore',
    'clean',
    'tag',
    'branch',
    'fetch',
  ]).has(tokens[1] ?? '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
