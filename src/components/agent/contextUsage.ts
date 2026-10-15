const DEFAULT_CONTEXT_TOKENS = 200_000;
const LARGE_CONTEXT_TOKENS = 1_000_000;
const LARGE_CONTEXT_MODEL_SUFFIX = '[1m]';

export type ContextUsage = {
  usedTokens: number;
  /** `null` 表示上下文窗口未知 —— UI 应当隐藏整个环，而不是显示一个假的分母。 */
  totalTokens: number | null;
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
  configuredContextWindow?: number | null;
  sessionProviderUsesLargeContext: boolean;
  activeProviderUsesLargeContext: boolean;
  /**
   * 前四级阶梯都没命中时，是否允许退回 200k 这个猜测值。
   *
   * 默认 `true`，保持既有行为。传 `false` 的只有一类会话：绑定虚拟供应商
   * `opencode-free` 的 OpenCode 免费模型 —— 它没有 ModelProvider 记录，
   * 用户连配置窗口的地方都没有，所以「查不到」是终态而非待补状态。
   * 这种会话返回 `null`，让 UI 隐藏整个环；显示一个假的 200k 只会让
   * 1M 的模型看起来随时要溢出（ADR 0015：查不到就留空，绝不猜）。
   */
  assumeDefaultContextWindow?: boolean;
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
  configuredContextWindow,
  sessionProviderUsesLargeContext,
  activeProviderUsesLargeContext,
  assumeDefaultContextWindow = true,
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
      configuredContextWindow,
      sessionProviderUsesLargeContext,
      activeProviderUsesLargeContext,
      modelContextWindow: tokenUsage.modelContextWindow ?? undefined,
      assumeDefaultContextWindow,
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
  configuredContextWindow,
  sessionProviderUsesLargeContext,
  activeProviderUsesLargeContext,
  modelContextWindow,
  assumeDefaultContextWindow,
}: {
  model?: string | null;
  configuredContextWindow?: number | null;
  sessionProviderUsesLargeContext: boolean;
  activeProviderUsesLargeContext: boolean;
  modelContextWindow?: number;
  assumeDefaultContextWindow?: boolean;
}): number | null {
  if (configuredContextWindow && configuredContextWindow > 0) {
    return configuredContextWindow;
  }

  if (typeof model === 'string' && model.trim().length > 0) {
    if (model.toLowerCase().includes(LARGE_CONTEXT_MODEL_SUFFIX)) {
      return LARGE_CONTEXT_TOKENS;
    }
  }

  if (modelContextWindow && modelContextWindow > 0) {
    return modelContextWindow;
  }

  if (sessionProviderUsesLargeContext) {
    return LARGE_CONTEXT_TOKENS;
  }

  if (activeProviderUsesLargeContext) {
    return LARGE_CONTEXT_TOKENS;
  }

  return assumeDefaultContextWindow === false ? null : DEFAULT_CONTEXT_TOKENS;
}
