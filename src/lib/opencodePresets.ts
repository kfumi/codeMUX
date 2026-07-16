export const OPENCODE_NPM_PACKAGES = [
  { value: '@ai-sdk/openai', label: 'OpenAI Responses' },
  { value: '@ai-sdk/openai-compatible', label: 'OpenAI Compatible' },
  { value: '@ai-sdk/anthropic', label: 'Anthropic' },
  { value: '@ai-sdk/amazon-bedrock', label: 'Amazon Bedrock' },
  { value: '@ai-sdk/google', label: 'Google (Gemini)' },
] as const;

export const OPENCODE_DEFAULT_NPM = '@ai-sdk/openai-compatible';

export const OPENCODE_DEFAULT_CONFIG = JSON.stringify(
  {
    npm: OPENCODE_DEFAULT_NPM,
    options: { baseURL: '', apiKey: '', setCacheKey: true },
    models: {},
  },
  null,
  2,
);
