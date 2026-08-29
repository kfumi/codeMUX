import { describe, expect, it } from 'vitest';
import { applyClaudeModelAliasEnv, CLAUDE_MODEL_ALIAS_ENV_KEYS } from './claudeModelAliasEnv.js';

describe('applyClaudeModelAliasEnv', () => {
  it('pins every CLI model-alias slot to the session model', () => {
    const env: Record<string, string | undefined> = {};
    applyClaudeModelAliasEnv(env, 'glm-5.3-flash');

    expect(CLAUDE_MODEL_ALIAS_ENV_KEYS.length).toBeGreaterThan(0);
    for (const key of CLAUDE_MODEL_ALIAS_ENV_KEYS) {
      expect(env[key]).toBe('glm-5.3-flash');
    }
  });

  it('overrides user-provided ANTHROPIC_DEFAULT_* mappings', () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-3-5-haiku-20241022',
      ANTHROPIC_SMALL_FAST_MODEL: 'claude-3-5-haiku-20241022',
    };
    applyClaudeModelAliasEnv(env, 'glm-5.3-flash');

    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5.3-flash');
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('glm-5.3-flash');
  });

  it('does nothing without a session model', () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'keep' };
    applyClaudeModelAliasEnv(env, undefined);

    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('keep');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
  });
});
