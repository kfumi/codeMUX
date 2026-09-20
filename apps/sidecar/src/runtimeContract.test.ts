import { describe, it, expect } from 'vitest';
import {
  isProvider,
  providerCliCommand,
  providerLabel,
  validateProviderRuntimeRef,
  type ProviderRuntimeRef,
} from './runtimeContract.js';

describe('runtimeContract', () => {
  describe('providerLabel', () => {
    it('maps each provider to its display name', () => {
      expect(providerLabel('claude_code')).toBe('Claude Code');
      expect(providerLabel('codex')).toBe('Codex');
      expect(providerLabel('opencode')).toBe('OpenCode');
    });
  });

  describe('providerCliCommand', () => {
    it('maps each provider to its global CLI command name', () => {
      expect(providerCliCommand('claude_code')).toBe('claude');
      expect(providerCliCommand('codex')).toBe('codex');
      expect(providerCliCommand('opencode')).toBe('opencode');
    });
  });

  describe('isProvider', () => {
    it('accepts the three known providers', () => {
      expect(isProvider('claude_code')).toBe(true);
      expect(isProvider('codex')).toBe(true);
      expect(isProvider('opencode')).toBe(true);
    });

    it('rejects unknown values', () => {
      expect(isProvider('unknown')).toBe(false);
      expect(isProvider('')).toBe(false);
      expect(isProvider(null)).toBe(false);
      expect(isProvider(undefined)).toBe(false);
      expect(isProvider(123)).toBe(false);
    });
  });

  describe('validateProviderRuntimeRef', () => {
    const validRef: ProviderRuntimeRef = {
      provider: 'claude_code',
      runtimeRoot: 'C:\\Users\\test\\AppData\\Local\\CodeMUX\\runtimes',
      runtimePath: 'C:\\Users\\test\\AppData\\Local\\CodeMUX\\runtimes\\claude_code\\0.3.169',
      runtimeVersion: '0.3.169',
    };

    it('returns null for a well-formed ref', () => {
      expect(validateProviderRuntimeRef(validRef)).toBeNull();
    });

    it('accepts paths containing spaces', () => {
      const ref: ProviderRuntimeRef = {
        ...validRef,
        runtimePath: 'C:\\Users\\My User\\AppData\\Local\\CodeMUX\\runtimes\\claude_code\\0.3.169',
      };
      expect(validateProviderRuntimeRef(ref)).toBeNull();
    });

    it('accepts paths containing non-ASCII characters', () => {
      const ref: ProviderRuntimeRef = {
        ...validRef,
        runtimePath: 'C:\\Users\\测试用户\\CodeMUX\\runtimes\\claude_code\\0.3.169',
      };
      expect(validateProviderRuntimeRef(ref)).toBeNull();
    });

    it('returns integrity error when runtimePath is empty', () => {
      const ref: ProviderRuntimeRef = { ...validRef, runtimePath: '  ' };
      const err = validateProviderRuntimeRef(ref);
      expect(err).not.toBeNull();
      expect(err!.kind).toBe('integrity_failed');
      expect(err!.provider).toBe('claude_code');
      expect(err!.recoverable).toBe(false);
    });

    it('returns integrity error when runtimeVersion is empty', () => {
      const ref: ProviderRuntimeRef = { ...validRef, runtimeVersion: '' };
      const err = validateProviderRuntimeRef(ref);
      expect(err).not.toBeNull();
      expect(err!.kind).toBe('integrity_failed');
    });
  });
});
