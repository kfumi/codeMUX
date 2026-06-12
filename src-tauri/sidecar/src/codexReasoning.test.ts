// src-tauri/sidecar/src/codexReasoning.test.ts
import { describe, expect, it } from 'vitest';
import { inferReasoningConfig, applyReasoningOptions } from './codexReasoning.js';

describe('inferReasoningConfig', () => {
  it('returns DeepSeek config for deepseek model', () => {
    const config = inferReasoningConfig('deepseek-chat', 'https://api.deepseek.com/v1', '');
    expect(config).toEqual({
      supports_thinking: true,
      supports_effort: true,
      thinking_param: 'thinking',
      effort_param: 'reasoning_effort',
      effort_value_mode: 'deepseek',
      output_format: 'reasoning_content',
    });
  });

  it('returns MiMo config for mimo model', () => {
    const config = inferReasoningConfig('mimo-v2.5-pro', 'https://api.example.com/v1', '');
    expect(config).toEqual({
      supports_thinking: true,
      supports_effort: false,
      thinking_param: 'thinking',
      effort_param: 'none',
      effort_value_mode: '',
      output_format: 'reasoning_content',
    });
  });

  it('returns Qwen config for qwen model', () => {
    const config = inferReasoningConfig('qwen-plus', 'https://dashscope.aliyuncs.com/v1', '');
    expect(config).toEqual({
      supports_thinking: true,
      supports_effort: false,
      thinking_param: 'enable_thinking',
      effort_param: 'none',
      effort_value_mode: '',
      output_format: 'reasoning_content',
    });
  });

  it('returns Kimi config for moonshot model', () => {
    const config = inferReasoningConfig('moonshot-v1-auto', 'https://api.moonshot.cn/v1', '');
    expect(config?.thinking_param).toBe('thinking');
    expect(config?.output_format).toBe('reasoning_content');
  });

  it('returns MiniMax config with reasoning_split', () => {
    const config = inferReasoningConfig('MiniMax-Text-01', 'https://api.minimax.chat/v1', '');
    expect(config?.thinking_param).toBe('reasoning_split');
    expect(config?.output_format).toBe('reasoning_details');
  });

  it('returns GLM config for zhipu model', () => {
    const config = inferReasoningConfig('glm-4-plus', 'https://open.bigmodel.cn/api/paas/v4', '');
    expect(config?.thinking_param).toBe('thinking');
    expect(config?.output_format).toBe('reasoning_content');
  });

  it('returns StepFun config with effort support', () => {
    const config = inferReasoningConfig('step-3.5-flash-2603', 'https://api.stepfun.com/v1', '');
    expect(config?.thinking_param).toBe('none');
    expect(config?.supports_effort).toBe(true);
    expect(config?.effort_value_mode).toBe('low_high');
    expect(config?.output_format).toBe('reasoning');
  });

  it('returns SiliconFlow platform config overriding model name', () => {
    const config = inferReasoningConfig('deepseek-ai/DeepSeek-R1', 'https://api.siliconflow.cn/v1', '');
    expect(config?.thinking_param).toBe('enable_thinking');
    expect(config?.output_format).toBe('reasoning_content');
  });

  it('returns OpenRouter platform config', () => {
    const config = inferReasoningConfig('deepseek/deepseek-r1', 'https://openrouter.ai/api/v1', '');
    expect(config?.thinking_param).toBe('none');
    expect(config?.effort_param).toBe('reasoning');
    expect(config?.output_format).toBe('reasoning');
  });

  it('returns null for unknown model', () => {
    const config = inferReasoningConfig('gpt-4o', 'https://api.openai.com/v1', '');
    expect(config).toBeNull();
  });

  it('matches model name case-insensitively', () => {
    const config = inferReasoningConfig('DeepSeek-R1', 'https://api.deepseek.com/v1', '');
    expect(config?.thinking_param).toBe('thinking');
  });
});

describe('applyReasoningOptions', () => {
  it('injects thinking: {type: "enabled"} for DeepSeek', () => {
    const chatBody: Record<string, unknown> = {};
    const config = inferReasoningConfig('deepseek-chat', 'https://api.deepseek.com/v1', '')!;
    applyReasoningOptions(chatBody, {}, 'deepseek-chat', config);
    expect(chatBody.thinking).toEqual({ type: 'enabled' });
    expect(chatBody.reasoning_effort).toBeUndefined();
  });

  it('injects enable_thinking: true for Qwen', () => {
    const chatBody: Record<string, unknown> = {};
    const config = inferReasoningConfig('qwen-plus', 'https://dashscope.aliyuncs.com/v1', '')!;
    applyReasoningOptions(chatBody, {}, 'qwen-plus', config);
    expect(chatBody.enable_thinking).toBe(true);
  });

  it('injects reasoning_split: true for MiniMax', () => {
    const chatBody: Record<string, unknown> = {};
    const config = inferReasoningConfig('MiniMax-Text-01', 'https://api.minimax.chat/v1', '')!;
    applyReasoningOptions(chatBody, {}, 'MiniMax-Text-01', config);
    expect(chatBody.reasoning_split).toBe(true);
  });

  it('passes through reasoning_effort for DeepSeek when Responses body has effort', () => {
    const chatBody: Record<string, unknown> = {};
    const responsesBody = { reasoning: { effort: 'high' } };
    const config = inferReasoningConfig('deepseek-chat', 'https://api.deepseek.com/v1', '')!;
    applyReasoningOptions(chatBody, responsesBody, 'deepseek-chat', config);
    expect(chatBody.thinking).toEqual({ type: 'enabled' });
    expect(chatBody.reasoning_effort).toBe('high');
  });

  it('maps effort to low/high for StepFun', () => {
    const chatBody: Record<string, unknown> = {};
    const responsesBody = { reasoning: { effort: 'medium' } };
    const config = inferReasoningConfig('step-3.5-flash-2603', 'https://api.stepfun.com/v1', '')!;
    applyReasoningOptions(chatBody, responsesBody, 'step-3.5-flash-2603', config);
    expect(chatBody.reasoning_effort).toBe('low');
  });

  it('passes reasoning_effort through for OpenRouter', () => {
    const chatBody: Record<string, unknown> = {};
    const responsesBody = { reasoning: { effort: 'medium' } };
    const config = inferReasoningConfig('deepseek/deepseek-r1', 'https://openrouter.ai/api/v1', '')!;
    applyReasoningOptions(chatBody, responsesBody, 'deepseek/deepseek-r1', config);
    expect(chatBody.reasoning).toEqual({ effort: 'medium' });
  });

  it('only passes reasoning_effort for o-series when no config', () => {
    const chatBody: Record<string, unknown> = {};
    const responsesBody = { reasoning: { effort: 'high' } };
    applyReasoningOptions(chatBody, responsesBody, 'o4-mini', null);
    expect(chatBody.reasoning_effort).toBe('high');
  });

  it('does nothing for unknown model with no config and no effort', () => {
    const chatBody: Record<string, unknown> = {};
    applyReasoningOptions(chatBody, {}, 'gpt-4o', null);
    expect(Object.keys(chatBody)).toHaveLength(0);
  });
});
