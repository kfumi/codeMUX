import { describe, expect, it } from 'vitest';

import { resolveMobileRunningState } from './runtimeState';

describe('resolveMobileRunningState', () => {
  it('does not infer running from historical conversation events', () => {
    expect(resolveMobileRunningState({
      sending: false,
      desktopRunning: false,
    })).toBe(false);
  });

  it('keeps the composer busy while a message is being sent', () => {
    expect(resolveMobileRunningState({
      sending: true,
      desktopRunning: false,
    })).toBe(true);
  });

  it('reflects the desktop companion runtime state', () => {
    expect(resolveMobileRunningState({
      sending: false,
      desktopRunning: true,
    })).toBe(true);
  });
});
