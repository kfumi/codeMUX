import { describe, expect, it } from 'vitest';

import {
  COMPUTER_USE_MAX_STEPS,
  formatAllowlistInput,
  normalizeComputerUse,
  parseAllowlistInput,
} from './computerUseSettings';

describe('normalizeComputerUse', () => {
  it('defaults to everything off (首次打开就是零风险)', () => {
    expect(normalizeComputerUse(undefined)).toEqual({
      enabled: false,
      system_execution_enabled: false,
      allowlist: [],
      max_steps: 40,
      driver_command: null,
      driver_args: [],
      driver_update_command: null,
    });
  });

  it('keeps configured values and falls back per field', () => {
    const settings = normalizeComputerUse({
      enabled: true,
      allowlist: ['Notepad'],
      max_steps: 12,
      driver_command: 'cua-driver',
    });
    expect(settings.enabled).toBe(true);
    expect(settings.system_execution_enabled).toBe(false);
    expect(settings.allowlist).toEqual(['Notepad']);
    expect(settings.max_steps).toBe(12);
    expect(settings.driver_command).toBe('cua-driver');
  });

  it('clamps the step budget into the daemon-accepted range', () => {
    expect(normalizeComputerUse({ max_steps: 0 }).max_steps).toBe(1);
    expect(normalizeComputerUse({ max_steps: 9999 }).max_steps).toBe(COMPUTER_USE_MAX_STEPS);
    expect(normalizeComputerUse({ max_steps: 7.4 }).max_steps).toBe(7);
    expect(normalizeComputerUse({ max_steps: Number.NaN }).max_steps).toBe(40);
  });

  it('drops non-string allowlist entries from a malformed config', () => {
    const settings = normalizeComputerUse({
      allowlist: ['Notepad', 42 as unknown as string, null as unknown as string],
    });
    expect(settings.allowlist).toEqual(['Notepad']);
  });
});

describe('allowlist input round trip', () => {
  it('parses one app per line, trimming blanks', () => {
    expect(parseAllowlistInput('  记事本 \n\n  Excel  \n')).toEqual(['记事本', 'Excel']);
    expect(parseAllowlistInput('   ')).toEqual([]);
  });

  it('formats back to one entry per line', () => {
    expect(formatAllowlistInput(['记事本', 'Excel'])).toBe('记事本\nExcel');
    expect(formatAllowlistInput(undefined)).toBe('');
  });
});
