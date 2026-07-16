import { describe, expect, it } from 'vitest';
import {
  applyClaudeFormToSettings,
  CLAUDE_SETTINGS_DEFAULT,
  parseClaudeSettingsDraft,
  stripOneMillionSuffix,
  type ClaudeSettingsForm,
} from './claudeSettingsConfig';

const completeForm: ClaudeSettingsForm = {
  apiKey: 'token',
  baseUrl: 'https://api.example/anthropic',
  fallbackModel: 'fallback',
  fallbackSupports1m: false,
  sonnet: { displayName: 'sonnet-name', requestModel: 'sonnet', supports1m: true },
  opus: { displayName: 'opus-name', requestModel: 'opus', supports1m: false },
  fable: { displayName: 'fable-name', requestModel: 'fable', supports1m: true },
  haiku: { displayName: '', requestModel: 'haiku' },
  customModels: [],
};

describe('Claude settings configuration', () => {
  it('provides the expected default settings JSON', () => {
    expect(CLAUDE_SETTINGS_DEFAULT).toEqual({
      env: {
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus',
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'fable',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku',
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Sonnet 5',
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'Opus 4.8',
        ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'Fable 5',
        ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'Haiku 4.5',
      },
      custom_models: [],
      theme: 'auto',
      includeCoAuthoredBy: false,
      autoUpdatesChannel: 'latest',
    });
  });

  it('writes a complete form to every managed environment key', () => {
    expect(applyClaudeFormToSettings(CLAUDE_SETTINGS_DEFAULT, completeForm).env).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'token',
      ANTHROPIC_BASE_URL: 'https://api.example/anthropic',
      ANTHROPIC_MODEL: 'fallback',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet[1M]',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'fable[1M]',
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'sonnet-name',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'opus-name',
      ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'fable-name',
    });
  });

  it('does not append the 1M suffix when an eligible role disables it', () => {
    const settings = applyClaudeFormToSettings(CLAUDE_SETTINGS_DEFAULT, {
      ...completeForm,
      sonnet: { ...completeForm.sonnet, requestModel: ' model [1M] ', supports1m: false },
      fable: { ...completeForm.fable, supports1m: false },
    });

    expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('model');
    expect(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('opus');
    expect(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('fable');
  });

  it('removes an empty role model after stripping the 1M suffix', () => {
    const existingSettings = { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'old-model' } };
    const enabled = applyClaudeFormToSettings(existingSettings, {
      ...completeForm,
      sonnet: { ...completeForm.sonnet, requestModel: ' [1M] ', supports1m: true },
    });
    const disabled = applyClaudeFormToSettings(existingSettings, {
      ...completeForm,
      sonnet: { ...completeForm.sonnet, requestModel: ' [1M] ', supports1m: false },
    });

    expect(enabled.env).not.toHaveProperty('ANTHROPIC_DEFAULT_SONNET_MODEL');
    expect(disabled.env).not.toHaveProperty('ANTHROPIC_DEFAULT_SONNET_MODEL');
  });

  it('parses JSON back into a form while preserving unknown fields', () => {
    const parsed = parseClaudeSettingsDraft(JSON.stringify({
      env: {
        KEEP: 'preserved',
        ANTHROPIC_AUTH_TOKEN: 'token',
        ANTHROPIC_BASE_URL: 'https://api.example/anthropic',
        ANTHROPIC_MODEL: 'fallback',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet[1M]',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus',
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'fable[1M]',
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'sonnet-name',
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'opus-name',
        ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'fable-name',
      },
      custom: { keep: true },
    }));

    expect(parsed.form).toEqual({
      ...completeForm,
      haiku: { displayName: '', requestModel: 'haiku' },
    });
    expect(parsed.settings).toMatchObject({
      env: { KEEP: 'preserved' },
      custom: { keep: true },
    });
  });

  it('retains unknown keys through a JSON to form to JSON round trip', () => {
    const parsed = parseClaudeSettingsDraft('{"env":{"KEEP":"preserved","ANTHROPIC_DEFAULT_OPUS_MODEL":"opus[1M]"},"custom":{"keep":true}}');
    const result = applyClaudeFormToSettings(parsed.settings, parsed.form);

    expect(result).toMatchObject({
      env: { KEEP: 'preserved', ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus[1M]' },
      custom: { keep: true },
    });
  });

  it('rejects invalid JSON with a clear Chinese error', () => {
    expect(() => parseClaudeSettingsDraft('{')).toThrow('配置 JSON 无效。');
  });

  it('rejects settings whose env value is not an object', () => {
    for (const source of ['{"env":"invalid"}', '{"env":null}', '{"env":[]}']) {
      expect(() => parseClaudeSettingsDraft(source)).toThrow('配置 JSON 的 env 必须为对象。');
    }
  });

  it('rejects an array as the top-level settings value', () => {
    expect(() => parseClaudeSettingsDraft('[]')).toThrow('配置 JSON 必须为对象。');
  });

  it('removes managed environment keys for empty form values', () => {
    const settings = applyClaudeFormToSettings({
      env: {
        KEEP: 'preserved',
        ANTHROPIC_AUTH_TOKEN: 'old-token',
        ANTHROPIC_BASE_URL: 'old-url',
        ANTHROPIC_MODEL: 'old-fallback',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'old-haiku',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'old-sonnet',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'old-opus',
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'old-fable',
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'old-sonnet-name',
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'old-opus-name',
        ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'old-fable-name',
      },
    }, {
      apiKey: '',
      baseUrl: '',
      fallbackModel: '',
      fallbackSupports1m: false,
      sonnet: { displayName: '', requestModel: '', supports1m: false },
      opus: { displayName: '', requestModel: '', supports1m: false },
      fable: { displayName: '', requestModel: '', supports1m: false },
      haiku: { displayName: '', requestModel: '' },
      customModels: [],
    });

    expect(settings.env).toEqual({ KEEP: 'preserved' });
  });

  it('does not expose a 1M flag or display name for Haiku and leaves its model unchanged', () => {
    const parsed = parseClaudeSettingsDraft('{"env":{"ANTHROPIC_DEFAULT_HAIKU_MODEL":"haiku[1M]"}}');
    const result = applyClaudeFormToSettings(CLAUDE_SETTINGS_DEFAULT, parsed.form);

    expect(parsed.form.haiku).toEqual({ displayName: '', requestModel: 'haiku[1M]' });
    expect(result.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('haiku[1M]');
    expect('supports1m' in parsed.form.haiku).toBe(false);
  });

  it('does not mutate the settings object supplied to the form writer', () => {
    const settings = {
      env: { KEEP: 'preserved', ANTHROPIC_DEFAULT_SONNET_MODEL: 'old-model' },
      custom: { keep: true },
    };
    const original = structuredClone(settings);

    applyClaudeFormToSettings(settings, completeForm);

    expect(settings).toEqual(original);
  });

  it('strips only one trailing 1M suffix', () => {
    expect(stripOneMillionSuffix('model[1M][1M]')).toEqual({ value: 'model[1M]', supports1m: true });
    expect(stripOneMillionSuffix('model [1M]')).toEqual({ value: 'model ', supports1m: true });
    expect(stripOneMillionSuffix('model[1m]')).toEqual({ value: 'model[1m]', supports1m: false });
  });

  it('writes ANTHROPIC_MODEL with 1M suffix when fallbackSupports1m is true', () => {
    const result = applyClaudeFormToSettings(CLAUDE_SETTINGS_DEFAULT, {
      ...completeForm,
      fallbackModel: 'claude-sonnet-4-20250514',
      fallbackSupports1m: true,
    });
    expect(result.env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-20250514[1M]');
  });

  it('writes ANTHROPIC_MODEL without 1M suffix when fallbackSupports1m is false', () => {
    const result = applyClaudeFormToSettings(CLAUDE_SETTINGS_DEFAULT, {
      ...completeForm,
      fallbackModel: 'claude-sonnet-4-20250514',
      fallbackSupports1m: false,
    });
    expect(result.env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-20250514');
  });

  it('persists and restores custom models through round trip', () => {
    const formWithCustom: ClaudeSettingsForm = {
      ...completeForm,
      customModels: [
        { displayName: 'DeepSeek V4', requestModel: 'deepseek-v4' },
        { displayName: 'Qwen Max', requestModel: 'qwen-max' },
      ],
    };

    const settings = applyClaudeFormToSettings(CLAUDE_SETTINGS_DEFAULT, formWithCustom);
    expect(settings.custom_models).toEqual([
      { displayName: 'DeepSeek V4', requestModel: 'deepseek-v4' },
      { displayName: 'Qwen Max', requestModel: 'qwen-max' },
    ]);

    const parsed = parseClaudeSettingsDraft(JSON.stringify(settings));
    expect(parsed.form.customModels).toEqual([
      { displayName: 'DeepSeek V4', requestModel: 'deepseek-v4' },
      { displayName: 'Qwen Max', requestModel: 'qwen-max' },
    ]);
  });

  it('removes custom_models key when customModels is empty', () => {
    const settingsWithCustom = {
      env: {},
      custom_models: [{ displayName: 'test', requestModel: 'test' }],
    };
    const result = applyClaudeFormToSettings(settingsWithCustom, {
      ...completeForm,
      customModels: [],
    });
    expect(result).not.toHaveProperty('custom_models');
  });
});
