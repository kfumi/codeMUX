import { describe, expect, it } from 'vitest';
import { resolveClaudeExecutable } from './claudeExecutable.js';

describe('Claude executable resolution', () => {
  it('does not use a PATH Claude executable without a managed runtime', () => {
    expect(resolveClaudeExecutable({
      platform: 'win32',
      fileExists: () => true,
    })).toBeUndefined();
  });
});
