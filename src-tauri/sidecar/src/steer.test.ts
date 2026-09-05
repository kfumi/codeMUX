import { describe, expect, it } from 'vitest';

import { isSteerBlockedPrompt, isSteerUnavailableError, SteerUnavailableError } from './steer.js';

describe('steer helpers', () => {
  it('blocks slash commands', () => {
    expect(isSteerBlockedPrompt('/compact')).toBe(true);
    expect(isSteerBlockedPrompt('continue')).toBe(false);
  });

  it('recognizes SteerUnavailableError by instance and name', () => {
    expect(isSteerUnavailableError(new SteerUnavailableError('no turn'))).toBe(true);
    const named = new Error('no turn');
    named.name = 'SteerUnavailableError';
    expect(isSteerUnavailableError(named)).toBe(true);
    expect(isSteerUnavailableError(new Error('boom'))).toBe(false);
  });
});
