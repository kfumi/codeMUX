import type { AgentMessage } from '../../stores/agentStore';
import type { AgentKind } from '../../types/session';

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

type UsageSnapshot = {
  input: number;
  cached: number;
  output: number;
};

export function computeContextUsageFromEvents(
  events: AgentMessage[],
  {
    model,
    sessionProviderUsesLargeContext,
    activeProviderUsesLargeContext,
    agentKind = 'claude_code',
  }: {
    model?: string | null;
    sessionProviderUsesLargeContext: boolean;
    activeProviderUsesLargeContext: boolean;
    agentKind?: AgentKind;
  },
): ContextUsage {
  let usedTokens = 0;
  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let modelContextWindow: number | undefined;

  if (agentKind === 'claude_code') {
    const lastResult = findLastResult(events);
    if (lastResult) {
      const data: any = lastResult.data;
      const usage = readResultUsage(data);
      if (usage) {
        inputTokens = usage.input;
        cachedTokens = usage.cached;
        outputTokens = usage.output;
        usedTokens = inputTokens;
      }
      modelContextWindow = readPositiveNumber(data?.model_context_window);
    } else {
      const usage = findLastClaudeAssistantUsage(events);
      if (usage) {
        inputTokens = usage.input;
        cachedTokens = usage.cached;
        outputTokens = usage.output;
        usedTokens = inputTokens;
      }
    }
  } else {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];

      if (usedTokens === 0 && event.kind === 'assistant') {
        const data: any = event.data;
        const msg = data?.message;

        if (msg && !msg.stop_reason && hasThinkingContentOnly(msg.content)) {
          continue;
        }
        const usage = data?.last_token_usage || msg?.usage || data?.usage;
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
  }

  const totalTokens = getSessionContextLimit({
    model,
    sessionProviderUsesLargeContext,
    activeProviderUsesLargeContext,
    modelContextWindow,
  });

  return { usedTokens, totalTokens, inputTokens, cachedTokens, outputTokens };
}

function findLastResult(events: AgentMessage[]): Extract<AgentMessage, { kind: 'result' }> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === 'result') {
      return event;
    }
  }

  return null;
}

function readResultUsage(data: any): UsageSnapshot | null {
  const usage = data?.last_token_usage ?? data?.usage;
  const tokenUsage = readTokenUsage(usage);
  return tokenUsage && hasAnyToken(tokenUsage) ? tokenUsage : null;
}

function findLastClaudeAssistantUsage(events: AgentMessage[]): UsageSnapshot | null {
  let lastUsage: UsageSnapshot | null = null;

  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === 'assistant') {
      const data: any = event.data;
      const msg = data?.message;
      const usage = msg?.usage || data?.usage;

      if (usage) {
        const tokenUsage = readTokenUsage(usage);
        if (!tokenUsage || !hasAnyToken(tokenUsage)) {
          continue;
        }

        if (msg?.stop_reason) {
          return tokenUsage;
        }

        if (!lastUsage) {
          lastUsage = tokenUsage;
        }
      } else {
        const messageWithUsage = findLastMessageWithUsage(data);
        if (messageWithUsage && !lastUsage) {
          const tokenUsage = readTokenUsage(messageWithUsage);
          if (tokenUsage && hasAnyToken(tokenUsage)) {
            lastUsage = tokenUsage;
          }
        }
      }
    }
  }

  return lastUsage;
}

function findLastMessageWithUsage(data: any): { input_tokens: number; cache_read_input_tokens: number; output_tokens: number } | null {
  if (!data) return null;

  if (data.type === 'message' && data.usage) {
    return data.usage;
  }

  if (Array.isArray(data.messages)) {
    for (let i = data.messages.length - 1; i >= 0; i--) {
      const msg = data.messages[i];
      if (msg.type === 'message' && msg.usage) {
        return msg.usage;
      }
    }
  }

  if (data.message && data.message.type === 'message' && data.message.usage) {
    return data.message.usage;
  }

  return null;
}

function readTokenUsage(usage: any): UsageSnapshot & { total: number } | null {
  if (!usage) {
    return null;
  }

  const input = readNumber(usage.input_tokens);
  const cached = readNumber(usage.cached_input_tokens ?? usage.cache_read_input_tokens);
  const output = readNumber(usage.output_tokens);
  const total = input + output;

  return { input, cached, output, total };
}

function hasAnyToken(usage: UsageSnapshot): boolean {
  return usage.input > 0 || usage.cached > 0 || usage.output > 0;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readPositiveNumber(value: unknown): number | undefined {
  const number = readNumber(value);
  return number > 0 ? number : undefined;
}

function hasThinkingContentOnly(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every(
    (block: any) => block?.type === 'thinking',
  );
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
