import type { Provider } from '../types/provider';

interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Calculate cost based on provider pricing config.
 * Returns null if pricing is not fully configured.
 */
export function calculateCost(usage: TokenUsage | undefined, provider: Provider | null): number | null {
  if (!usage || !provider) return null;

  const { input_price, cache_read_price, output_price } = provider;
  if (input_price == null || output_price == null) return null;

  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreation = usage.cache_creation_input_tokens || 0;

  // Non-cached input = total input - cache read - cache creation
  const normalInput = Math.max(0, input - cacheRead - cacheCreation);

  let cost = (normalInput * input_price + output * output_price) / 1_000_000;

  if (cache_read_price != null && cacheRead > 0) {
    cost += (cacheRead * cache_read_price) / 1_000_000;
  }
  // Cache creation is billed at input price
  if (cacheCreation > 0) {
    cost += (cacheCreation * input_price) / 1_000_000;
  }

  return cost;
}
