/**
 * Claude Code CLI resolves model *aliases* (haiku / sonnet / opus) internally —
 * subagents spawned via the Task tool default to a fast-model alias even when
 * the parent turn uses a custom model. Against an Anthropic-compatible gateway
 * those alias codes do not exist (400 modelCode: 不存在), so every alias slot
 * must be remapped onto the session's configured model.
 */
export const CLAUDE_MODEL_ALIAS_ENV_KEYS = [
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
] as const;

/**
 * Point every CLI model-alias slot at `model`. Only meaningful when the session
 * runs against a custom gateway (`baseUrl` set); the official API resolves
 * aliases natively. Callers apply this AFTER the ANTHROPIC_DEFAULT_* wipe so
 * user-provided mappings cannot leak into the managed runtime.
 */
export function applyClaudeModelAliasEnv(
  env: Record<string, string | undefined>,
  model: string | undefined,
): void {
  if (!model) return;
  for (const key of CLAUDE_MODEL_ALIAS_ENV_KEYS) {
    env[key] = model;
  }
}
