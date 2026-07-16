import { describe, expect, it } from 'vitest';
import {
  extractCodexBaseUrl,
  extractCodexModelName,
  generateCodexDefaultConfigToml,
  setCodexBaseUrl,
  setCodexModelName,
} from './codexTomlUtils';

describe('codexTomlUtils', () => {
  describe('extractCodexBaseUrl', () => {
    it('returns null for empty input', () => {
      expect(extractCodexBaseUrl('')).toBeNull();
      expect(extractCodexBaseUrl('   ')).toBeNull();
    });

    it('extracts base_url from top-level', () => {
      const toml = `model_provider = "custom"\nbase_url = "https://api.example.com/v1"\n`;
      expect(extractCodexBaseUrl(toml)).toBe('https://api.example.com/v1');
    });

    it('returns null when no base_url present', () => {
      const toml = `model_provider = "custom"\nmodel = "gpt-5.5"\n`;
      expect(extractCodexBaseUrl(toml)).toBeNull();
    });
  });

  describe('setCodexBaseUrl', () => {
    it('inserts base_url when none exists', () => {
      const toml = `model_provider = "custom"\nmodel = "gpt-5.5"\n`;
      const result = setCodexBaseUrl(toml, 'https://api.example.com/v1');
      expect(result).toContain('base_url = "https://api.example.com/v1"');
    });

    it('updates existing base_url', () => {
      const toml = `model_provider = "custom"\nbase_url = "https://old.com"\n`;
      const result = setCodexBaseUrl(toml, 'https://new.com');
      expect(result).toContain('base_url = "https://new.com"');
      expect(result).not.toContain('old.com');
    });

    it('removes base_url when empty string provided', () => {
      const toml = `model_provider = "custom"\nbase_url = "https://api.example.com"\n`;
      const result = setCodexBaseUrl(toml, '');
      expect(result).not.toContain('base_url');
    });

    it('handles empty configToml input', () => {
      const result = setCodexBaseUrl('', 'https://api.example.com');
      expect(result).toContain('base_url = "https://api.example.com"');
    });
  });

  describe('extractCodexModelName', () => {
    it('returns null for empty input', () => {
      expect(extractCodexModelName('')).toBeNull();
    });

    it('extracts model name', () => {
      const toml = `model = "gpt-5.5"\nmodel_provider = "custom"\n`;
      expect(extractCodexModelName(toml)).toBe('gpt-5.5');
    });

    it('returns null when no model present', () => {
      const toml = `model_provider = "custom"\n`;
      expect(extractCodexModelName(toml)).toBeNull();
    });
  });

  describe('setCodexModelName', () => {
    it('inserts model when none exists', () => {
      const toml = `model_provider = "custom"\n`;
      const result = setCodexModelName(toml, 'gpt-5.5');
      expect(result).toContain('model = "gpt-5.5"');
    });

    it('updates existing model', () => {
      const toml = `model = "gpt-4"\nmodel_provider = "custom"\n`;
      const result = setCodexModelName(toml, 'gpt-5.5');
      expect(result).toContain('model = "gpt-5.5"');
      expect(result).not.toContain('gpt-4');
    });
  });

  describe('generateCodexDefaultConfigToml', () => {
    it('generates default config with all required fields', () => {
      const result = generateCodexDefaultConfigToml();
      expect(result).toContain('model_provider = "custom"');
      expect(result).toContain('model = "gpt-5.6"');
      expect(result).toContain('model_reasoning_effort = "high"');
      expect(result).toContain('disable_response_storage = true');
      expect(result).toContain('[model_providers.custom]');
      expect(result).toContain('wire_api = "responses"');
      expect(result).toContain('requires_openai_auth = true');
      expect(result).toContain('base_url = ""');
    });

    it('includes base_url when provided', () => {
      const result = generateCodexDefaultConfigToml('https://api.example.com/v1');
      expect(result).toContain('base_url = "https://api.example.com/v1"');
    });

    it('uses custom model when provided', () => {
      const result = generateCodexDefaultConfigToml(undefined, 'gpt-4');
      expect(result).toContain('model = "gpt-4"');
    });
  });
});
