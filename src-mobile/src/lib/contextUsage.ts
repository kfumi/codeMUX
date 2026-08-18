const DEFAULT_CONTEXT_TOKENS = 200_000;
const LARGE_CONTEXT_TOKENS = 1_000_000;

export interface MobileTokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface MobileTokenUsage {
  total: MobileTokenUsageBreakdown;
  last: MobileTokenUsageBreakdown;
  modelContextWindow?: number | null;
  contextUsageSource?: string | null;
  contextUsageFreshness?: string | null;
}

export interface MobileContextUsage {
  usedTokens: number;
  totalTokens: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  percentage: number;
}

export function buildMobileContextUsage(
  tokenUsage: MobileTokenUsage | null | undefined,
  model?: string | null,
): MobileContextUsage | null {
  if (!tokenUsage) {
    return null;
  }

  const inputTokens = Math.max(tokenUsage.last.inputTokens, 0);
  const cachedTokens = Math.max(tokenUsage.last.cachedInputTokens, 0);
  const outputTokens = Math.max(tokenUsage.last.outputTokens, 0);
  const usedTokens = Math.max(tokenUsage.last.totalTokens || tokenUsage.total.totalTokens, 0);
  if (usedTokens <= 0 && inputTokens <= 0 && cachedTokens <= 0 && outputTokens <= 0) {
    return null;
  }

  const totalTokens = getContextWindow(tokenUsage.modelContextWindow, model);
  return {
    usedTokens,
    totalTokens,
    inputTokens,
    cachedTokens,
    outputTokens,
    percentage: totalTokens > 0 ? Math.min(usedTokens / totalTokens, 1) : 0,
  };
}

export function formatMobileTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}

function getContextWindow(modelContextWindow: number | null | undefined, model?: string | null): number {
  if (modelContextWindow && modelContextWindow > 0) {
    return modelContextWindow;
  }
  if (model?.toLowerCase().includes('[1m]')) {
    return LARGE_CONTEXT_TOKENS;
  }
  return DEFAULT_CONTEXT_TOKENS;
}
