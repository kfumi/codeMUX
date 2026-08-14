import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildMcpInstructions,
  getProviderMode,
  shouldUseCodexChatCompatProxy,
} from '../src-tauri/sidecar/src/sessionRuntimeHelpers';
import { getRuntimeFlavor } from '../src-tauri/sidecar/src/runtimeEvents';

describe('getProviderMode', () => {
  it('treats the default Anthropic endpoint as deferred-capable', () => {
    expect(getProviderMode(undefined)).toEqual({
      providerMode: 'anthropic',
      supportsDeferredToolSearch: true,
    });

    expect(getProviderMode('https://api.anthropic.com')).toEqual({
      providerMode: 'anthropic',
      supportsDeferredToolSearch: true,
    });
  });

  it('treats custom base urls as limited-provider mode', () => {
    expect(getProviderMode('https://example-proxy.internal/anthropic')).toEqual({
      providerMode: 'custom',
      supportsDeferredToolSearch: false,
    });
  });
});

describe('buildMcpInstructions', () => {
  it('returns undefined — probe-derived MCP instructions are no longer injected', () => {
    expect(buildMcpInstructions()).toBeUndefined();
  });
});

describe('shouldUseCodexChatCompatProxy', () => {
  it('keeps direct Responses mode for official OpenAI-compatible endpoints', () => {
    expect(shouldUseCodexChatCompatProxy('https://api.deepseek.com')).toBe(false);
    expect(shouldUseCodexChatCompatProxy('https://token-plan-cn.xiaomimimo.com/v1')).toBe(true);
    expect(shouldUseCodexChatCompatProxy('https://openrouter.ai/api/v1')).toBe(true);
  });

  it('keeps direct Responses mode for the official OpenAI endpoint', () => {
    expect(shouldUseCodexChatCompatProxy(undefined)).toBe(false);
    expect(shouldUseCodexChatCompatProxy('https://api.openai.com/v1')).toBe(false);
    expect(shouldUseCodexChatCompatProxy('https://api.openai.com')).toBe(false);
  });

  it('honors an explicit provider proxy override', () => {
    expect(shouldUseCodexChatCompatProxy('https://openrouter.ai/api/v1', false)).toBe(false);
    expect(shouldUseCodexChatCompatProxy('https://api.openai.com/v1', true)).toBe(true);
  });
});

describe('getRuntimeFlavor', () => {
  it('routes Claude and Codex to different runtime flavors', () => {
    expect(getRuntimeFlavor('claude_code')).toBe('claude');
    expect(getRuntimeFlavor('codex')).toBe('codex');
  });

  it('defaults to Claude for unknown or missing agent kinds', () => {
    expect(getRuntimeFlavor(undefined)).toBe('claude');
    expect(getRuntimeFlavor('gemini_cli')).toBe('claude');
    expect(getRuntimeFlavor('')).toBe('claude');
  });
});

describe('legacy Claude context display channel', () => {
  it('does not keep legacy Claude context display probes in sidecar runtime', () => {
    const sidecarDir = join(process.cwd(), 'src-tauri', 'sidecar', 'src');
    const index = readFileSync(join(sidecarDir, 'index.ts'), 'utf8');
    const runtimeEvents = readFileSync(join(sidecarDir, 'runtimeEvents.ts'), 'utf8');

    expect(index).not.toContain('fetchClaudeContextCommandUsageSnapshot');
    expect(index).not.toContain('buildClaudeTokenUsageUpdateEvent');
    expect(runtimeEvents).not.toContain('buildClaudeTokenUsageUpdateEvent');
    expect(runtimeEvents).not.toContain('extractClaudeContextUsageSnapshot');
  });
});
