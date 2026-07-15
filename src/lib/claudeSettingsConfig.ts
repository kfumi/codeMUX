export type ClaudeSettings = Record<string, unknown> & {
  env: Record<string, unknown>;
};

export type ClaudeRoleMapping = {
  displayName: string;
  requestModel: string;
  supports1m: boolean;
};

type ClaudeHaikuRoleMapping = {
  displayName: string;
  requestModel: string;
};

export type ClaudeSettingsForm = {
  apiKey: string;
  baseUrl: string;
  fallbackModel: string;
  sonnet: ClaudeRoleMapping;
  opus: ClaudeRoleMapping;
  fable: ClaudeRoleMapping;
  haiku: ClaudeHaikuRoleMapping;
};

export const CLAUDE_SETTINGS_DEFAULT: ClaudeSettings = {
  env: {},
  theme: 'auto',
  includeCoAuthoredBy: false,
  autoUpdatesChannel: 'latest',
};

const MANAGED_ENV_KEYS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
] as const;

type ManagedEnvKey = typeof MANAGED_ENV_KEYS[number];

type OneMillionSuffix = {
  value: string;
  supports1m: boolean;
};

export function parseClaudeSettingsDraft(source: string): {
  settings: ClaudeSettings;
  form: ClaudeSettingsForm;
} {
  let value: unknown;

  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('配置 JSON 无效。');
  }

  if (!isRecord(value)) {
    throw new Error('配置 JSON 必须为对象。');
  }

  if (!isRecord(value.env)) {
    throw new Error('配置 JSON 的 env 必须为对象。');
  }

  const settings: ClaudeSettings = { ...value, env: { ...value.env } };
  return { settings, form: formFromClaudeSettings(settings) };
}

export function applyClaudeFormToSettings(
  settings: Record<string, unknown>,
  form: ClaudeSettingsForm,
): ClaudeSettings {
  const env = isRecord(settings.env) ? { ...settings.env } : {};

  writeManagedValue(env, 'ANTHROPIC_AUTH_TOKEN', form.apiKey);
  writeManagedValue(env, 'ANTHROPIC_BASE_URL', form.baseUrl);
  writeManagedValue(env, 'ANTHROPIC_MODEL', form.fallbackModel);
  writeManagedValue(env, 'ANTHROPIC_DEFAULT_HAIKU_MODEL', form.haiku.requestModel);
  writeRoleModel(env, 'ANTHROPIC_DEFAULT_SONNET_MODEL', form.sonnet);
  writeRoleModel(env, 'ANTHROPIC_DEFAULT_OPUS_MODEL', form.opus);
  writeRoleModel(env, 'ANTHROPIC_DEFAULT_FABLE_MODEL', form.fable);
  writeManagedValue(env, 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', form.sonnet.displayName);
  writeManagedValue(env, 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', form.opus.displayName);
  writeManagedValue(env, 'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME', form.fable.displayName);

  return { ...settings, env };
}

export function stripOneMillionSuffix(value: string): OneMillionSuffix {
  const suffix = '[1M]';
  if (!value.endsWith(suffix)) {
    return { value, supports1m: false };
  }

  return {
    value: value.slice(0, -suffix.length),
    supports1m: true,
  };
}

function formFromClaudeSettings(settings: ClaudeSettings): ClaudeSettingsForm {
  const sonnet = stripOneMillionSuffix(envString(settings.env, 'ANTHROPIC_DEFAULT_SONNET_MODEL'));
  const opus = stripOneMillionSuffix(envString(settings.env, 'ANTHROPIC_DEFAULT_OPUS_MODEL'));
  const fable = stripOneMillionSuffix(envString(settings.env, 'ANTHROPIC_DEFAULT_FABLE_MODEL'));

  return {
    apiKey: envString(settings.env, 'ANTHROPIC_AUTH_TOKEN'),
    baseUrl: envString(settings.env, 'ANTHROPIC_BASE_URL'),
    fallbackModel: envString(settings.env, 'ANTHROPIC_MODEL'),
    sonnet: {
      displayName: envString(settings.env, 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME'),
      requestModel: sonnet.value,
      supports1m: sonnet.supports1m,
    },
    opus: {
      displayName: envString(settings.env, 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME'),
      requestModel: opus.value,
      supports1m: opus.supports1m,
    },
    fable: {
      displayName: envString(settings.env, 'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME'),
      requestModel: fable.value,
      supports1m: fable.supports1m,
    },
    haiku: {
      displayName: '',
      requestModel: envString(settings.env, 'ANTHROPIC_DEFAULT_HAIKU_MODEL'),
    },
  };
}

function writeRoleModel(
  env: Record<string, unknown>,
  key: Extract<ManagedEnvKey, `ANTHROPIC_DEFAULT_${string}_MODEL`>,
  role: ClaudeRoleMapping,
): void {
  const requestModel = normalizedValue(role.requestModel);
  if (!requestModel) {
    delete env[key];
    return;
  }

  const normalizedModel = stripOneMillionSuffix(requestModel).value.trim();
  env[key] = role.supports1m ? `${normalizedModel}[1M]` : normalizedModel;
}

function writeManagedValue(env: Record<string, unknown>, key: ManagedEnvKey, value: string): void {
  const normalized = normalizedValue(value);
  if (normalized) {
    env[key] = normalized;
  } else {
    delete env[key];
  }
}

function envString(env: Record<string, unknown>, key: ManagedEnvKey): string {
  const value = env[key];
  return typeof value === 'string' ? value : '';
}

function normalizedValue(value: string): string {
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
