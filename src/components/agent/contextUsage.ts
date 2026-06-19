import type { AgentMessage } from '../../stores/agentStore';

const DEFAULT_CONTEXT_TOKENS = 200_000;
const LARGE_CONTEXT_TOKENS = 1_000_000;
const LARGE_CONTEXT_MODEL_SUFFIX = '[1m]';

export type ContextUsage = {
  usedTokens: number;
  totalTokens: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
};

export function computeContextUsageFromEvents(
  events: AgentMessage[],
  {
    model,
    sessionProviderUsesLargeContext,
    activeProviderUsesLargeContext,
  }: {
    model?: string | null;
    sessionProviderUsesLargeContext: boolean;
    activeProviderUsesLargeContext: boolean;
  },
): ContextUsage {
  let usedTokens = 0;
  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let modelContextWindow: number | undefined;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (usedTokens === 0 && event.kind === 'assistant') {
      const data: any = event.data;
      const usage = data?.last_token_usage || data?.message?.usage || data?.usage;
      const tokenUsage = readTokenUsage(usage);

      if (tokenUsage && tokenUsage.total > 0) {
        inputTokens = tokenUsage.input;
        cachedTokens = tokenUsage.cached;
        outputTokens = tokenUsage.output;
        usedTokens = tokenUsage.total;
      }

      if (!modelContextWindow && data?.model_context_window) {
        modelContextWindow = data.model_context_window;
      }
    }

    if (usedTokens === 0 && event.kind === 'result') {
      const data: any = event.data;
      const usage = data?.last_token_usage || data?.usage;
      const tokenUsage = readTokenUsage(usage);

      if (tokenUsage && tokenUsage.total > 0) {
        inputTokens = tokenUsage.input;
        cachedTokens = tokenUsage.cached;
        outputTokens = tokenUsage.output;
        usedTokens = tokenUsage.total;
      }

      if (!modelContextWindow && data?.model_context_window) {
        modelContextWindow = data.model_context_window;
      }
    }

    if (usedTokens > 0 && modelContextWindow) {
      break;
    }
  }

  const totalTokens = getSessionContextLimit({
    model,
    sessionProviderUsesLargeContext,
    activeProviderUsesLargeContext,
    modelContextWindow,
  });

  return { usedTokens, totalTokens, inputTokens, cachedTokens, outputTokens };
}

function readTokenUsage(usage: any): { input: number; cached: number; output: number; total: number } | null {
  if (!usage) {
    return null;
  }

  const input = readNumber(usage.input_tokens);
  const cached = readNumber(usage.cached_input_tokens ?? usage.cache_read_input_tokens);
  const output = readNumber(usage.output_tokens);
  const total = input + output;

  return { input, cached, output, total };
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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
