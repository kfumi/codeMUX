import type { ReasoningEffort } from '../types/session';

export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'high';

export type ReasoningEffortOption = {
  id: ReasoningEffort;
  name: string;
};

export const REASONING_EFFORT_OPTIONS: readonly ReasoningEffortOption[] = [
  { id: 'none', name: '关闭' },
  { id: 'low', name: '低' },
  { id: 'medium', name: '中' },
  { id: 'high', name: '高' },
  { id: 'xhigh', name: '极高' },
  { id: 'max', name: '最高' },
];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** Coerce stored or inbound values to a canonical Reasoning Effort. Unknown values become the default. */
export function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  if (typeof value !== 'string') return DEFAULT_REASONING_EFFORT;
  const lower = value.trim().toLowerCase();
  if (lower === 'off' || lower === 'disabled') return 'none';
  if (lower === 'minimal') return 'low';
  return isReasoningEffort(lower) ? lower : DEFAULT_REASONING_EFFORT;
}

export function reasoningEffortLabel(effort: ReasoningEffort): string {
  return REASONING_EFFORT_OPTIONS.find((option) => option.id === effort)?.name ?? effort;
}

/**
 * Coerce one entry of a thinking-level whitelist onto the canonical vocabulary.
 * `off` / `disabled` fold onto `none`, `minimal` onto `low` — pi and resumed
 * sessions hand us those spellings. Returns `null` for anything unrecognizable.
 */
function coerceThinkingLevel(value: string): ReasoningEffort | null {
  switch (value.trim().toLowerCase()) {
    case 'none':
    case 'off':
    case 'disabled':
      return 'none';
    case 'low':
    case 'minimal':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
      return 'xhigh';
    case 'max':
      return 'max';
    default:
      return null;
  }
}

/**
 * Normalize a thinking-level whitelist: drop unknown entries, de-duplicate and
 * return in canonical `REASONING_EFFORTS` order, so the whitelist persisted on
 * a provider model round-trips byte-stably.
 *
 * Mirrors `normalize_thinking_levels` in
 * `crates/daemon/src/model_providers/types.rs`.
 */
export function normalizeThinkingLevels(raw: readonly string[] | null | undefined): ReasoningEffort[] {
  const coerced = new Set<ReasoningEffort>();
  for (const value of raw ?? []) {
    const level = coerceThinkingLevel(value);
    if (level) coerced.add(level);
  }
  return REASONING_EFFORTS.filter((level) => coerced.has(level));
}

/**
 * The levels this model actually offers.
 *
 * - `null` — not declared: the catalog had no entry and nobody configured it.
 *   We show every level (so existing sessions keep working) but flag it, because
 *   pi will clamp whatever is picked back to `off`.
 * - `[]` — declared as not supporting reasoning: only "off" makes sense.
 * - non-empty — the exact whitelist.
 */
export function resolveThinkingLevels(
  model: { thinking_levels?: readonly string[] | null } | null | undefined,
): ReasoningEffort[] | null {
  if (!model || model.thinking_levels === undefined || model.thinking_levels === null) {
    return null;
  }
  return normalizeThinkingLevels(model.thinking_levels);
}

/**
 * The options the composer's thinking-level picker should offer for a model.
 *
 * - not declared → every level, so existing sessions keep working. The caller
 *   is expected to flag this state, because pi will clamp whatever is picked
 *   back to `off`.
 * - declared as not supporting reasoning → only "off"; offering the rest would
 *   be a promise the model cannot keep.
 * - declared with a whitelist → exactly those levels.
 */
export function effortOptionsForModel(
  model: { thinking_levels?: readonly string[] | null } | null | undefined,
): ReasoningEffortOption[] {
  const levels = resolveThinkingLevels(model);
  if (levels === null) return [...REASONING_EFFORT_OPTIONS];
  if (levels.length === 0) return [REASONING_EFFORT_OPTIONS[0]];
  return REASONING_EFFORT_OPTIONS.filter((option) => levels.includes(option.id));
}
