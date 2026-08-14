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
