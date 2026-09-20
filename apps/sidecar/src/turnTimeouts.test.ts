import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_IDLE_TIMEOUT_MS, resolveTurnTimeouts } from './turnTimeouts.js';

const ENV_VARS = ['CODEMUX_IDLE_TIMEOUT_MS', 'CODEMUX_APPROVAL_TIMEOUT_MS', 'CODEMUX_QUESTION_TIMEOUT_MS'];

describe('resolveTurnTimeouts', () => {
  beforeEach(() => {
    for (const name of ENV_VARS) delete process.env[name];
  });
  afterEach(() => {
    for (const name of ENV_VARS) delete process.env[name];
  });

  it('applies defaults when nothing is configured', () => {
    expect(resolveTurnTimeouts(undefined)).toEqual({
      idle_timeout_ms: DEFAULT_IDLE_TIMEOUT_MS,
      approval_timeout_ms: 0,
      question_timeout_ms: 0,
    });
  });

  it('prefers the configured value over env and defaults', () => {
    process.env.CODEMUX_IDLE_TIMEOUT_MS = '60000';
    expect(resolveTurnTimeouts({ idle_timeout_ms: 120_000 })).toMatchObject({
      idle_timeout_ms: 120_000,
    });
  });

  it('falls back to env when not configured on the command', () => {
    process.env.CODEMUX_IDLE_TIMEOUT_MS = '60000';
    process.env.CODEMUX_APPROVAL_TIMEOUT_MS = '15000';
    expect(resolveTurnTimeouts(undefined)).toEqual({
      idle_timeout_ms: 60_000,
      approval_timeout_ms: 15_000,
      question_timeout_ms: 0,
    });
  });

  it('keeps 0 (disabled / infinite wait) as an explicit value', () => {
    expect(resolveTurnTimeouts({ idle_timeout_ms: 0, approval_timeout_ms: 0, question_timeout_ms: 0 })).toEqual({
      idle_timeout_ms: 0,
      approval_timeout_ms: 0,
      question_timeout_ms: 0,
    });
  });

  it('ignores invalid env values', () => {
    process.env.CODEMUX_IDLE_TIMEOUT_MS = 'not-a-number';
    process.env.CODEMUX_APPROVAL_TIMEOUT_MS = '-5';
    process.env.CODEMUX_QUESTION_TIMEOUT_MS = '1.5';
    expect(resolveTurnTimeouts(undefined)).toEqual({
      idle_timeout_ms: DEFAULT_IDLE_TIMEOUT_MS,
      approval_timeout_ms: 0,
      question_timeout_ms: 0,
    });
  });
});
