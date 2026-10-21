import { describe, expect, it } from 'vitest';
import {
  applyClaudeModelAliasEnv,
  buildClaudeContextEnvWipe,
  buildClaudeModelAliasEnv,
  CLAUDE_CONTEXT_ENV_KEYS,
  CLAUDE_MODEL_ALIAS_ENV_KEYS,
  wipeClaudeContextEnv,
  wipeClaudeModelAliasEnv,
} from './claudeModelAliasEnv.js';

describe('applyClaudeModelAliasEnv', () => {
  it('pins every CLI model-alias slot to the session model', () => {
    const env: Record<string, string | undefined> = {};
    applyClaudeModelAliasEnv(env, 'glm-5.3-flash');

    expect(CLAUDE_MODEL_ALIAS_ENV_KEYS.length).toBeGreaterThan(0);
    for (const key of CLAUDE_MODEL_ALIAS_ENV_KEYS) {
      expect(env[key]).toBe('glm-5.3-flash');
    }
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('glm-5.3-flash');
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('glm-5.3-flash');
  });

  it('buildClaudeModelAliasEnv returns a copy for settings.env injection', () => {
    expect(buildClaudeModelAliasEnv('glm-5.3-flash[1m]')).toEqual({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3-flash[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3-flash[1m]',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'glm-5.3-flash[1m]',
      ANTHROPIC_SMALL_FAST_MODEL: 'glm-5.3-flash[1m]',
      CLAUDE_CODE_SUBAGENT_MODEL: 'glm-5.3-flash[1m]',
    });
  });

  it('overrides user-provided ANTHROPIC_DEFAULT_* mappings', () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-3-5-haiku-20241022',
      ANTHROPIC_SMALL_FAST_MODEL: 'claude-3-5-haiku-20241022',
      CLAUDE_CODE_SUBAGENT_MODEL: 'glm-5.2[1M]',
    };
    applyClaudeModelAliasEnv(env, 'glm-5.3-flash');

    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5.3-flash');
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('glm-5.3-flash');
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('glm-5.3-flash');
  });

  it('wipeClaudeModelAliasEnv clears role and subagent slots', () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2[1M]',
      CLAUDE_CODE_SUBAGENT_MODEL: 'glm-5.2[1M]',
      ANTHROPIC_API_KEY: 'keep',
    };
    wipeClaudeModelAliasEnv(env);

    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('');
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('');
    expect(env.ANTHROPIC_API_KEY).toBe('keep');
  });

  it('does nothing without a session model', () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'keep' };
    applyClaudeModelAliasEnv(env, undefined);

    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('keep');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
  });
});

describe('wipeClaudeContextEnv', () => {
  it('clears context/compaction env keys that cap the session window', () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '272000',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '200000',
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
      ANTHROPIC_API_KEY: 'keep',
    };
    wipeClaudeContextEnv(env);

    for (const key of CLAUDE_CONTEXT_ENV_KEYS) {
      expect(env[key]).toBe('');
    }
    expect(env.ANTHROPIC_API_KEY).toBe('keep');
  });

  it('buildClaudeContextEnvWipe returns the wipe as a settings.env object', () => {
    expect(buildClaudeContextEnvWipe()).toEqual({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '',
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '',
    });
  });
});
