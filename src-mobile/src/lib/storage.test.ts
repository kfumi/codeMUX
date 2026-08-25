// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  maxEventSequence,
  minEventSequence,
} from './storage';

describe('timeline cache helpers', () => {
  it('computes min and max event sequence', () => {
    const events = [{ sequence: 4 }, { sequence: 1 }, { sequence: 9 }];
    expect(minEventSequence(events)).toBe(1);
    expect(maxEventSequence(events)).toBe(9);
  });
});
