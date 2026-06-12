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
  { keywords: ['qwen', 'dashscope'], key: 'qwen' },
  { keywords: ['glm', 'zhipu'], key: 'glm' },
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

export function applyReasoningOptions(
  chatBody: Record<string, unknown>,
  responsesBody: Record<string, unknown>,
  model: string,
  config: ReasoningConfig | null,
): void {
  if (!config) {
    if (model.toLowerCase().startsWith('o')) {
      const effort = (responsesBody.reasoning as Record<string, unknown> | undefined)?.effort;
      if (typeof effort === 'string') chatBody.reasoning_effort = effort;
    }
    return;
  }
  switch (config.thinking_param) {
    case 'thinking': chatBody.thinking = { type: 'enabled' }; break;
    case 'enable_thinking': chatBody.enable_thinking = true; break;
    case 'reasoning_split': chatBody.reasoning_split = true; break;
    default: break;
  }
  if (config.supports_effort && config.effort_param !== 'none') {
    const effort = (responsesBody.reasoning as Record<string, unknown> | undefined)?.effort as string | undefined;
    if (effort !== undefined) {
      switch (config.effort_value_mode) {
        case 'deepseek': chatBody[config.effort_param] = effort; break;
        case 'low_high': chatBody[config.effort_param] = effort === 'high' ? 'high' : 'low'; break;
        case 'openrouter': chatBody[config.effort_param] = { effort }; break;
        default: chatBody[config.effort_param] = effort; break;
      }
    }
  }
}
