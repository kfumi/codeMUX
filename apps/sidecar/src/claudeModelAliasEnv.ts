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
  wipeEnvKeys(env, CLAUDE_MODEL_ALIAS_ENV_WIPE_EXACT);
}

/**
 * Env keys that Claude Code reads from the `env` block of user settings
 * (`~/.claude/settings.json`) and that override CodeMUX's own context
 * configuration. The managed runtime loads user settings
 * (`settingSources: ['user','project']`), so a settings file written by another
 * tool can silently cap the session's context window. Observed case: a
 * Magpie-managed settings.json set `CLAUDE_CODE_AUTO_COMPACT_WINDOW=272000`,
 * which Claude Code applies as the auto-compact window
 * (`window = min(modelWindow, configured)`), so a `[1m]` 1M-context session
 * still auto-compacted at ~239k tokens (272000 − 20000 output reserve − 13000).
 *
 * These keys must be cleared both in the subprocess `env` and in the SDK
 * `settings.env` flag layer (the highest-precedence user layer) so the in-app
 * model context config wins over an external settings.json.
 */
export const CLAUDE_CONTEXT_ENV_KEYS = [
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
] as const;

/** Clear context/compaction env keys so they cannot cap the session window. */
export function wipeClaudeContextEnv(env: Record<string, string | undefined>): void {
  wipeEnvKeys(env, CLAUDE_CONTEXT_ENV_KEYS);
}

/** The same wipe as a fresh object, for injection into `settings.env`. */
export function buildClaudeContextEnvWipe(): Record<string, string> {
  const env: Record<string, string> = {};
  wipeClaudeContextEnv(env);
  return env;
}

/** Empty string is the "unset" convention used by every Claude env wipe here. */
function wipeEnvKeys(
  env: Record<string, string | undefined>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    env[key] = '';
  }
}
