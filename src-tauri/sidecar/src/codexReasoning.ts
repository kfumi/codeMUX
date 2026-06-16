// src-tauri/sidecar/src/codexReasoning.ts

export interface ReasoningConfig {
  supports_thinking: boolean;
  supports_effort: boolean;
  thinking_param: 'thinking' | 'enable_thinking' | 'reasoning_split' | 'none';
  effort_param: string;
  effort_value_mode: string;
  output_format: string;
}

const CONFIGS: Record<string, ReasoningConfig> = {
  deepseek: {
    supports_thinking: true, supports_effort: true,
    thinking_param: 'thinking', effort_param: 'reasoning_effort',
    effort_value_mode: 'deepseek', output_format: 'reasoning_content',
  },
  kimi: {
    supports_thinking: true, supports_effort: false,
    thinking_param: 'thinking', effort_param: 'none',
    effort_value_mode: '', output_format: 'reasoning_content',
  },
  qwen: {
    supports_thinking: true, supports_effort: false,
    thinking_param: 'enable_thinking', effort_param: 'none',
    effort_value_mode: '', output_format: 'reasoning_content',
  },
  glm: {
    supports_thinking: true, supports_effort: false,
    thinking_param: 'thinking', effort_param: 'none',
    effort_value_mode: '', output_format: 'reasoning_content',
  },
  minimax: {
    supports_thinking: true, supports_effort: false,
    thinking_param: 'reasoning_split', effort_param: 'none',
    effort_value_mode: '', output_format: 'reasoning_details',
  },
  mimo: {
    supports_thinking: true, supports_effort: false,
    thinking_param: 'thinking', effort_param: 'none',
    effort_value_mode: '', output_format: 'reasoning_content',
  },
  stepfun: {
    supports_thinking: true, supports_effort: true,
    thinking_param: 'none', effort_param: 'reasoning_effort',
    effort_value_mode: 'low_high', output_format: 'reasoning',
  },
};

const PLATFORM_CONFIGS: Array<{ match: (name: string, url: string) => boolean; config: ReasoningConfig }> = [
  {
    match: (name, url) => {
      const id = `${name} ${url}`.toLowerCase();
      return id.includes('siliconflow') || id.includes('siliconflow.cn');
    },
    config: {
      supports_thinking: true, supports_effort: false,
      thinking_param: 'enable_thinking', effort_param: 'none',
      effort_value_mode: '', output_format: 'reasoning_content',
    },
  },
  {
    match: (name, url) => `${name} ${url}`.toLowerCase().includes('openrouter'),
    config: {
      supports_thinking: true, supports_effort: true,
      thinking_param: 'none', effort_param: 'reasoning',
      effort_value_mode: 'openrouter', output_format: 'reasoning',
    },
  },
];

const MODEL_IDENTIFIERS: Array<{ keywords: string[]; key: string }> = [
  { keywords: ['deepseek'], key: 'deepseek' },
  { keywords: ['kimi', 'moonshot'], key: 'kimi' },
  { keywords: ['qwen', 'dashscope', 'bailian'], key: 'qwen' },
  { keywords: ['glm', 'zhipu', 'z.ai'], key: 'glm' },
  { keywords: ['minimax'], key: 'minimax' },
  { keywords: ['mimo'], key: 'mimo' },
  { keywords: ['stepfun', 'step-3.5-flash-2603'], key: 'stepfun' },
];

export function inferReasoningConfig(model: string, baseUrl: string, providerName: string): ReasoningConfig | null {
  for (const entry of PLATFORM_CONFIGS) {
    if (entry.match(providerName, baseUrl)) return entry.config;
  }
  const haystack = `${providerName} ${baseUrl} ${model}`.toLowerCase();
  for (const { keywords, key } of MODEL_IDENTIFIERS) {
    if (keywords.some((kw) => haystack.includes(kw))) return CONFIGS[key];
  }
  return null;
}

/**
 * Check if reasoning is requested in the request body.
 * Returns: true (enabled), false (explicitly disabled), undefined (not specified).
 */
function reasoningRequested(body: Record<string, unknown>): boolean | undefined {
  const reasoning = body.reasoning;
  if (reasoning === undefined || reasoning === null) return undefined;
  if (typeof reasoning === 'object') {
    const effort = (reasoning as Record<string, unknown>).effort;
    if (typeof effort === 'string') {
      const lower = effort.trim().toLowerCase();
      if (lower === 'none' || lower === 'off' || lower === 'disabled') return false;
      return true;
    }
  }
  return true;
}

/**
 * Map effort value according to the mode.
 * Returns the mapped value, or null if effort should be suppressed (e.g. 'none').
 */
function mapEffortValue(effort: string, mode: string): string | null {
  const lower = effort.trim().toLowerCase();
  if (lower === 'none' || lower === 'off' || lower === 'disabled') return null;

  switch (mode) {
    case 'deepseek':
      // max/xhigh → max, everything else → high
      return (lower === 'max' || lower === 'xhigh') ? 'max' : 'high';
    case 'low_high':
      // minimal/low → low, everything else → high
      return (lower === 'minimal' || lower === 'low') ? 'low' : 'high';
    case 'openrouter':
      // full mapping: minimal/low/medium/high/xhigh (max → xhigh since max is invalid for OpenRouter)
      if (lower === 'max') return 'xhigh';
      if (['minimal', 'low', 'medium', 'high', 'xhigh'].includes(lower)) return lower;
      return null;
    default:
      // passthrough
      return lower;
  }
}

export function applyReasoningOptions(
  chatBody: Record<string, unknown>,
  responsesBody: Record<string, unknown>,
  model: string,
  config: ReasoningConfig | null,
): void {
  if (!config) {
    // No config: only handle o-series reasoning_effort
    if (model.toLowerCase().startsWith('o')) {
      const effort = (responsesBody.reasoning as Record<string, unknown> | undefined)?.effort;
      if (typeof effort === 'string') chatBody.reasoning_effort = effort;
    }
    return;
  }

  const enabled = reasoningRequested(responsesBody);
  const supportsThinking = config.supports_thinking || config.supports_effort;

  // P1-6: Inject thinking parameter (enabled or disabled)
  if (supportsThinking && config.thinking_param !== 'none') {
    switch (config.thinking_param) {
      case 'thinking': chatBody.thinking = { type: enabled === false ? 'disabled' : 'enabled' }; break;
      case 'enable_thinking': chatBody.enable_thinking = enabled !== false; break;
      case 'reasoning_split': chatBody.reasoning_split = enabled !== false; break;
    }
  }

  // P1-6: If reasoning is explicitly disabled, inject close parameters and return
  if (enabled === false) {
    if (config.effort_param === 'reasoning') {
      chatBody.reasoning = { effort: 'none' };
    } else if (config.effort_param !== 'none') {
      chatBody[config.effort_param] = 'none';
    }
    return;
  }

  // If reasoning is not specified, don't inject effort
  if (enabled === undefined) return;

  // P1-5: Inject effort parameter with proper mapping
  if (config.supports_effort && config.effort_param !== 'none') {
    const effort = (responsesBody.reasoning as Record<string, unknown> | undefined)?.effort as string | undefined;
    if (effort !== undefined) {
      const mapped = mapEffortValue(effort, config.effort_value_mode);
      if (mapped !== null) {
        if (config.effort_param === 'reasoning') {
          // OpenRouter uses nested reasoning: { effort: value }
          chatBody.reasoning = { effort: mapped };
        } else {
          chatBody[config.effort_param] = mapped;
        }
      }
    }
  }
}
