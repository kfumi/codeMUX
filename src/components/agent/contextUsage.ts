const DEFAULT_CONTEXT_TOKENS = 258_400;
const LARGE_CONTEXT_TOKENS = 1_000_000;
const LARGE_CONTEXT_MODEL_SUFFIX = '[1m]';

export type ContextUsage = {
  usedTokens: number;
  totalTokens: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
};

export type TokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type ThreadTokenUsage = {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
  contextUsageSource?: string | null;
  contextUsageFreshness?: 'live_synced' | 'restored' | 'syncing' | string | null;
};

type ContextUsageOptions = {
  tokenUsage?: ThreadTokenUsage | null;
  model?: string | null;
  sessionProviderUsesLargeContext: boolean;
  activeProviderUsesLargeContext: boolean;
};

export function normalizeThreadTokenUsage(raw: unknown): ThreadTokenUsage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const last = readBreakdown(record.last) ?? readUsageSnapshot(record);
  const total = readBreakdown(record.total) ?? last;
  const modelContextWindow = readOptionalPositiveNumber(
    record.modelContextWindow ?? record.model_context_window,
  );

  if (!last || !total || !hasAnyBreakdownToken(last)) {
    return null;
  }

  return {
    total,
    last,
    modelContextWindow,
    contextUsageSource: readOptionalString(record.contextUsageSource ?? record.context_usage_source),
    contextUsageFreshness: readOptionalString(record.contextUsageFreshness ?? record.context_usage_freshness),
  };
}

export function buildContextUsageViewModel({
  tokenUsage,
  model,
  sessionProviderUsesLargeContext,
  activeProviderUsesLargeContext,
}: ContextUsageOptions): ContextUsage | null {
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

  return {
    usedTokens,
    totalTokens: getSessionContextLimit({
      model,
      sessionProviderUsesLargeContext,
      activeProviderUsesLargeContext,
      modelContextWindow: tokenUsage.modelContextWindow ?? undefined,
    }),
    inputTokens,
    cachedTokens,
    outputTokens,
  };
}

function readBreakdown(value: unknown): TokenUsageBreakdown | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return readUsageSnapshot(value as Record<string, unknown>);
}

function readUsageSnapshot(usage: Record<string, unknown>): TokenUsageBreakdown | null {
  const inputTokens = readNumber(usage.inputTokens ?? usage.input_tokens);
  const cacheReadValue = usage.cacheReadInputTokens ?? usage.cache_read_input_tokens;
  const cachedInputTokens = readNumber(
    usage.cachedInputTokens
      ?? usage.cached_input_tokens
      ?? cacheReadValue,
  );
  const outputTokens = readNumber(usage.outputTokens ?? usage.output_tokens);
  const reasoningOutputTokens = 0;
  const explicitTotal = readNumber(usage.totalTokens ?? usage.total_tokens);
  const totalTokens = explicitTotal > 0
    ? explicitTotal
    : cacheReadValue != null
      ? inputTokens + cachedInputTokens
      : inputTokens + outputTokens;

  if (inputTokens <= 0 && cachedInputTokens <= 0 && outputTokens <= 0 && totalTokens <= 0) {
    return null;
  }

  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
  };
}

function hasAnyBreakdownToken(usage: TokenUsageBreakdown): boolean {
  return usage.totalTokens > 0
    || usage.inputTokens > 0
    || usage.cachedInputTokens > 0
    || usage.outputTokens > 0;
}

function readNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(value, 0);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(parsed, 0) : 0;
  }
  return 0;
}

function readOptionalPositiveNumber(value: unknown): number | null {
  const number = readNumber(value);
  return number > 0 ? number : null;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function getSessionContextLimit({
  model,
  sessionProviderUsesLargeContext,
  activeProviderUsesLargeContext,
  modelContextWindow,
}: {
  model?: string | null;
  sessionProviderUsesLargeContext: boolean;
  activeProviderUsesLargeContext: boolean;
  modelContextWindow?: number;
}) {
  if (modelContextWindow && modelContextWindow > 0) {
    return modelContextWindow;
  }

  if (typeof model === 'string' && model.trim().length > 0) {
    return model.includes(LARGE_CONTEXT_MODEL_SUFFIX) ? LARGE_CONTEXT_TOKENS : DEFAULT_CONTEXT_TOKENS;
  }

  if (sessionProviderUsesLargeContext) {
    return LARGE_CONTEXT_TOKENS;
  }

  return activeProviderUsesLargeContext ? LARGE_CONTEXT_TOKENS : DEFAULT_CONTEXT_TOKENS;
}
