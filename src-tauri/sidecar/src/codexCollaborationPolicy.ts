import type { ThreadItem } from '@openai/codex-sdk';

import type { AgentPlanMode, SidecarPermissionConfig } from './agentPermissions.js';
import type { AgentInputPayload } from './agentInputPayload.js';

export const CODEX_COLLABORATION_POLICY_VERSION = 'codemux-codex-collaboration-policy/v1';

export type CodexCollaborationMode = 'code' | 'plan';
export type CodexInteractionMode = 'autonomous' | 'checkpoint' | 'plan';
export type CodexCollaborationProfile = 'strict-local';
export type CodexRequestUserInputPolicy = 'allow' | 'block';

export type CodexCollaborationPolicy = {
  selectedMode: CodexCollaborationMode | null;
  effectiveMode: CodexCollaborationMode;
  interactionMode: CodexInteractionMode;
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

export function normalizeCodexInteractionMode(value: unknown): CodexInteractionMode | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'plan') return 'plan';
  if (normalized === 'checkpoint' || normalized === 'interactive') return 'checkpoint';
  if (normalized === 'autonomous' || normalized === 'code' || normalized === 'default') return 'autonomous';
  return null;
}

export function resolveCodexCollaborationPolicy(input: {
  planMode?: AgentPlanMode;
  collaborationMode?: unknown;
  permissionConfig?: SidecarPermissionConfig;
  previousMode?: CodexCollaborationMode | null;
}): CodexCollaborationPolicy {
  const explicitInteractionMode = normalizeCodexInteractionMode(input.collaborationMode);
  const explicitMode = explicitInteractionMode === 'plan'
    ? 'plan'
    : explicitInteractionMode
      ? 'code'
      : normalizeCodexCollaborationMode(input.collaborationMode);
  const selectedMode = explicitMode
    ?? (input.planMode === 'on' ? 'plan' : input.planMode === 'off' ? 'code' : null);
  const fallbackReason = selectedMode
    ? null
    : input.previousMode
      ? 'missing_mode_in_request_using_thread_state'
      : 'missing_mode_in_request_default_code';
  const effectiveMode = selectedMode ?? input.previousMode ?? 'code';
  const profile: CodexCollaborationProfile = 'strict-local';
  const interactionMode = resolveCodexInteractionMode({
    effectiveMode,
    explicitInteractionMode,
    planMode: input.planMode,
  });
  const requestUserInputPolicy: CodexRequestUserInputPolicy = interactionMode === 'autonomous'
    ? 'block'
    : 'allow';

  return {
    selectedMode,
    effectiveMode,
    interactionMode,
    profile,
    fallbackReason,
    policyVersion: CODEX_COLLABORATION_POLICY_VERSION,
    requestUserInputPolicy,
    directives: buildCodexCollaborationDirectives(effectiveMode, interactionMode, profile),
  };
}

function resolveCodexInteractionMode(input: {
  effectiveMode: CodexCollaborationMode;
  explicitInteractionMode: CodexInteractionMode | null;
  planMode?: AgentPlanMode;
}): CodexInteractionMode {
  if (input.effectiveMode === 'plan') return 'plan';
  if (input.explicitInteractionMode && input.explicitInteractionMode !== 'plan') {
    return input.explicitInteractionMode;
  }
  return input.planMode === 'off' ? 'checkpoint' : 'autonomous';
}

export function buildCodexCollaborationDirectives(
  mode: CodexCollaborationMode,
  interactionMode: CodexInteractionMode = mode === 'plan' ? 'plan' : 'autonomous',
  _profile: CodexCollaborationProfile = 'strict-local',
): string[] {
  if (mode === 'code' && interactionMode === 'autonomous') {
    return [
      'Execution policy (default mode): keep execution autonomous. Do not ask the user follow-up questions and avoid requestUserInput / askuserquestion interactions. If details are missing, make minimal reasonable assumptions, proceed, and report assumptions briefly.',
    ];
  }

  if (mode === 'code') {
    return [
      'Execution policy (checkpoint mode): keep execution autonomous for routine work, but you MAY use requestUserInput / askuserquestion for explicit checkpoints, phase confirmations, blockers, or missing information that materially affects the result.',
      'Execution policy (checkpoint mode): full access controls filesystem, network, and approval behavior only; it does not disable user confirmation checkpoints.',
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
    `interaction_mode: ${policy.interactionMode}`,
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
    const tokens = normalizeCommandTokens(unwrapShellCommand(item.command));
    const mutatingCommand = getRepoMutatingCommandName(tokens);
    if (mutatingCommand) {
      return `item/tool/commandExecution:${mutatingCommand}`;
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
      .flatMap(splitShellSeparators)
      .map((token) => token.trim().replace(/^["']|["']$/g, '').toLowerCase())
      .filter(Boolean);
  }
  if (Array.isArray(command)) {
    return command
      .filter((token): token is string => typeof token === 'string')
      .flatMap(splitShellSeparators)
      .map((token) => token.trim().replace(/^["']|["']$/g, '').toLowerCase())
      .filter(Boolean);
  }
  return [];
}

function splitShellSeparators(token: string): string[] {
  return token
    .split(/(&&|\|\||[;|])/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function unwrapShellCommand(command: unknown): unknown {
  if (typeof command !== 'string') {
    return command;
  }

  const shellMatch = command.match(/^(?:"[^"]*powershell(?:\.exe)?"|[^"\s]*powershell(?:\.exe)?)(?:\s+|$)/i);
  if (shellMatch) {
    const afterExecutable = command.slice(shellMatch[0].length).trim();
    const commandFlagMatch = afterExecutable.match(/(?:^|\s)-(?:Command|c)\s+([\s\S]+)$/i);
    if (!commandFlagMatch) {
      return command;
    }

    return unwrapQuotedCommand(commandFlagMatch[1].trim());
  }

  const cmdMatch = command.match(/^(?:"[^"]*cmd(?:\.exe)?"|[^"\s]*cmd(?:\.exe)?)(?:\s+|$)/i);
  if (cmdMatch) {
    const afterExecutable = command.slice(cmdMatch[0].length).trim();
    const commandFlagMatch = afterExecutable.match(/(?:^|\s)\/c\s+([\s\S]+)$/i);
    if (!commandFlagMatch) {
      return command;
    }

    return unwrapQuotedCommand(commandFlagMatch[1].trim());
  }

  return command;
}

function unwrapQuotedCommand(command: string): string {
  if (
    (command.startsWith('"') && command.endsWith('"'))
    || (command.startsWith("'") && command.endsWith("'"))
  ) {
    return command.slice(1, -1);
  }

  return command;
}

function getRepoMutatingCommandName(tokens: string[]): string | null {
  for (const segment of splitShellCommandSegments(tokens)) {
    const gitIndex = findGitExecutableIndex(segment);
    if (gitIndex < 0) continue;

    const subcommand = findGitSubcommand(segment.slice(gitIndex + 1));
    if (!subcommand) continue;

    const mutatingCommand = classifyGitSubcommandMutation(subcommand, segment.slice(gitIndex + 1));
    if (mutatingCommand) return mutatingCommand;
  }

  return null;
}

function splitShellCommandSegments(tokens: string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];

  for (const token of tokens) {
    if (token === '&&' || token === '||' || token === ';' || token === '|') {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    current.push(token);
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

function findGitExecutableIndex(tokens: string[]): number {
  const firstCommandTokenIndex = tokens.findIndex((token) => !isShellAssignment(token));
  return tokens[firstCommandTokenIndex] === 'git' ? firstCommandTokenIndex : -1;
}

function isShellAssignment(token: string): boolean {
  return /^[a-z_][a-z0-9_]*=.*$/i.test(token);
}

function classifyGitSubcommandMutation(subcommand: string, gitArgs: string[]): string | null {
  const mutatingCommands = new Set([
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
  ]);
  if (mutatingCommands.has(subcommand)) return `git ${subcommand}`;
  if (subcommand === 'branch' && isMutatingGitBranchCommand(gitArgs)) return 'git branch';
  return null;
}

function isMutatingGitBranchCommand(gitArgs: string[]): boolean {
  const branchIndex = findGitSubcommandIndex(gitArgs);
  if (branchIndex < 0) return false;
  const branchArgs = gitArgs.slice(branchIndex + 1);
  if (branchArgs.length === 0) return false;

  const readOnlyLongOptions = new Set([
    '--all',
    '--contains',
    '--format',
    '--list',
    '--merged',
    '--no-contains',
    '--no-merged',
    '--points-at',
    '--remotes',
    '--show-current',
    '--sort',
    '--verbose',
  ]);
  const mutatingLongOptions = new Set([
    '--copy',
    '--create-reflog',
    '--delete',
    '--edit-description',
    '--force',
    '--move',
    '--set-upstream-to',
    '--track',
    '--unset-upstream',
  ]);
  const listModeOptions = new Set([
    '--all',
    '--contains',
    '--list',
    '--merged',
    '--no-contains',
    '--no-merged',
    '--points-at',
    '--remotes',
  ]);
  let readOnlyListMode = false;

  for (let index = 0; index < branchArgs.length; index++) {
    const token = branchArgs[index];
    if (mutatingLongOptions.has(token) || [...mutatingLongOptions].some((option) => token.startsWith(`${option}=`))) {
      return true;
    }
    if (readOnlyLongOptions.has(token) || [...readOnlyLongOptions].some((option) => token.startsWith(`${option}=`))) {
      if (listModeOptions.has(token) || [...listModeOptions].some((option) => token.startsWith(`${option}=`))) {
        readOnlyListMode = true;
      }
      if (token === '--format' || token === '--sort' || token === '--points-at') {
        index++;
      }
      continue;
    }
    if (token.startsWith('-')) {
      if (/[dDmMcCfFu]/.test(token.slice(1))) return true;
      continue;
    }

    return !readOnlyListMode;
  }

  return false;
}

function findGitSubcommand(tokens: string[]): string | null {
  const index = findGitSubcommandIndex(tokens);
  return index < 0 ? null : tokens[index];
}

function findGitSubcommandIndex(tokens: string[]): number {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.startsWith('-')) {
      return index;
    }

    if (token === '-c' || token === '-C' || token === '--git-dir' || token === '--work-tree') {
      index++;
      continue;
    }

    if (
      token.startsWith('-c=') ||
      token.startsWith('-C=') ||
      token.startsWith('--git-dir=') ||
      token.startsWith('--work-tree=')
    ) {
      continue;
    }
  }

  return -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
