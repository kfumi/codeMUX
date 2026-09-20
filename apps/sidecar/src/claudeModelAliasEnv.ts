/**
 * Claude Code CLI resolves model *aliases* (haiku / sonnet / opus) internally —
 * subagents spawned via the Task tool default to a fast-model alias even when
 * the parent turn uses a custom model. Against an Anthropic-compatible gateway
 * those alias codes do not exist (400 modelCode: 不存在), so every alias slot
 * must be remapped onto the session's configured model.
 *
 * `settingSources: user` can load ~/.claude/settings.json with different role
 * mappings; callers must pin these keys in both subprocess `env` and SDK
 * `settings.env` so user settings cannot override the active session model.
 */
export const CLAUDE_MODEL_ALIAS_ENV_KEYS = [
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
] as const;

/** Keys cleared before pinning so stale process/user env cannot leak through. */
export const CLAUDE_MODEL_ALIAS_ENV_WIPE_EXACT = [
  'CLAUDE_CODE_SUBAGENT_MODEL',
] as const;

export function buildClaudeModelAliasEnv(model: string | undefined): Record<string, string> {
  if (!model) return {};
  const aliases: Record<string, string> = {};
  for (const key of CLAUDE_MODEL_ALIAS_ENV_KEYS) {
    aliases[key] = model;
  }
  return aliases;
}

/**
 * Point every CLI model-alias slot at `model`. Only meaningful when the session
 * runs against a custom gateway (`baseUrl` set); the official API resolves
 * aliases natively. Callers apply this AFTER wiping alias keys so user-provided
 * mappings cannot leak into the managed runtime.
 */
export function applyClaudeModelAliasEnv(
  env: Record<string, string | undefined>,
  model: string | undefined,
): void {
  Object.assign(env, buildClaudeModelAliasEnv(model));
}

export function wipeClaudeModelAliasEnv(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith('ANTHROPIC_DEFAULT_')) {
      env[key] = '';
    }
  }
  for (const key of CLAUDE_MODEL_ALIAS_ENV_WIPE_EXACT) {
    env[key] = '';
  }
}
