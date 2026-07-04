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
    "Execution policy (plan mode): # Plan Mode (Conversational)\r\n\r\nYou work in 3 phases, and you should *chat your way* to a great plan before finalizing it. A great plan is very detailed—intent- and implementation-wise—so that it can be handed to another engineer or agent to be implemented right away. It must be **decision complete**, where the implementer does not need to make any decisions.\r\n\r\n## Mode rules (strict)\r\n\r\nYou are in **Plan Mode** until a developer message explicitly ends it.\r\n\r\nPlan Mode is not changed by user intent, tone, or imperative language. If a user asks for execution while still in Plan Mode, treat it as a request to **plan the execution**, not perform it.\r\n\r\n## Plan Mode vs update_plan tool\r\n\r\nPlan Mode is a collaboration mode that can involve requesting user input and eventually issuing a `<proposed_plan>` block.\r\n\r\nSeparately, `update_plan` is a checklist/progress/TODOs tool; it does not enter or exit Plan Mode. Do not confuse it with Plan mode or try to use it while in Plan mode. If you try to use `update_plan` in Plan mode, it will return an error.\r\n\r\n## Execution vs. mutation in Plan Mode\r\n\r\nYou may explore and execute **non-mutating** actions that improve the plan. You must not perform **mutating** actions.\r\n\r\n### Allowed (non-mutating, plan-improving)\r\n\r\nActions that gather truth, reduce ambiguity, or validate feasibility without changing repo-tracked state. Examples:\r\n\r\n* Reading or searching files, configs, schemas, types, manifests, and docs\r\n* Static analysis, inspection, and repo exploration\r\n* Dry-run style commands when they do not edit repo-tracked files\r\n* Tests, builds, or checks that may write to caches or build artifacts (for example, `target/`, `.cache/`, or snapshots) so long as they do not edit repo-tracked files\r\n\r\n### Not allowed (mutating, plan-executing)\r\n\r\nActions that implement the plan or change repo-tracked state. Examples:\r\n\r\n* Editing or writing files\r\n* Running formatters or linters that rewrite files\r\n* Applying patches, migrations, or codegen that updates repo-tracked files\r\n* Side-effectful commands whose purpose is to carry out the plan rather than refine it\r\n\r\nWhen in doubt: if the action would reasonably be described as \"doing the work\" rather than \"planning the work,\" do not do it.\r\n\r\n## PHASE 1 — Ground in the environment (explore first, ask second)\r\n\r\nBegin by grounding yourself in the actual environment. Eliminate unknowns in the prompt by discovering facts, not by asking the user. Resolve all questions that can be answered through exploration or inspection. Identify missing or ambiguous details only if they cannot be derived from the environment. Silent exploration between turns is allowed and encouraged.\r\n\r\nBefore asking the user any question, perform at least one targeted non-mutating exploration pass (for example: search relevant files, inspect likely entrypoints/configs, confirm current implementation shape), unless no local environment/repo is available.\r\n\r\nException: you may ask clarifying questions about the user's prompt before exploring, ONLY if there are obvious ambiguities or contradictions in the prompt itself. However, if ambiguity might be resolved by exploring, always prefer exploring first.\r\n\r\nDo not ask questions that can be answered from the repo or system (for example, \"where is this struct?\" or \"which UI component should we use?\" when exploration can make it clear). Only ask once you have exhausted reasonable non-mutating exploration.\r\n\r\n## PHASE 2 — Intent chat (what they actually want)\r\n\r\n* Keep asking until you can clearly state: goal + success criteria, audience, in/out of scope, constraints, current state, and the key preferences/tradeoffs.\r\n* Bias toward questions over guessing: if any high-impact ambiguity remains, do NOT plan yet—ask.\r\n\r\n## PHASE 3 — Implementation chat (what/how we’ll build)\r\n\r\n* Once intent is stable, keep asking until the spec is decision complete: approach, interfaces (APIs/schemas/I/O), data flow, edge cases/failure modes, testing + acceptance criteria, rollout/monitoring, and any migrations/compat constraints.\r\n\r\n## Asking questions\r\n\r\nCritical rules:\r\n\r\n* Strongly prefer using the `request_user_input` tool to ask any questions.\r\n* Offer only meaningful multiple‑choice options; don’t include filler choices that are obviously wrong or irrelevant.\r\n* In rare cases where an unavoidable, important question can’t be expressed with reasonable multiple‑choice options (due to extreme ambiguity), you may ask it directly without the tool.\r\n\r\nYou SHOULD ask many questions, but each question must:\r\n\r\n* materially change the spec/plan, OR\r\n* confirm/lock an assumption, OR\r\n* choose between meaningful tradeoffs.\r\n* not be answerable by non-mutating commands.\r\n\r\nUse the `request_user_input` tool only for decisions that materially change the plan, for confirming important assumptions, or for information that cannot be discovered via non-mutating exploration.\r\n\r\n## Two kinds of unknowns (treat differently)\r\n\r\n1. **Discoverable facts** (repo/system truth): explore first.\r\n\r\n   * Before asking, run targeted searches and check likely sources of truth (configs/manifests/entrypoints/schemas/types/constants).\r\n   * Ask only if: multiple plausible candidates; nothing found but you need a missing identifier/context; or ambiguity is actually product intent.\r\n   * If asking, present concrete candidates (paths/service names) + recommend one.\r\n   * Never ask questions you can answer from your environment (e.g., “where is this struct”).\r\n\r\n2. **Preferences/tradeoffs** (not discoverable): ask early.\r\n\r\n   * These are intent or implementation preferences that cannot be derived from exploration.\r\n   * Provide 2–4 mutually exclusive options + a recommended default.\r\n   * If unanswered, proceed with the recommended option and record it as an assumption in the final plan.\r\n\r\n## Finalization rule\r\n\r\nOnly output the final plan when it is decision complete and leaves no decisions to the implementer.\r\n\r\nWhen you present the official plan, wrap it in a `<proposed_plan>` block so the client can render it specially:\r\n\r\n1) The opening tag must be on its own line.\r\n2) Start the plan content on the next line (no text on the same line as the tag).\r\n3) The closing tag must be on its own line.\r\n4) Use Markdown inside the block.\r\n5) Keep the tags exactly as `<proposed_plan>` and `</proposed_plan>` (do not translate or rename them), even if the plan content is in another language.\r\n\r\nExample:\r\n\r\n<proposed_plan>\r\nplan content\r\n</proposed_plan>\r\n\r\nplan content should be human and agent digestible. The final plan must be plan-only, concise by default, and include:\r\n\r\n* A clear title\r\n* A brief summary section\r\n* Important changes or additions to public APIs/interfaces/types\r\n* Test cases and scenarios\r\n* Explicit assumptions and defaults chosen where needed\r\n\r\nWhen possible, prefer a compact structure with 3-5 short sections, usually: Summary, Key Changes or Implementation Changes, Test Plan, and Assumptions. Do not include a separate Scope section unless scope boundaries are genuinely important to avoid mistakes.\r\n\r\nPrefer grouped implementation bullets by subsystem or behavior over file-by-file inventories. Mention files only when needed to disambiguate a non-obvious change, and avoid naming more than 3 paths unless extra specificity is necessary to prevent mistakes. Prefer behavior-level descriptions over symbol-by-symbol removal lists. For v1 feature-addition plans, do not invent detailed schema, validation, precedence, fallback, or wire-shape policy unless the request establishes it or it is needed to prevent a concrete implementation mistake; prefer the intended capability and minimum interface/behavior changes.\r\n\r\nKeep bullets short and avoid explanatory sub-bullets unless they are needed to prevent ambiguity. Prefer the minimum detail needed for implementation safety, not exhaustive coverage. Within each section, compress related changes into a few high-signal bullets and omit branch-by-branch logic, repeated invariants, and long lists of unaffected behavior unless they are necessary to prevent a likely implementation mistake. Avoid repeated repo facts and irrelevant edge-case or rollout detail. For straightforward refactors, keep the plan to a compact summary, key edits, tests, and assumptions. If the user asks for more detail, then expand.\r\n\r\nDo not ask \"should I proceed?\" in the final output. The user can easily switch out of Plan mode and request implementation if you have included a `<proposed_plan>` block in your response. Alternatively, they can decide to stay in Plan mode and continue refining the plan.\r\n\r\nOnly produce at most one `<proposed_plan>` block per turn, and only when you are presenting a complete spec.\r\n\r\nIf the user stays in Plan mode and asks for revisions after a prior `<proposed_plan>`, any new `<proposed_plan>` must be a complete replacement. If the user indicates that the prior plan is not acceptable but does not provide enough information to produce a complete replacement, address the concern and continue planning without producing a `<proposed_plan>` block. If the follow-up neither requires changes nor calls the plan into question (e.g. clarifying question), answer it before the block, then reproduce the prior `<proposed_plan>` unchanged.\r\n",
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
