export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'high';

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** Coerce inbound sidecar values. Unknown values are dropped rather than defaulted. */
export function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== 'string') return undefined;
  const lower = value.trim().toLowerCase();
  if (lower === 'off' || lower === 'disabled') return 'none';
  if (lower === 'minimal') return 'low';
  return isReasoningEffort(lower) ? lower : undefined;
}

/**
 * Responses API: `{ reasoning: { effort: "none" | "low" | "high" | "max" } }`.
 * `none` disables thinking. Medium snaps to high; xhigh snaps to max.
 */
export function mapToResponsesEffort(effort: ReasoningEffort): 'none' | 'low' | 'high' | 'max' {
  switch (effort) {
    case 'none':
      return 'none';
    case 'low':
      return 'low';
    case 'medium':
    case 'high':
      return 'high';
    case 'xhigh':
    case 'max':
      return 'max';
  }
}

/**
 * OpenAI Chat Completions intensity: `{ reasoning_effort: "low" | "high" | "max" }`.
 * Returns null when thinking should be disabled instead of sending an effort.
 */
export function mapToOpenAIChatEffort(effort: ReasoningEffort): 'low' | 'high' | 'max' | null {
  if (effort === 'none') return null;
  switch (effort) {
    case 'low':
      return 'low';
    case 'medium':
    case 'high':
      return 'high';
    case 'xhigh':
    case 'max':
      return 'max';
  }
}

/**
 * Anthropic: `{ output_config: { effort: "low" | "high" | "max" } }`.
 * Returns null when thinking should be omitted / disabled.
 */
export function mapToAnthropicEffort(effort: ReasoningEffort): 'low' | 'high' | 'max' | null {
  return mapToOpenAIChatEffort(effort);
}

/**
 * Codex SDK `modelReasoningEffort`.
 * Keeps medium/xhigh for GPT-5.5-class catalogs; max snaps to xhigh; none is passed through.
 */
export function mapToCodexEffort(
  effort: ReasoningEffort,
): 'none' | 'low' | 'medium' | 'high' | 'xhigh' {
  if (effort === 'max') return 'xhigh';
  return effort;
}

/**
 * Claude Agent SDK `options.effort`.
 * Omits `none` (no disable switch on this interface); xhigh snaps to max.
 */
export function mapToClaudeEffort(
  effort: ReasoningEffort,
): 'low' | 'medium' | 'high' | 'max' | undefined {
  if (effort === 'none') return undefined;
  if (effort === 'xhigh') return 'max';
  return effort;
}
