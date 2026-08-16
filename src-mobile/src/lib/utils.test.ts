import { describe, expect, it } from 'vitest';

import { cn, createId, suggestDeviceName } from './utils';

describe('cn', () => {
  it('merges class names', () => {
    expect(cn('px-2', false && 'hidden', 'py-1')).toBe('px-2 py-1');
  });
});

describe('createId', () => {
  it('returns a uuid-like string when randomUUID is unavailable', () => {
    const original = globalThis.crypto?.randomUUID;
    Object.defineProperty(globalThis, 'crypto', {
      value: {},
      configurable: true,
    });
    expect(createId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    if (original) {
      Object.defineProperty(globalThis, 'crypto', {
        value: { randomUUID: original },
        configurable: true,
      });
    }
  });
});

describe('suggestDeviceName', () => {
  it('detects iPhone and Safari', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    expect(suggestDeviceName(ua)).toBe('iPhone · Safari');
  });

  it('detects Android model and Chrome', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36';
    expect(suggestDeviceName(ua)).toBe('Pixel 7 · Chrome');
  });
});
